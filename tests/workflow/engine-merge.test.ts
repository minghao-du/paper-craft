/**
 * @fileoverview Integration tests for Ticket #6:
 * Merge reviewed revisions with recoverable outcome verification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WorkflowEngine,
  WorkflowReviewInvalidatedError,
  WorkflowMergeVerificationError,
} from '../../packages/core/src/workflow/engine.js';
import { DefaultGitHubMergeChecker } from '../../packages/core/src/workflow/checkers.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
  GitHubMergeChecker,
  IssueChecker,
  MergeStatusResult,
  ProviderChecker,
} from '../../packages/core/src/workflow/types.js';

class MockExecutor implements AgentExecutor {
  public available = true;
  public checkError?: string;
  public launchError?: string;
  public launchedTasks: Array<{ taskId: string; workingDirectory: string; prompt: string }> = [];
  public stoppedHandles: ExecutionHandle[] = [];
  public taskStatuses = new Map<string, ExecutionStatus>();

  async check(): Promise<{ available: boolean; error?: string }> {
    return { available: this.available, error: this.checkError };
  }

  async launch(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle> {
    if (this.launchError) {
      throw new Error(this.launchError);
    }
    this.launchedTasks.push({ taskId, workingDirectory, prompt });
    this.taskStatuses.set(taskId, 'running');
    return {
      id: `handle-${taskId}`,
      taskId,
    };
  }

  async inspect(taskId: string): Promise<ExecutionInspection> {
    const status = this.taskStatuses.get(taskId) ?? 'not_started';
    return {
      status,
      handle: { id: `handle-${taskId}`, taskId },
      exitCode: status === 'exited' ? 0 : undefined,
    };
  }

  async send(): Promise<void> {}

  async stop(handle: ExecutionHandle): Promise<{ stopped: boolean; uncertain?: boolean }> {
    this.stoppedHandles.push(handle);
    this.taskStatuses.set(handle.taskId, 'exited');
    return { stopped: true };
  }
}

class MockMergeChecker implements GitHubMergeChecker {
  public headSha = 'commit-approved-123';
  public state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN';
  public merged = false;
  public mergeCommitSha?: string;
  public exists = true;
  public error?: string;

  async checkMergeStatus(
    _repository: string,
    _prOrIssue: number | string,
    _worktreePath?: string,
  ): Promise<MergeStatusResult> {
    if (this.error) {
      return { exists: false, error: this.error };
    }
    return {
      exists: this.exists,
      headSha: this.headSha,
      state: this.state,
      merged: this.merged,
      mergeCommitSha: this.mergeCommitSha,
    };
  }
}

describe('Workflow MVP: Merge Reviewed Revisions (Ticket #6)', () => {
  let tmpDir: string;
  let mockExecutor: MockExecutor;
  let mockIssueChecker: IssueChecker;
  let mockProviderChecker: ProviderChecker;
  let mockMergeChecker: MockMergeChecker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-merge-test-'));
    mockExecutor = new MockExecutor();
    mockIssueChecker = {
      checkIssue: async (_repo, issue) => ({
        exists: true,
        open: true,
        title: `Test Issue #${issue}`,
      }),
    };
    mockProviderChecker = {
      check: async () => ({ available: true }),
    };
    mockMergeChecker = new MockMergeChecker();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createInitializedEngine(): Promise<WorkflowEngine> {
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      issueChecker: mockIssueChecker,
      providerChecker: mockProviderChecker,
      executor: mockExecutor,
      mergeChecker: mockMergeChecker,
    });
    await engine.init({ repository: 'test-owner/test-repo' });
    return engine;
  }

  it('progresses to merge upon review pass and merges current evaluated head into finalization', async () => {
    const engine = await createInitializedEngine();
    const run = await engine.start({ issue: 301 });

    // 1. Worker completes implementation
    const workerTask = await engine.dispatch(run.run_id, 'Implement feature');
    await engine.submitResult(run.run_id, workerTask.taskId, {
      outcome: 'completed',
      summary: 'Feature implemented',
      artifacts: { diff: 'diff-content', test_results: 'All tests passing' },
    });

    // 2. Reviewer approves (pass) with specific reviewed_commit
    const reviewTask = await engine.dispatch(run.run_id, 'Review implementation');
    const reviewSubmit = await engine.submitResult(run.run_id, reviewTask.taskId, {
      outcome: 'pass',
      summary: 'Approved for landing',
      artifacts: {
        reviewed_commit: 'commit-approved-123',
        findings: 'Verified against all acceptance criteria',
      },
    });

    expect(reviewSubmit.nextStep).toBe('merge');
    expect(reviewSubmit.nextRole).toBe('merger');

    // 3. Scheduling context supplies evaluated commit and merger role contract
    const sched = await engine.getSchedulingContext(run.run_id);
    expect(sched.currentStep).toBe('merge');
    expect(sched.stepDefinition.role).toBe('merger');
    expect(sched.roleContract.skill).toBe('pc-pr-land');
    expect(sched.roleContract.permitted_outcomes).toEqual(['completed', 'blocked']);
    expect(sched.roleContract.required_artifacts).toEqual(['merged_commit']);
    expect(sched.evaluatedCommit).toBe('commit-approved-123');

    // 4. Dispatch merger when current PR head matches approved revision
    mockMergeChecker.headSha = 'commit-approved-123';
    mockMergeChecker.state = 'OPEN';
    mockMergeChecker.merged = false;

    const mergerTask = await engine.dispatch(run.run_id, 'Merge evaluated PR head using squash merge');
    expect(mergerTask.role).toBe('merger');
    expect(mergerTask.step).toBe('merge');

    // Verify task prompt and initialization.json retain evaluated commit
    const launched = mockExecutor.launchedTasks.find((t) => t.taskId === mergerTask.taskId);
    expect(launched).toBeDefined();
    expect(launched!.prompt).toContain('Evaluated Commit: commit-approved-123');

    const initJsonRaw = await fs.readFile(path.join(sched.worktreePath, 'initialization.json'), 'utf8');
    const initJson = JSON.parse(initJsonRaw);
    expect(initJson.role).toBe('merger');
    expect(initJson.step).toBe('merge');
    expect(initJson.prior_evidence.evaluatedCommit).toBe('commit-approved-123');

    // 5. Merger completes merge on GitHub
    mockMergeChecker.state = 'MERGED';
    mockMergeChecker.merged = true;
    mockMergeChecker.mergeCommitSha = 'commit-merged-squash-456';

    const mergeSubmit = await engine.submitResult(run.run_id, mergerTask.taskId, {
      outcome: 'completed',
      summary: 'Successfully squash merged PR #301 into main',
      artifacts: { merged_commit: 'commit-merged-squash-456' },
    });

    expect(mergeSubmit.acknowledged).toBe(true);
    expect(mergeSubmit.executionTerminated).toBe(true);
    expect(mergeSubmit.nextStep).toBe('finalization');
    expect(mergeSubmit.nextRole).toBe('finalizer');
    expect(mergeSubmit.transitionStatus).toBe('running');

    // Status derivation reflects merge completion and pending finalization
    const st = await engine.status(run.run_id);
    expect(st.step).toBe('finalization');
    expect(st.status).toBe('pending_dispatch');
  });

  it('invalidates review approval and transitions back to review when PR head changes before merge', async () => {
    const engine = await createInitializedEngine();
    const run = await engine.start({ issue: 302 });

    // 1. Worker implements
    const workerTask = await engine.dispatch(run.run_id, 'Implement feature');
    await engine.submitResult(run.run_id, workerTask.taskId, {
      outcome: 'completed',
      summary: 'Feature implemented',
      artifacts: { diff: 'diff-1', test_results: 'pass' },
    });

    // 2. Reviewer approves commit-approved-123
    const reviewTask = await engine.dispatch(run.run_id, 'Review');
    await engine.submitResult(run.run_id, reviewTask.taskId, {
      outcome: 'pass',
      summary: 'LGTM',
      artifacts: {
        reviewed_commit: 'commit-approved-123',
        findings: 'Clean code',
      },
    });

    // 3. New commit pushed to PR before merge dispatch: head is now commit-new-changed-456!
    mockMergeChecker.headSha = 'commit-new-changed-456';
    mockMergeChecker.state = 'OPEN';
    mockMergeChecker.merged = false;

    // 4. Attempting to dispatch merger rejects and invalidates review
    await expect(
      engine.dispatch(run.run_id, 'Attempt merge on changed head'),
    ).rejects.toThrow(WorkflowReviewInvalidatedError);

    // 5. Workflow has transitioned back to review step
    const sched = await engine.getSchedulingContext(run.run_id);
    expect(sched.currentStep).toBe('review');
    expect(sched.stepDefinition.role).toBe('reviewer');
    expect(sched.status).toBe('pending_dispatch');

    // 6. Reviewer is dispatched next, requiring fresh review
    const freshReviewTask = await engine.dispatch(run.run_id, 'Review newly pushed commit');
    expect(freshReviewTask.role).toBe('reviewer');
    expect(freshReviewTask.step).toBe('review');

    // 7. Fresh review approves the new commit
    await engine.submitResult(run.run_id, freshReviewTask.taskId, {
      outcome: 'pass',
      summary: 'Approved newly pushed revision',
      artifacts: {
        reviewed_commit: 'commit-new-changed-456',
        findings: 'Verified new commit',
      },
    });

    const schedAfter = await engine.getSchedulingContext(run.run_id);
    expect(schedAfter.currentStep).toBe('merge');
    expect(schedAfter.evaluatedCommit).toBe('commit-new-changed-456');
  });

  it('prevents premature advancement to finalization when GitHub reports PR is not merged', async () => {
    const engine = await createInitializedEngine();
    const run = await engine.start({ issue: 303 });

    // Step 1: Worker
    const wTask = await engine.dispatch(run.run_id, 'Worker work');
    await engine.submitResult(run.run_id, wTask.taskId, {
      outcome: 'completed',
      summary: 'Work done',
      artifacts: { diff: 'diff', test_results: 'pass' },
    });

    // Step 2: Reviewer pass
    const rTask = await engine.dispatch(run.run_id, 'Review');
    await engine.submitResult(run.run_id, rTask.taskId, {
      outcome: 'pass',
      summary: 'Pass',
      artifacts: { reviewed_commit: 'commit-approved-123', findings: 'Pass' },
    });

    // Step 3: Dispatch merger
    mockMergeChecker.headSha = 'commit-approved-123';
    mockMergeChecker.state = 'OPEN';
    mockMergeChecker.merged = false;

    const mTask = await engine.dispatch(run.run_id, 'Perform merge');

    // Step 4: Merger claims completion, but GitHub state is still OPEN (unmerged)!
    mockMergeChecker.state = 'OPEN';
    mockMergeChecker.merged = false;

    const mergeSubmit = await engine.submitResult(run.run_id, mTask.taskId, {
      outcome: 'completed',
      summary: 'I merged the PR',
      artifacts: { merged_commit: 'premature-sha' },
    });

    // Should NOT advance to finalization; must record explicit blocker
    expect(mergeSubmit.transitionStatus).toBe('blocked');
    expect(mergeSubmit.nextStep).toBeUndefined();

    const st = await engine.status(run.run_id);
    expect(st.status).toBe('blocked');
    expect(st.step).toBe('merge');
    expect(st.summary).toContain('Merge verification failed');
  });

  it('preserves explicit blockers for stale or missing review evidence when entering merge', async () => {
    const engine = await createInitializedEngine();
    const run = await engine.start({ issue: 304 });

    // Step 1: Worker
    const wTask = await engine.dispatch(run.run_id, 'Worker work');
    await engine.submitResult(run.run_id, wTask.taskId, {
      outcome: 'completed',
      summary: 'Work done',
      artifacts: { diff: 'diff', test_results: 'pass' },
    });

    // Corrupt or bypass step transition to merge without review pass
    const invalidTransEvent = {
      type: 'step_transitioned',
      run_id: run.run_id,
      timestamp: new Date().toISOString(),
      payload: {
        fromStep: 'implementation',
        toStep: 'merge',
        outcome: 'completed',
        reason: 'bypass',
      },
    };
    await engine.appendEvent(run.run_id, invalidTransEvent);

    // Attempting to dispatch merger without evaluatedCommit records blocker
    await expect(
      engine.dispatch(run.run_id, 'Merge without review evidence'),
    ).rejects.toThrow(WorkflowMergeVerificationError);

    const st = await engine.status(run.run_id);
    expect(st.status).toBe('blocked');
    expect(st.summary).toContain('missing approved review revision');
  });

  it('reconciles interrupted merge on resume if PR is already merged on GitHub without duplicate merge execution', async () => {
    const engine = await createInitializedEngine();
    const run = await engine.start({ issue: 305 });

    // 1. Worker and Reviewer succeed
    const wTask = await engine.dispatch(run.run_id, 'Work');
    await engine.submitResult(run.run_id, wTask.taskId, {
      outcome: 'completed',
      summary: 'Done',
      artifacts: { diff: 'd', test_results: 't' },
    });

    const rTask = await engine.dispatch(run.run_id, 'Review');
    await engine.submitResult(run.run_id, rTask.taskId, {
      outcome: 'pass',
      summary: 'Pass',
      artifacts: { reviewed_commit: 'commit-approved-123', findings: 'Pass' },
    });

    // 2. Merger dispatched
    mockMergeChecker.headSha = 'commit-approved-123';
    mockMergeChecker.state = 'OPEN';
    mockMergeChecker.merged = false;

    const mTask = await engine.dispatch(run.run_id, 'Merge PR');
    expect(mockExecutor.launchedTasks).toHaveLength(3);

    // 3. Interruption happens: merger process terminates after merging on GitHub,
    // but before calling submitResult
    mockExecutor.taskStatuses.set(mTask.taskId, 'exited');
    mockMergeChecker.state = 'MERGED';
    mockMergeChecker.merged = true;
    mockMergeChecker.mergeCommitSha = 'commit-reconciled-789';

    // 4. Resume inspects external GitHub state
    const resumeRes = await engine.resume(run.run_id);

    // 5. Reconciles state as merged without duplicate merge execution
    expect(resumeRes.currentStep).toBe('finalization');
    expect(resumeRes.status).toBe('pending_dispatch');
    expect(resumeRes.reconciledTask?.action).toBe('collected');
    expect(resumeRes.reconciledTask?.result?.outcome).toBe('completed');
    expect(resumeRes.reconciledTask?.result?.artifacts?.merged_commit).toBe('commit-reconciled-789');

    // No duplicate merge task was launched by resume
    expect(mockExecutor.launchedTasks).toHaveLength(3);

    const st = await engine.status(run.run_id);
    expect(st.step).toBe('finalization');
    expect(st.status).toBe('pending_dispatch');
  });

  it('does not duplicate merge when interrupted and PR is not merged on GitHub', async () => {
    const engine = await createInitializedEngine();
    const run = await engine.start({ issue: 306 });

    // 1. Worker and Reviewer succeed
    const wTask = await engine.dispatch(run.run_id, 'Work');
    await engine.submitResult(run.run_id, wTask.taskId, {
      outcome: 'completed',
      summary: 'Done',
      artifacts: { diff: 'd', test_results: 't' },
    });

    const rTask = await engine.dispatch(run.run_id, 'Review');
    await engine.submitResult(run.run_id, rTask.taskId, {
      outcome: 'pass',
      summary: 'Pass',
      artifacts: { reviewed_commit: 'commit-approved-123', findings: 'Pass' },
    });

    // 2. Merger dispatched
    mockMergeChecker.headSha = 'commit-approved-123';
    mockMergeChecker.state = 'OPEN';
    mockMergeChecker.merged = false;

    const mTask = await engine.dispatch(run.run_id, 'Merge PR');

    // 3. Interrupted and exited without merging
    mockExecutor.taskStatuses.set(mTask.taskId, 'exited');
    mockMergeChecker.merged = false;
    mockMergeChecker.state = 'OPEN';

    // 4. Resume inspects external state
    const resumeRes = await engine.resume(run.run_id);

    // Reconciled task shows exited without result; does NOT assume merged
    expect(resumeRes.currentStep).toBe('merge');
    expect(resumeRes.reconciledTask?.action).toBe('none');
    expect(resumeRes.reconciledTask?.executionStatus).toBe('exited');
    expect(mockExecutor.launchedTasks).toHaveLength(3); // No blind re-launch
  });

  it('marks uncertain when external merge inspection fails on error during submitResult and resume', async () => {
    const engine = await createInitializedEngine();
    const run = await engine.start({ issue: 307 });

    // Worker and Reviewer succeed
    const wTask = await engine.dispatch(run.run_id, 'Work');
    await engine.submitResult(run.run_id, wTask.taskId, {
      outcome: 'completed',
      summary: 'Done',
      artifacts: { diff: 'd', test_results: 't' },
    });

    const rTask = await engine.dispatch(run.run_id, 'Review');
    await engine.submitResult(run.run_id, rTask.taskId, {
      outcome: 'pass',
      summary: 'Pass',
      artifacts: { reviewed_commit: 'commit-approved-123', findings: 'Pass' },
    });

    // Merger dispatched
    mockMergeChecker.headSha = 'commit-approved-123';
    mockMergeChecker.state = 'OPEN';
    mockMergeChecker.merged = false;

    const mTask = await engine.dispatch(run.run_id, 'Merge PR');

    // Network / API error during merge submission
    mockMergeChecker.error = 'GitHub API rate limit exceeded (HTTP 429)';

    const submitRes = await engine.submitResult(run.run_id, mTask.taskId, {
      outcome: 'completed',
      summary: 'Merged',
      artifacts: { merged_commit: 'commit-abc' },
    });

    expect(submitRes.transitionStatus).toBe('uncertain');

    const st = await engine.status(run.run_id);
    expect(st.status).toBe('uncertain');
    expect(st.summary).toContain('uncertain');
  });

  it('DefaultGitHubMergeChecker parses gh pr view and handles error cases cleanly', async () => {
    const checker = new DefaultGitHubMergeChecker();
    // Non-existent repo/PR
    const res = await checker.checkMergeStatus('non-existent-owner/non-existent-repo', 99999);
    expect(res.exists).toBe(false);
    expect(res.error).toBeDefined();
  });
});
