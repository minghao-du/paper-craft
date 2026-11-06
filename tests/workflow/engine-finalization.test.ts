/**
 * @fileoverview Integration tests for Ticket #7:
 * Finalize records and release resources before completing a Run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WorkflowEngine,
} from '../../packages/core/src/workflow/engine.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
  GitHubMergeChecker,
  IssueChecker,
  MergeStatusResult,
} from '../../packages/core/src/workflow/types.js';

class MockExecutor implements AgentExecutor {
  public available = true;
  public checkError?: string;
  public launchError?: string;
  public stopError?: string;
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

  async stop(handle: ExecutionHandle): Promise<{ stopped: boolean; uncertain?: boolean; error?: string }> {
    if (this.stopError) {
      return { stopped: false, error: this.stopError };
    }
    this.stoppedHandles.push(handle);
    this.taskStatuses.set(handle.taskId, 'exited');
    return { stopped: true };
  }
}

class MockMergeChecker implements GitHubMergeChecker {
  public headSha = 'commit-approved-123';
  public state: 'OPEN' | 'MERGED' | 'CLOSED' = 'MERGED';
  public merged = true;
  public mergeCommitSha = 'commit-merged-squash-456';
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

describe('Workflow MVP: Finalization and Resource Release (Ticket #7)', () => {
  let tmpDir: string;
  let mockExecutor: MockExecutor;
  let mockIssueChecker: IssueChecker;
  let mockMergeChecker: MockMergeChecker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-finalization-test-'));
    mockExecutor = new MockExecutor();
    mockIssueChecker = {
      checkIssue: async (_repo, issue) => ({
        exists: true,
        open: true,
        title: `Test Issue #${issue}`,
      }),
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
      executor: mockExecutor,
      mergeChecker: mockMergeChecker,
    });
    await engine.init({ repository: 'test-owner/test-repo' });
    return engine;
  }

  /**
   * Helper that runs worker, review, and merge to reach the finalization step.
   */
  async function reachFinalization(engine: WorkflowEngine, issueNumber: number = 401) {
    const run = await engine.start({
      issue: issueNumber,
      requirements: 'Strict production delivery requirements.',
    });

    // 1. Worker completes implementation
    const workerTask = await engine.dispatch(run.run_id, 'Implement changes');
    await engine.submitResult(run.run_id, workerTask.taskId, {
      outcome: 'completed',
      summary: 'Implementation done',
      artifacts: { diff: 'diff-content-401', test_results: 'All 15 tests passed' },
    });

    // 2. Reviewer approves (pass)
    const reviewTask = await engine.dispatch(run.run_id, 'Review changes');
    await engine.submitResult(run.run_id, reviewTask.taskId, {
      outcome: 'pass',
      summary: 'Approved review',
      artifacts: {
        reviewed_commit: 'commit-approved-123',
        findings: 'Clean implementation meeting all criteria',
      },
    });

    // 3. Merger merges PR
    const mergerTask = await engine.dispatch(run.run_id, 'Merge PR');
    const mergeSubmit = await engine.submitResult(run.run_id, mergerTask.taskId, {
      outcome: 'completed',
      summary: 'Merged PR on GitHub',
      artifacts: { merged_commit: 'commit-merged-squash-456' },
    });

    expect(mergeSubmit.nextStep).toBe('finalization');
    expect(mergeSubmit.nextRole).toBe('finalizer');

    return run;
  }

  it('dispatches finalization role through common interface and inherits immutable requirements and delivery artifacts', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 401);

    const sched = await engine.getSchedulingContext(run.run_id);
    expect(sched.currentStep).toBe('finalization');
    expect(sched.stepDefinition.role).toBe('finalizer');
    expect(sched.roleContract.skill).toBe('pc-pr-land');
    expect(sched.roleContract.permitted_outcomes).toEqual(['completed', 'blocked']);
    expect(sched.roleContract.required_artifacts).toEqual(['release_evidence']);
    expect(sched.sharedRequirements).toBe('Strict production delivery requirements.');
    expect(sched.mergedCommit).toBe('commit-merged-squash-456');
    expect(sched.deliveryArtifacts).toBeDefined();
    expect(sched.deliveryArtifacts?.merged_commit).toBe('commit-merged-squash-456');
    expect(sched.deliveryArtifacts?.reviewed_commit).toBe('commit-approved-123');
    expect(sched.deliveryArtifacts?.diff).toBe('diff-content-401');

    // Dispatch finalizer role
    const finalizerTask = await engine.dispatch(run.run_id, 'Preserve final records and release resources');
    expect(finalizerTask.role).toBe('finalizer');
    expect(finalizerTask.step).toBe('finalization');

    // Verify prompt delivered to executor inherits immutable requirements and delivery artifacts
    const launched = mockExecutor.launchedTasks.find((t) => t.taskId === finalizerTask.taskId);
    expect(launched).toBeDefined();
    expect(launched!.prompt).toContain('Strict production delivery requirements.');
    expect(launched!.prompt).toContain('commit-merged-squash-456');
    expect(launched!.prompt).toContain('commit-approved-123');

    // Verify initialization.json written in worktree
    const initJsonRaw = await fs.readFile(path.join(sched.worktreePath, 'initialization.json'), 'utf8');
    const initJson = JSON.parse(initJsonRaw);
    expect(initJson.role).toBe('finalizer');
    expect(initJson.step).toBe('finalization');
    expect(initJson.shared_requirements).toBe('Strict production delivery requirements.');
    expect(initJson.delivery_artifacts.merged_commit).toBe('commit-merged-squash-456');
    expect(initJson.delivery_artifacts.reviewed_commit).toBe('commit-approved-123');
  });

  it('requires necessary final records and preservation evidence before destructive worktree cleanup', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 402);

    const finalizerTask = await engine.dispatch(run.run_id, 'Finalize');

    // Missing release_evidence artifact should reject submission
    await expect(
      engine.submitResult(run.run_id, finalizerTask.taskId, {
        outcome: 'completed',
        summary: 'Finalization completed without evidence',
        artifacts: {},
      }),
    ).rejects.toThrow(/missing required artifact/i);

    // Invalid / failed preservation evidence blocks the run and does not destroy worktree
    const sched = await engine.getSchedulingContext(run.run_id);
    const submitWithInvalidPreservation = await engine.submitResult(run.run_id, finalizerTask.taskId, {
      outcome: 'completed',
      summary: 'Preservation failed during bundle creation',
      artifacts: {
        release_evidence: { preserved: false, error: 'Git bundle verification failed' },
      },
    });

    expect(submitWithInvalidPreservation.transitionStatus).toBe('blocked');
    expect(submitWithInvalidPreservation.message).toContain('Resource release failed');

    // Verify worktree was NOT deleted
    const worktreeExists = await fs
      .stat(sched.worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(worktreeExists).toBe(true);

    // Verify Run is NOT completed
    const status = await engine.status(run.run_id);
    expect(status.status).toBe('blocked');
  });

  it('engine-controlled cleanup validates ownership before destroying worktree', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 403);

    const sched = await engine.getSchedulingContext(run.run_id);
    const finalizerTask = await engine.dispatch(run.run_id, 'Finalize');

    // Tamper with ownership marker to simulate foreign run claiming directory
    const ownerFile = path.join(sched.worktreePath, '.pc-execution-owner');
    await fs.writeFile(
      ownerFile,
      JSON.stringify({ run_id: 'other-foreign-run', claimed_at: new Date().toISOString() }),
      'utf8',
    );

    // Attempting submitResult with valid release_evidence must fail cleanup due to ownership violation
    const submitRes = await engine.submitResult(run.run_id, finalizerTask.taskId, {
      outcome: 'completed',
      summary: 'Preserved archive',
      artifacts: {
        release_evidence: { bundle_sha: 'bundle-sha-403', archive_path: '/archives/403.tar.gz' },
      },
    });

    expect(submitRes.transitionStatus).toBe('blocked');
    expect(submitRes.message).toContain('ownership');

    // Foreign directory must NOT have been deleted
    const exists = await fs
      .stat(sched.worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const status = await engine.status(run.run_id);
    expect(status.status).toBe('blocked');
  });

  it('verifies worktree release and termination of remaining agent executions including registered orchestrator before reporting completion', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 404);

    const sched = await engine.getSchedulingContext(run.run_id);

    // Register an orchestrator handle with the engine
    const orchestratorHandle: ExecutionHandle = {
      id: 'orch-session-404',
      taskId: 'orch-task-404',
    };
    await engine.registerOrchestrator(run.run_id, orchestratorHandle);

    const finalizerTask = await engine.dispatch(run.run_id, 'Finalize');

    // Submit completed with valid release evidence and verified ownership
    const submitRes = await engine.submitResult(run.run_id, finalizerTask.taskId, {
      outcome: 'completed',
      summary: 'Records preserved and ready for release',
      artifacts: {
        release_evidence: {
          bundle: 'git-bundle-404.pack',
          worklog: 'final worklog recorded',
          preserved: true,
        },
      },
    });

    expect(submitRes.acknowledged).toBe(true);
    expect(submitRes.transitionStatus).toBe('completed');
    expect(submitRes.nextStep).toBe('completed');

    // Verify orchestrator execution was terminated by engine
    expect(mockExecutor.stoppedHandles.some((h) => h.id === 'orch-session-404')).toBe(true);

    // Verify worktree was cleanly removed
    const exists = await fs
      .stat(sched.worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);

    // Verify run status is completed
    const status = await engine.status(run.run_id);
    expect(status.status).toBe('completed');
    expect(status.step).toBe('completed');

    // Verify events log contains resources_released and run_completed
    const events = await engine.readEvents(run.run_id);
    const releasedEvent = events.find((e) => e.type === 'resources_released');
    expect(releasedEvent).toBeDefined();
    expect(releasedEvent!.payload.worktreeRemoved).toBe(true);

    const completedEvent = events.find((e) => e.type === 'run_completed');
    expect(completedEvent).toBeDefined();
  });

  it('failures in cleanup retain actionable status and do not mark the Run complete', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 405);

    // Register orchestrator handle
    await engine.registerOrchestrator(run.run_id, {
      id: 'orch-405',
      taskId: 'orch-task-405',
    });

    const finalizerTask = await engine.dispatch(run.run_id, 'Finalize');

    // Simulate executor failure when stopping orchestrator process
    mockExecutor.stopError = 'Process hung and failed SIGTERM/SIGKILL';

    const submitRes = await engine.submitResult(run.run_id, finalizerTask.taskId, {
      outcome: 'completed',
      summary: 'Records preserved',
      artifacts: {
        release_evidence: { preserved: true },
      },
    });

    // Cleanup failed due to executor stop error
    expect(submitRes.transitionStatus).toBe('blocked');
    expect(submitRes.message).toContain('failed to terminate');

    const status = await engine.status(run.run_id);
    expect(status.status).toBe('blocked');

    const events = await engine.readEvents(run.run_id);
    expect(events.some((e) => e.type === 'cleanup_failed')).toBe(true);
    expect(events.some((e) => e.type === 'run_completed')).toBe(false);
  });

  it('repeated cleanup reconciles actual resource state safely and idempotently', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 406);

    const finalizerTask = await engine.dispatch(run.run_id, 'Finalize');
    const submitRes = await engine.submitResult(run.run_id, finalizerTask.taskId, {
      outcome: 'completed',
      summary: 'All preserved',
      artifacts: {
        release_evidence: { preserved: true },
      },
    });
    expect(submitRes.transitionStatus).toBe('completed');

    // Call releaseRunResources a second time
    const secondRelease = await engine.releaseRunResources(run.run_id);
    expect(secondRelease.released).toBe(true);
    expect(secondRelease.status).toBe('completed');
    expect(secondRelease.message).toContain('already released');
  });

  it('resumes unfinished finalization without repeating implementation or merge', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 407);

    // Dispatch finalizer task
    const finalizerTask = await engine.dispatch(run.run_id, 'Finalize records');
    const taskCountBeforeResume = mockExecutor.launchedTasks.length;

    // Simulate interruption before result submission
    const resumeRes = await engine.resume({ runId: run.run_id });
    expect(resumeRes.currentStep).toBe('finalization');
    expect(resumeRes.reconciledTask?.taskId).toBe(finalizerTask.taskId);
    expect(resumeRes.reconciledTask?.action).toBe('reconnected');

    // Verify implementation and merge tasks were NOT relaunched
    expect(mockExecutor.launchedTasks.length).toBe(taskCountBeforeResume);

    // Scheduling context after resume has delivery artifacts and requirements
    expect(resumeRes.schedulingContext.currentStep).toBe('finalization');
    expect(resumeRes.schedulingContext.mergedCommit).toBe('commit-merged-squash-456');
    expect(resumeRes.schedulingContext.sharedRequirements).toBe('Strict production delivery requirements.');
  });

  it('resumes interrupted finalization where result was submitted but release was pending', async () => {
    const engine = await createInitializedEngine();
    const run = await reachFinalization(engine, 408);

    const finalizerTask = await engine.dispatch(run.run_id, 'Finalize');

    // Simulate interruption by manually appending result_submitted without running cleanup
    const now = new Date().toISOString();
    await engine.appendEvent(run.run_id, {
      type: 'result_submitted',
      run_id: run.run_id,
      timestamp: now,
      payload: {
        taskId: finalizerTask.taskId,
        step: 'finalization',
        role: 'finalizer',
        outcome: 'completed',
        summary: 'Final records preserved before engine power loss',
        artifacts: {
          release_evidence: { preserved: true, bundle: 'bundle-408.pack' },
        },
      },
    });

    // Resume the run
    const resumeRes = await engine.resume({ runId: run.run_id });

    // Resume should reconcile finalization release and complete the run safely
    expect(resumeRes.status).toBe('completed');
    expect(resumeRes.currentStep).toBe('completed');

    const status = await engine.status(run.run_id);
    expect(status.status).toBe('completed');

    // Worktree was cleanly removed during resume reconciliation
    const exists = await fs
      .stat(resumeRes.worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});
