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
import { CleanupResult, PreparedWorkspace } from '../src/types.js';

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
    expect(request.unresolved).toEqual(['dirty branch issue-51']);
    expect(request.protectedPaths).toContain(resolvePath(path.join(tmpDir, 'cleanup-receipt.md')));
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
