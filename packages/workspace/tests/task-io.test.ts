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
  buildCleanupReceiptArtifacts,
  buildMarkdownReceipt,
  buildPrepareReceiptArtifacts,
  formatPrepareSummary,
  mapCleanupResultToExternalReport,
  mapPreparedWorkspaceToResult,
  mapToCleanupRequest,
  mapToPrepareRequest,
  normalizeIssue,
  loadEnvelope,
  resolvePrepareIssueIds,
  WorkspaceTaskInput,
} from '../src/task-io.js';
import { loadEnvelope as loadOrchestratorEnvelope } from '../../orchestrator/src/run-operations/envelope.js';
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

  it('maps envelope branch + commit to branch with expectedHead even when repeated via CLI or without issue', () => {
    const sha = '1111222233334444555566667777888899990000';
    const issueEnvelope: WorkspaceTaskInput = {
      task: { current_issue_id: 10 },
      environment: {
        working_directory: tmpDir,
        branch: 'feature-10',
        commit: sha,
      },
    };

    const baseline = mapToPrepareRequest({ repoDir: tmpDir }, issueEnvelope);
    const repeated = mapToPrepareRequest(
      { repoDir: tmpDir, branch: 'feature-10', commit: sha },
      issueEnvelope,
    );
    expect(baseline.request.target).toEqual({
      kind: 'issue',
      issue: 10,
      branch: 'feature-10',
      path: undefined,
      expectedHead: sha,
    });
    expect(repeated.request.target).toEqual(baseline.request.target);

    // Without issue, distinct working_directory acts as worktree deterministically
    // regardless of whether the worktree directory already exists on disk.
    const wtDir = path.join(tmpDir, 'wt-feature-10');
    const branchEnvelope: WorkspaceTaskInput = {
      environment: {
        working_directory: wtDir,
        branch: 'feature-10',
        commit: sha,
      },
    };
    const beforeCreate = mapToPrepareRequest(
      { repoDir: tmpDir, branch: 'feature-10', commit: sha },
      branchEnvelope,
    );
    fs.mkdirSync(wtDir, { recursive: true });
    const afterCreate = mapToPrepareRequest(
      { repoDir: tmpDir, branch: 'feature-10', commit: sha },
      branchEnvelope,
    );
    expect(beforeCreate.request.target).toEqual({
      kind: 'branch',
      branch: 'feature-10',
      path: resolvePath(wtDir),
      expectedHead: sha,
    });
    expect(afterCreate.request.target).toEqual(beforeCreate.request.target);
    expect(afterCreate.request.sourceCheckout).toBe(resolvePath(tmpDir));
  });

  it('supports standalone detached requests and rejects contradictory branch/detached declarations', () => {
    const sha = '1111222233334444555566667777888899990000';
    const otherSha = '2222333344445555666677778888999900001111';
    const wtDir = path.join(tmpDir, 'detached-wt');

    // Valid standalone detached target
    const detached = mapToPrepareRequest({
      repoDir: tmpDir,
      worktree: wtDir,
      commit: sha,
    });
    expect(detached.request.target).toEqual({
      kind: 'detached',
      commit: sha,
      path: resolvePath(wtDir),
    });

    const invalidCases: Array<[string, Parameters<typeof mapToPrepareRequest>[0], WorkspaceTaskInput?]> = [
      ['standalone --branch + --commit', { repoDir: tmpDir, worktree: wtDir, branch: 'feat', commit: sha }],
      ['standalone --issue + --commit', { repoDir: tmpDir, worktree: wtDir, issue: 10, commit: sha }],
      [
        'env branch === null + --branch',
        { repoDir: tmpDir, worktree: wtDir, branch: 'feat' },
        { environment: { working_directory: wtDir, branch: null, commit: sha } },
      ],
      [
        'env branch without env commit + --commit',
        { repoDir: tmpDir, worktree: wtDir, commit: sha },
        { environment: { working_directory: wtDir, branch: 'feat' } },
      ],
      [
        'env branch + commit conflicting with expectedHead',
        { repoDir: tmpDir, expectedHead: otherSha },
        { task: { current_issue_id: 10 }, environment: { working_directory: tmpDir, branch: 'feat', commit: sha } },
      ],
      [
        'standalone commit conflicting with expectedHead',
        { repoDir: tmpDir, worktree: wtDir, commit: sha, expectedHead: otherSha },
      ],
    ];

    for (const [label, args, env] of invalidCases) {
      try {
        mapToPrepareRequest(args, env);
        expect.unreachable(`Expected INVALID_INPUT for ${label}`);
      } catch (err) {
        expect(err, label).toBeInstanceOf(WorkspaceError);
        expect((err as WorkspaceError).code, label).toBe('INVALID_INPUT');
      }
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

  it('maps PreparedWorkspace to external result format with outcome', () => {
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

    expect(mapPreparedWorkspaceToResult(prepared)).toEqual({
      outcome: 'prepared',
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

    const reused: PreparedWorkspace = { ...prepared, disposition: 'reused' };
    expect(mapPreparedWorkspaceToResult(reused)).toEqual({
      outcome: 'reused',
      repository: 'owner/repo',
      delivery_target: 'owner/repo',
      base_remote: 'origin',
      push_remote: 'origin',
      working_directory: '/repo-worktrees/issue-1',
      worktree: '/repo-worktrees/issue-1',
      branch: 'issue-1',
      baseBranch: 'main',
      commit: 'abc1234',
      created: false,
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
            commit: '0123456789abcdef0123456789abcdef01234567',
            pushRemote: 'origin',
          },
          worktree: { status: 'removed' },
          remoteBranch: { status: 'already_absent' },
          localBranch: { status: 'retained', reason: 'Checked out elsewhere' },
        },
        {
          candidate: {
            kind: 'detached',
            worktree: '/worktrees/issue-1-verify',
            commit: '123456789abcdef0123456789abcdef0123456789',
            verificationCompleted: true,
          },
          worktree: { status: 'already_absent' },
        },
      ],
      unresolved: ['untracked-worktree-x'],
    };

    const external = mapCleanupResultToExternalReport(internalResult);
    expect(external.outcome).toBe('incomplete');
    expect(external.removed_paths).toEqual(['/worktrees/issue-1', '/worktrees/issue-1-verify']);
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

  it('maps orchestrator detached envelopes with issue audit metadata and primary_checkout fallback', () => {
    const sha = '1111222233334444555566667777888899990000';
    const wtDir = path.join(tmpDir, 'verify-wt');
    const secondaryDir = path.join(tmpDir, 'secondary-checkout');

    // 1. Standard orchestrator detached envelope (branch: null + commit + task issue IDs + parameters.worktree)
    const standardDetached: WorkspaceTaskInput = {
      schema_version: '1.0',
      task: {
        logical_stage: 'workspace_prepare',
        step_index: 5,
        attempt: 1,
        root_issue_id: '150',
        current_issue_id: '150',
      },
      environment: {
        working_directory: tmpDir,
        branch: null,
        commit: sha,
      },
      inputs: {
        parameters: {
          worktree: wtDir,
        },
      },
    };
    const mappedStandard = mapToPrepareRequest({}, standardDetached);
    expect(mappedStandard.request.target).toEqual({
      kind: 'detached',
      commit: sha,
      path: resolvePath(wtDir),
    });
    expect(mappedStandard.request.sourceCheckout).toBe(resolvePath(tmpDir));

    // 2. Branch omitted with only commit -> detached
    const omittedBranch: WorkspaceTaskInput = {
      task: { root_issue_id: '150', current_issue_id: '150' },
      environment: { working_directory: tmpDir, commit: sha },
      inputs: { parameters: { worktree: wtDir } },
    };
    expect(mapToPrepareRequest({}, omittedBranch).request.target).toEqual({
      kind: 'detached',
      commit: sha,
      path: resolvePath(wtDir),
    });

    // 3. Envelope branch: null, commit: null + CLI --commit -> detached
    const nullCommitCliOverride: WorkspaceTaskInput = {
      task: { root_issue_id: '150', current_issue_id: '150' },
      environment: { working_directory: tmpDir, branch: null, commit: null },
      inputs: { parameters: { worktree: wtDir } },
    };
    expect(
      mapToPrepareRequest({ commit: sha }, nullCommitCliOverride).request.target,
    ).toEqual({
      kind: 'detached',
      commit: sha,
      path: resolvePath(wtDir),
    });

    // 4. Detached without parameters.worktree uses environment.primary_checkout as sourceCheckout
    const primaryFallbackDetached: WorkspaceTaskInput = {
      task: { root_issue_id: '150', current_issue_id: '150' },
      environment: {
        primary_checkout: tmpDir,
        working_directory: wtDir,
        branch: null,
        commit: sha,
      },
    };
    const mappedFallback = mapToPrepareRequest({}, primaryFallbackDetached);
    expect(mappedFallback.request.sourceCheckout).toBe(resolvePath(tmpDir));
    expect(mappedFallback.request.target).toEqual({
      kind: 'detached',
      commit: sha,
      path: resolvePath(wtDir),
    });

    // 5. Secondary normal checkout (issue mode with primary_checkout !== working_directory) must not promote working_directory to worktree
    const secondaryIssue: WorkspaceTaskInput = {
      task: { root_issue_id: '150', current_issue_id: '150' },
      environment: {
        primary_checkout: tmpDir,
        working_directory: secondaryDir,
      },
    };
    const mappedSecondary = mapToPrepareRequest({}, secondaryIssue);
    expect(mappedSecondary.request.sourceCheckout).toBe(resolvePath(secondaryDir));
    expect(mappedSecondary.request.target).toEqual({
      kind: 'issue',
      issue: 150,
      branch: undefined,
      path: undefined,
      expectedHead: undefined,
    });

    // 6. Explicit CLI --issue alongside detached envelope still throws INVALID_INPUT
    expect(() => mapToPrepareRequest({ issue: 150 }, standardDetached)).toThrow(WorkspaceError);
    try {
      mapToPrepareRequest({ issue: 150 }, standardDetached);
      expect.unreachable('Expected INVALID_INPUT for explicit CLI issue with detached commit');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe('INVALID_INPUT');
      expect((err as WorkspaceError).message).toContain(
        'Contradictory issue and detached commit declarations',
      );
    }

    // 7. envBranch === null + CLI --branch message only labels (detached) when envCommit is present
    expect(() =>
      mapToPrepareRequest(
        { branch: 'feat' },
        { environment: { working_directory: tmpDir, branch: null } },
      ),
    ).toThrow(/envelope specified null\.$/);
    expect(() =>
      mapToPrepareRequest(
        { branch: 'feat' },
        { environment: { working_directory: tmpDir, branch: null, commit: sha } },
      ),
    ).toThrow(/envelope specified null \(detached\)\.$/);
  });

  it('presents detached summaries, issue IDs, receipt artifacts, and ownership cleanly', () => {
    const sha = '1111222233334444555566667777888899990000';
    const wtDir = resolvePath(path.join(tmpDir, 'verify-wt'));
    const receiptPath = resolvePath(path.join(tmpDir, 'receipt.md'));
    const envelope: WorkspaceTaskInput = {
      task: {
        logical_stage: 'workspace_prepare',
        root_issue_id: '150',
        current_issue_id: '150',
        attempt: 1,
      },
      environment: {
        working_directory: tmpDir,
        repository: 'owner/repo',
        delivery_target: 'owner/repo',
        base_remote: 'upstream',
        push_remote: 'origin',
        base_branch: 'main',
        branch: null,
        commit: sha,
      },
      inputs: {
        parameters: {
          worktree: wtDir,
        },
      },
      contract: {
        receipt_path: receiptPath,
      },
    };

    const { request } = mapToPrepareRequest({}, envelope);

    // Issue ID extraction guards against empty strings
    expect(resolvePrepareIssueIds(request.target, envelope)).toEqual({
      rootIssueId: '150',
      currentIssueId: '150',
    });
    expect(
      resolvePrepareIssueIds(
        { kind: 'issue', issue: 42 },
        { task: { root_issue_id: '   ', current_issue_id: '' } },
      ),
    ).toEqual({
      rootIssueId: undefined,
      currentIssueId: '42',
    });

    const preparedDetached: PreparedWorkspace = {
      repository: 'owner/repo',
      deliveryTarget: 'owner/repo',
      sourceCheckout: resolvePath(tmpDir),
      primaryCheckout: resolvePath(tmpDir),
      path: wtDir,
      branch: null,
      commit: sha,
      baseBranch: 'main',
      baseRemote: 'upstream',
      pushRemote: 'origin',
      disposition: 'created',
    };

    const summary = formatPrepareSummary(preparedDetached, request.target);
    expect(summary).toBe(`Prepared detached worktree at ${wtDir} pinned to commit ${sha}`);

    const succeededArtifacts = buildPrepareReceiptArtifacts({
      status: 'succeeded',
      prepared: preparedDetached,
      receiptPath,
    });
    const succeededReceipt = buildMarkdownReceipt({
      status: 'succeeded',
      compactReport: {
        execution_status: 'succeeded',
        result: mapPreparedWorkspaceToResult(preparedDetached),
        receipt_path: receiptPath,
        summary,
      },
      artifacts: succeededArtifacts,
      created: true,
      logicalStage: 'workspace_prepare',
      envelope,
      rootIssueId: '150',
      currentIssueId: '150',
      summary,
    });
    expect(succeededReceipt).toContain('- Worktree ownership: created fresh detached worktree.');
    expect(succeededReceipt).toContain(`Pinned to commit ${sha} (branch: detached HEAD)`);

    // Feature and reused ownership + summary formatting
    const featurePrepared: PreparedWorkspace = {
      ...preparedDetached,
      branch: 'issue-150',
    };
    expect(formatPrepareSummary(featurePrepared, { kind: 'issue', issue: 150 })).toBe(
      `Prepared feature worktree for issue 150 at ${wtDir}`,
    );
    expect(
      formatPrepareSummary(featurePrepared, { kind: 'branch', branch: 'issue-150', path: wtDir }),
    ).toBe(`Prepared feature worktree on branch 'issue-150' at ${wtDir}`);
    expect(
      formatPrepareSummary({ ...preparedDetached, disposition: 'reused' }, request.target),
    ).toBe(`Reused existing worktree at ${wtDir} with commit ${sha}`);

    const featureReceipt = buildMarkdownReceipt({
      status: 'succeeded',
      compactReport: {
        execution_status: 'succeeded',
        result: mapPreparedWorkspaceToResult(featurePrepared),
        receipt_path: receiptPath,
        summary: formatPrepareSummary(featurePrepared, { kind: 'issue', issue: 150 }),
      },
      artifacts: buildPrepareReceiptArtifacts({
        status: 'succeeded',
        prepared: featurePrepared,
        receiptPath,
      }),
      created: true,
      logicalStage: 'workspace_prepare',
      envelope,
      rootIssueId: '150',
      currentIssueId: '150',
      summary: formatPrepareSummary(featurePrepared, { kind: 'issue', issue: 150 }),
    });
    expect(featureReceipt).toContain('- Worktree ownership: created fresh feature worktree.');

    // Blocked artifacts preserve real envelope/request fields rather than degrading to 'N/A'
    const blockedArtifacts = buildPrepareReceiptArtifacts({
      status: 'blocked',
      request,
      envelope,
      receiptPath,
    });
    expect(blockedArtifacts).toMatchObject({
      working_directory: wtDir,
      repository: 'owner/repo',
      delivery_target: 'owner/repo',
      base_remote: 'upstream',
      push_remote: 'origin',
      worktree: wtDir,
      baseBranch: 'main',
      branch: null,
      commit: sha,
      environment_receipt: receiptPath,
    });
  });

  it('renders structured cleanup resource dispositions, reasons, and artifacts in cleanup receipts', () => {
    const repoDir = resolvePath(tmpDir);
    const receiptPath = resolvePath(path.join(tmpDir, '16-workspace_cleanup-issue-150-try-1.md'));
    const envelope: WorkspaceTaskInput = {
      task: {
        logical_stage: 'workspace_cleanup',
        step_index: 16,
        attempt: 1,
        root_issue_id: '150',
        current_issue_id: '150',
      },
      environment: {
        working_directory: repoDir,
        primary_checkout: repoDir,
        repository: 'owner/repo',
        base_branch: 'main',
        branch: null,
        commit: null,
      },
      inputs: {
        predecessor_receipts: [path.join(tmpDir, '15-issue_finalize-issue-150-try-1.md')],
        parameters: {
          delivery_target: 'upstream/repo',
          base_remote: 'upstream',
          push_remote: 'origin',
        },
      },
      contract: {
        receipt_path: receiptPath,
      },
      budgets: {
        delivery_attempts_used: 1,
        replans_used: 0,
      },
    };

    const artifacts = buildCleanupReceiptArtifacts({
      request: {
        sourceCheckout: repoDir,
        rootIssueId: '150',
        candidates: [],
        protectedPaths: [receiptPath],
      },
      envelope,
      receiptPath,
    });
    expect(artifacts).toMatchObject({
      working_directory: repoDir,
      repository: 'owner/repo',
      delivery_target: 'upstream/repo',
      base_remote: 'upstream',
      push_remote: 'origin',
      worktree: 'N/A',
      baseBranch: 'main',
      branch: null,
      environment_receipt: receiptPath,
    });

    const incompleteReceipt = buildMarkdownReceipt({
      status: 'succeeded',
      compactReport: {
        execution_status: 'succeeded',
        result: {
          outcome: 'incomplete',
          removed_paths: ['/tmp/wt/issue-151'],
          retained_paths: [{ path: '/tmp/wt/issue-152', reason: 'untracked protected artifact' }],
          removed_branches: [{ branch: 'issue-151', scope: 'remote', remote: 'origin', already_absent: false }],
          retained_branches: [{ branch: 'issue-152', reason: 'worktree still present' }],
        },
        receipt_path: receiptPath,
        summary: 'Confirmed 1 worktrees absent. Retained 1 candidates.',
      },
      artifacts,
      created: false,
      logicalStage: 'workspace_cleanup',
      isCleanup: true,
      envelope,
      rootIssueId: '150',
      currentIssueId: '150',
      summary: 'Confirmed 1 worktrees absent. Retained 1 candidates.',
    });

    expect(incompleteReceipt).toContain('- Cleanup outcome: incomplete');
    expect(incompleteReceipt).toContain('### Removed Paths (1)');
    expect(incompleteReceipt).toContain('- `/tmp/wt/issue-151`');
    expect(incompleteReceipt).toContain('### Retained Paths (1)');
    expect(incompleteReceipt).toContain('- `/tmp/wt/issue-152`: untracked protected artifact');
    expect(incompleteReceipt).toContain('### Removed Branches (1)');
    expect(incompleteReceipt).toContain('- `issue-151` (remote, remote: origin)');
    expect(incompleteReceipt).toContain('### Retained Branches (1)');
    expect(incompleteReceipt).toContain('- `issue-152`: worktree still present');
    expect(incompleteReceipt).toContain('- Dispatch ID: 16-workspace_cleanup-issue-150-try-1');
    expect(incompleteReceipt).toContain('- Delivery attempts used: 1');

    const cleanedReceipt = buildMarkdownReceipt({
      status: 'succeeded',
      compactReport: {
        execution_status: 'succeeded',
        result: {
          outcome: 'cleaned',
          removed_paths: ['/tmp/wt/issue-151'],
          retained_paths: [],
          removed_branches: [],
          retained_branches: [],
        },
        receipt_path: receiptPath,
        summary: 'Confirmed 1 worktrees absent. Retained 0 candidates.',
      },
      artifacts,
      created: false,
      logicalStage: 'workspace_cleanup',
      isCleanup: true,
      envelope,
      rootIssueId: '150',
      currentIssueId: '150',
      summary: 'Confirmed 1 worktrees absent. Retained 0 candidates.',
    });
    expect(cleanedReceipt).toContain('Cleanup complete with zero retained paths or branches.');

    const blockedReceipt = buildMarkdownReceipt({
      status: 'blocked',
      compactReport: {
        execution_status: 'blocked',
        result: { outcome: 'incomplete', error: 'missing ownership evidence' },
        receipt_path: receiptPath,
        summary: 'Workspace cleanup blocked: missing ownership evidence',
      },
      artifacts,
      created: false,
      logicalStage: 'workspace_cleanup',
      isCleanup: true,
      envelope,
      rootIssueId: '150',
      currentIssueId: '150',
      summary: 'Workspace cleanup blocked: missing ownership evidence',
      errorMessage: 'Workspace cleanup blocked: missing ownership evidence',
    });
    expect(blockedReceipt).toContain('Workspace cleanup blocked: missing ownership evidence');
    expect(blockedReceipt).toContain('Resolve reported blocker before retrying workspace cleanup.');
  });
});
