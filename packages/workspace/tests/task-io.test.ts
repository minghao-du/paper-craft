/**
 * Tests for Workspace Task-IO and CLI integration.
 *
 * Implements Section 7, 8, 13.2 of WORKSPACE_TYPESCRIPT_REFACTOR_PLAN.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWriteText,
  mapCleanupResultToExternalReport,
  mapPreparedWorkspaceToResult,
  mapToCleanupRequest,
  mapToPrepareRequest,
  normalizeIssue,
  loadEnvelope,
  WorkspaceTaskInput,
} from '../src/task-io.js';
import { loadEnvelope as loadOrchestratorEnvelope } from '../../orchestrator/src/lifecycle/envelope.js';
import { resolvePath } from '../src/git.js';
import { CleanupResult, PreparedWorkspace, WorkspaceError } from '../src/types.js';

describe('Workspace Task-IO', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-task-io-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('normalizes issue identifiers from various formats', () => {
    expect(normalizeIssue(79)).toBe(79);
    expect(normalizeIssue('79')).toBe(79);
    expect(normalizeIssue('#79')).toBe(79);
    expect(normalizeIssue('issue-79')).toBe(79);
    expect(normalizeIssue('#issue-79')).toBe(79);
    expect(normalizeIssue('invalid')).toBeNull();
    expect(normalizeIssue(-5)).toBeNull();
  });

  it('atomically writes text with fsync and directory creation', () => {
    const targetFile = path.join(tmpDir, 'nested/dir/test.txt');
    atomicWriteText(targetFile, 'Hello, atomic world!');
    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('Hello, atomic world!\n');
  });

  it('maps envelope to PrepareRequest with correct conflict checks', () => {
    const envelope: WorkspaceTaskInput = {
      schema_version: '1.0',
      task: {
        logical_stage: 'workspace_prepare',
        current_issue_id: 'issue-42',
        root_issue_id: '42',
        attempt: 1,
      },
      environment: {
        working_directory: tmpDir,
        repository: 'owner/repo',
        base_branch: 'main',
        branch: 'issue-42',
      },
      contract: {
        receipt_path: path.join(tmpDir, 'receipt.md'),
      },
    };

    const { request, receiptPath, outputFormat } = mapToPrepareRequest(
      { repoDir: tmpDir },
      envelope,
    );

    expect(request.target.kind).toBe('issue');
    if (request.target.kind === 'issue') {
      expect(request.target.issue).toBe(42);
      expect(request.target.branch).toBe('issue-42');
    }
    expect(receiptPath).toBe(resolvePath(path.join(tmpDir, 'receipt.md')));
    expect(outputFormat).toBe('compact');

    // Conflicting issue should throw
    expect(() =>
      mapToPrepareRequest({ repoDir: tmpDir, issue: 99 }, envelope),
    ).toThrow(/Conflicting issue/);
  });

  it('maps envelope branch + commit to branch with expectedHead', () => {
    const envelope: WorkspaceTaskInput = {
      task: { current_issue_id: 10 },
      environment: {
        working_directory: tmpDir,
        branch: 'feature-10',
        commit: '1111222233334444555566667777888899990000',
      },
    };

    const { request } = mapToPrepareRequest({ repoDir: tmpDir }, envelope);
    expect(request.target.kind).toBe('issue');
    if (request.target.kind === 'issue') {
      expect(request.target.branch).toBe('feature-10');
      expect(request.target.expectedHead).toBe(
        '1111222233334444555566667777888899990000',
      );
    }
  });

  it('maps envelope to CleanupRequest with candidates and unresolved items', () => {
    const envelope: WorkspaceTaskInput = {
      task: {
        root_issue_id: '50',
      },
      inputs: {
        parameters: {
          candidates: [
            {
              worktree: path.join(tmpDir, 'issue-50'),
              branch: 'issue-50',
              commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              created: true,
              consumers_finished: true,
              pr: 123,
            },
          ],
          unresolved: ['dirty branch issue-51'],
        },
      },
      contract: {
        receipt_path: path.join(tmpDir, 'cleanup-receipt.md'),
      },
    };

    const { request } = mapToCleanupRequest(envelope, { repoDir: tmpDir });
    expect(request.rootIssueId).toBe('50');
    expect(request.candidates.length).toBe(1);
    const c0 = request.candidates[0];
    expect(c0.kind).toBe('task_branch');
    if (c0.kind === 'task_branch') {
      expect(c0.created).toBe(true);
      expect(c0.consumersFinished).toBe(true);
    }
    expect(request.unresolved).toEqual(['dirty branch issue-51']);
    expect(request.protectedPaths).toContain(resolvePath(path.join(tmpDir, 'cleanup-receipt.md')));
  });

  it('strictly parses candidate boolean flags and rejects truthiness / string booleans', () => {
    const baseEnvelope = (candidateOverrides: Record<string, unknown>): WorkspaceTaskInput => ({
      task: { root_issue_id: '60' },
      inputs: {
        parameters: {
          candidates: [
            {
              branch: 'issue-60',
              commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              ...candidateOverrides,
            },
          ],
        },
      },
    });

    // Valid strict boolean flags
    const valid = mapToCleanupRequest(
      baseEnvelope({ created: true, consumers_finished: false }),
      { repoDir: tmpDir },
    );
    const v0 = valid.request.candidates[0];
    expect(v0.kind).toBe('task_branch');
    if (v0.kind === 'task_branch') {
      expect(v0.created).toBe(true);
      expect(v0.consumersFinished).toBe(false);
    }

    // Omitted flags remain undefined (not confirmed)
    const omitted = mapToCleanupRequest(baseEnvelope({}), { repoDir: tmpDir });
    const o0 = omitted.request.candidates[0];
    expect(o0.kind).toBe('task_branch');
    if (o0.kind === 'task_branch') {
      expect(o0.created).toBeUndefined();
      expect(o0.consumersFinished).toBeUndefined();
    }

    // String "false" must NOT be converted by truthiness; must be rejected
    expect(() =>
      mapToCleanupRequest(baseEnvelope({ created: 'false' }), { repoDir: tmpDir }),
    ).toThrowError(WorkspaceError);

    // String "true" must be rejected
    expect(() =>
      mapToCleanupRequest(baseEnvelope({ consumers_finished: 'true' }), { repoDir: tmpDir }),
    ).toThrowError(WorkspaceError);

    // Number must be rejected
    expect(() =>
      mapToCleanupRequest(baseEnvelope({ created: 1 }), { repoDir: tmpDir }),
    ).toThrowError(WorkspaceError);

    // Null must be rejected
    expect(() =>
      mapToCleanupRequest(baseEnvelope({ consumers_finished: null }), { repoDir: tmpDir }),
    ).toThrowError(WorkspaceError);
  });

  it('normalizes candidate kind from transport and rejects contradictory or unclassifiable entries', () => {
    // 1. Branch-only without kind -> inferred task_branch (worktree omitted)
    const branchOnlyEnv: WorkspaceTaskInput = {
      task: { root_issue_id: '61' },
      inputs: {
        parameters: {
          candidates: [{ branch: 'feature-61', created: true }],
        },
      },
    };
    const branchOnly = mapToCleanupRequest(branchOnlyEnv, { repoDir: tmpDir });
    expect(branchOnly.request.candidates[0].kind).toBe('task_branch');
    expect(branchOnly.request.candidates[0].worktree).toBeUndefined();

    // 2. Worktree + commit without branch -> inferred detached
    const detachedEnv: WorkspaceTaskInput = {
      task: { root_issue_id: '61' },
      inputs: {
        parameters: {
          candidates: [
            {
              worktree: path.join(tmpDir, 'detached'),
              commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              verification_completed: true,
            },
          ],
        },
      },
    };
    const detached = mapToCleanupRequest(detachedEnv, { repoDir: tmpDir });
    expect(detached.request.candidates[0].kind).toBe('detached');
    if (detached.request.candidates[0].kind === 'detached') {
      expect(detached.request.candidates[0].verificationCompleted).toBe(true);
    }

    // 3. Contradictory: kind 'detached' with branch -> reject
    const contradictDetached: WorkspaceTaskInput = {
      task: { root_issue_id: '61' },
      inputs: {
        parameters: {
          candidates: [
            {
              kind: 'detached',
              worktree: path.join(tmpDir, 'detached'),
              commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              branch: 'should-not-be-here',
            },
          ],
        },
      },
    };
    expect(() => mapToCleanupRequest(contradictDetached, { repoDir: tmpDir })).toThrowError(
      WorkspaceError,
    );

    // 4. Contradictory: task_branch with verification_completed -> reject
    const contradictTaskBranch: WorkspaceTaskInput = {
      task: { root_issue_id: '61' },
      inputs: {
        parameters: {
          candidates: [
            {
              kind: 'task_branch',
              branch: 'feature-61',
              verification_completed: true,
            },
          ],
        },
      },
    };
    expect(() => mapToCleanupRequest(contradictTaskBranch, { repoDir: tmpDir })).toThrowError(
      WorkspaceError,
    );

    // 5. Unclassifiable entry: only worktree without branch or commit -> reject
    const unclassifiable: WorkspaceTaskInput = {
      task: { root_issue_id: '61' },
      inputs: {
        parameters: {
          candidates: [{ worktree: path.join(tmpDir, 'alone') }],
        },
      },
    };
    expect(() => mapToCleanupRequest(unclassifiable, { repoDir: tmpDir })).toThrowError(
      WorkspaceError,
    );
  });

  it('validates candidate list up-front so a malformed second entry aborts before returning', () => {
    const mixedEnv: WorkspaceTaskInput = {
      task: { root_issue_id: '62' },
      inputs: {
        parameters: {
          candidates: [
            // Candidate 0: valid
            {
              branch: 'valid-branch',
              created: true,
              consumers_finished: true,
            },
            // Candidate 1: malformed boolean flag
            {
              branch: 'bad-branch',
              created: 'false',
            },
          ],
        },
      },
    };

    expect(() => mapToCleanupRequest(mixedEnv, { repoDir: tmpDir })).toThrowError(
      /Candidate at index 1 field 'created' must be a boolean/,
    );
  });

  it('accepts incomplete ownership evidence for downstream retention, but rejects non-object evidence', () => {
    // Incomplete evidence ({}) is structurally valid; downstream cleanup retains it
    const incompleteEnv: WorkspaceTaskInput = {
      task: { root_issue_id: '63' },
      inputs: {
        parameters: {
          candidates: [
            {
              branch: 'feature-63',
              created: false,
              ownership_evidence: {},
            },
          ],
        },
      },
    };
    const res = mapToCleanupRequest(incompleteEnv, { repoDir: tmpDir });
    expect(res.request.candidates[0].ownershipEvidence).toEqual({});

    // Non-object evidence is malformed input
    const badEvidenceEnv: WorkspaceTaskInput = {
      task: { root_issue_id: '63' },
      inputs: {
        parameters: {
          candidates: [
            {
              branch: 'feature-63',
              ownership_evidence: 'string-is-invalid',
            },
          ],
        },
      },
    };
    expect(() => mapToCleanupRequest(badEvidenceEnv, { repoDir: tmpDir })).toThrowError(
      WorkspaceError,
    );
  });

  it('workspace and orchestrator accept/reject the same complete envelope', () => {
    const complete = {
      schema_version: '1.0',
      task: { logical_stage: 'workspace_prepare', step_index: 1, attempt: 1, root_issue_id: '42', current_issue_id: '42' },
      provider: { type: 'skill', target: 'pc-workspace' },
      environment: { working_directory: tmpDir },
      inputs: { objective: 'Prepare worktree' },
      contract: { receipt_path: path.join(tmpDir, 'r.md') },
      budgets: {},
    };
    const good = path.join(tmpDir, 'good.json');
    const bad = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(good, JSON.stringify(complete));
    fs.writeFileSync(bad, JSON.stringify({ ...complete, schema_version: '2.0' }));

    expect(loadEnvelope(good)).toEqual(loadOrchestratorEnvelope(good));
    expect(() => loadOrchestratorEnvelope(bad)).toThrow(/schema_version/);
    expect(() => loadEnvelope(bad)).toThrow(/schema_version/);
  });

  it('maps PreparedWorkspace to external result format', () => {
    const prepared: PreparedWorkspace = {
      repository: 'owner/repo',
      deliveryTarget: 'owner/repo',
      sourceCheckout: '/repo',
      path: '/repo-worktrees/issue-1',
      branch: 'issue-1',
      commit: 'abc1234',
      baseBranch: 'main',
      baseRemote: 'origin',
      pushRemote: 'origin',
      disposition: 'created',
    };

    const result = mapPreparedWorkspaceToResult(prepared);
    expect(result).toEqual({
      repository: 'owner/repo',
      delivery_target: 'owner/repo',
      base_remote: 'origin',
      push_remote: 'origin',
      working_directory: '/repo-worktrees/issue-1',
      worktree: '/repo-worktrees/issue-1',
      branch: 'issue-1',
      baseBranch: 'main',
      commit: 'abc1234',
      created: true,
    });
  });

  it('maps CleanupResult to external 4-list contract format', () => {
    const internalResult: CleanupResult = {
      outcome: 'incomplete',
      candidates: [
        {
          candidate: {
            kind: 'task_branch',
            worktree: '/worktrees/issue-1',
            branch: 'issue-1',
            pushRemote: 'origin',
          },
          worktree: { status: 'removed' },
          remoteBranch: { status: 'already_absent' },
          localBranch: { status: 'retained', reason: 'Checked out elsewhere' },
        },
      ],
      unresolved: ['untracked-worktree-x'],
    };

    const external = mapCleanupResultToExternalReport(internalResult);
    expect(external.outcome).toBe('incomplete');
    expect(external.removed_paths).toEqual(['/worktrees/issue-1']);
    expect(external.retained_paths).toEqual([]);
    expect(external.removed_branches).toEqual([
      {
        branch: 'issue-1',
        remote: 'origin',
        scope: 'remote',
        already_absent: true,
      },
    ]);
    expect(external.retained_branches).toEqual([
      { branch: 'issue-1', reason: 'Checked out elsewhere' },
      { branch: null, reason: 'untracked-worktree-x' },
    ]);
  });
});
