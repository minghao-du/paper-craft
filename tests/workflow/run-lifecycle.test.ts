/**
 * @fileoverview Unit and integration tests for Run lifecycle, recovery, deduplication,
 * stop, and safe teardown (Ticket #31).
 * Verifies Run recovery after lost launch confirmation, deduplication of dispatches,
 * stop with execution termination, and safe finish with dirty worktree protection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { initTestGitRepo } from './test-git-helper.js';
import { Run } from '../../packages/core/src/workflow/run.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
  ExecutionStopResult,
} from '../../packages/core/src/workflow/types.js';

class ControlledExecutor implements AgentExecutor {
  public available = true;
  public checkError?: string;
  public launchError?: string;
  public stopResult?: ExecutionStopResult;
  public launchedTasks: Array<{ taskId: string; workingDirectory: string; prompt: string }> = [];
  public stoppedHandles: ExecutionHandle[] = [];
  public taskStatuses = new Map<string, ExecutionStatus>();
  public inspectResults = new Map<string, ExecutionInspection>();

  async check(): Promise<{ available: boolean; error?: string }> {
    return { available: this.available, error: this.checkError };
  }

  async launch(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle> {
    if (this.launchError) {
      throw new Error(this.launchError);
    }
    this.launchedTasks.push({ taskId, workingDirectory, prompt });
    this.taskStatuses.set(taskId, 'running');
    const handle: ExecutionHandle = {
      id: `handle-${taskId}-${this.launchedTasks.length}`,
      taskId,
    };
    this.inspectResults.set(taskId, { status: 'running', handle });
    return handle;
  }

  async inspect(taskId: string): Promise<ExecutionInspection> {
    const custom = this.inspectResults.get(taskId);
    if (custom) {
      const status =
        this.taskStatuses.get(taskId) === 'exited'
          ? 'exited'
          : (custom.status ?? this.taskStatuses.get(taskId) ?? 'not_started');
      return {
        ...custom,
        status,
        exitCode: status === 'exited' ? 0 : custom.exitCode,
      };
    }
    const status = this.taskStatuses.get(taskId) ?? 'not_started';
    return {
      status,
      handle: { id: `handle-${taskId}`, taskId },
      exitCode: status === 'exited' ? 0 : undefined,
    };
  }

  async send(): Promise<void> {}

  async stop(handle: ExecutionHandle): Promise<ExecutionStopResult> {
    if (this.stopResult) {
      return this.stopResult;
    }
    this.stoppedHandles.push(handle);
    this.taskStatuses.set(handle.taskId, 'exited');
    const custom = this.inspectResults.get(handle.taskId);
    if (custom) {
      custom.status = 'exited';
    }
    return { stopped: true };
  }
}

describe('Run Lifecycle: Stop & Safe Teardown (#31)', () => {
  let tmpDir: string;
  let repoDir: string;
  let storageRoot: string;
  let executor: ControlledExecutor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-lifecycle-test-'));
    repoDir = path.join(tmpDir, 'repo');
    storageRoot = path.join(tmpDir, 'storage');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(storageRoot, { recursive: true });
    await initTestGitRepo(repoDir);
    executor = new ControlledExecutor();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('stops active execution, sets status to paused, prevents new dispatches, and open/observe do not restart', async () => {
    const run = await Run.open({
      runId: 'run-stop-test',
      repository: 'test-owner/test-repo',
      issue: 201,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const dispatch = await run.dispatch({
      taskId: 'task-stop-1',
      taskType: 'pc-issue-work',
      instructions: 'Work in progress',
    });

    expect(dispatch.status).toBe('running');
    expect(executor.launchedTasks.length).toBe(1);

    // Stop the Run
    const stopSummary = await run.stop('User requested pause');
    expect(stopSummary.stopped).toBe(true);
    expect(stopSummary.status).toBe('paused');
    expect(stopSummary.reason).toBe('User requested pause');
    expect(stopSummary.terminatedHandles.length).toBe(1);
    expect(stopSummary.terminatedHandles[0].taskId).toBe('task-stop-1');
    expect(executor.stoppedHandles.length).toBe(1);

    // Verify RunState reflects paused
    const snapshot = await run.state.read('run-stop-test');
    expect(snapshot.status).toBe('paused');
    expect(snapshot.stopReason).toBe('User requested pause');
    expect(snapshot.activeTaskId).toBeUndefined();

    // Verify subsequent dispatch is rejected while paused
    await expect(
      run.dispatch({
        taskType: 'pc-issue-work',
        instructions: 'Should be rejected while stopped',
      }),
    ).rejects.toThrow(/paused|stopped/i);

    // Observe does not restart the stopped task
    const obs = await run.observe();
    expect(obs.status).toBe('paused');
    expect(executor.launchedTasks.length).toBe(1);

    // Re-opening the Run retains paused status and does not restart tasks
    const reopened = await Run.open({
      runId: 'run-stop-test',
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });
    const reopenedObs = await reopened.observe();
    expect(reopenedObs.status).toBe('paused');
    expect(executor.launchedTasks.length).toBe(1);

    // Calling stop repeatedly is idempotent
    const repeatStop = await run.stop('Repeat stop');
    expect(repeatStop.stopped).toBe(true);
    expect(repeatStop.status).toBe('paused');
  });

  it('conservatively handles uncertain stop and inspect states without assuming termination', async () => {
    const run = await Run.open({
      runId: 'run-uncertain-test',
      repository: 'test-owner/test-repo',
      issue: 202,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const dispatch = await run.dispatch({
      taskId: 'task-uncertain-1',
      taskType: 'pc-issue-work',
      instructions: 'Task that will have uncertain lifecycle',
    });

    // 1. Unconfirmed inspection: inspect returns uncertain
    executor.inspectResults.set(dispatch.taskId, {
      status: 'uncertain',
      error: 'Process status probe unconfirmed',
    });

    const obs = await run.observe();
    expect(obs.execution?.status).toBe('uncertain');
    expect(obs.execution?.isUncertain).toBe(true);
    expect(obs.execution?.error).toContain('probe unconfirmed');

    // 2. Unconfirmed termination on stop: executor returns uncertain
    executor.stopResult = {
      stopped: false,
      uncertain: true,
      error: 'SIGTERM sent but process exit unconfirmed',
    };

    const stopSummary = await run.stop('Stopping uncertain task');
    expect(stopSummary.stopped).toBe(false);
    expect(stopSummary.uncertain).toBe(true);
    expect(stopSummary.status).toBe('uncertain');
    expect(stopSummary.error).toContain('process exit unconfirmed');

    // State reflects uncertain status, not terminated or completed
    const snapshot = await run.state.read('run-uncertain-test');
    expect(snapshot.status).toBe('uncertain');
    const task = snapshot.tasks.get(dispatch.taskId);
    expect(task?.status).toBe('uncertain');
  });

  describe('Recovery & Deduplication', () => {
    it('recovers after lost launch confirmation window and does not launch a second agent on repeat dispatch', async () => {
      const run = await Run.open({
        runId: 'run-recovery-test',
        repository: 'test-owner/test-repo',
        issue: 203,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const taskId = 'task-lost-confirm-1';

      // 1. Simulate: dispatch_intent was written to RunState, but process crashed before task_launched was recorded
      await run.state.apply(run.runId, {
        type: 'dispatch_intent',
        taskId,
        taskType: 'pc-issue-work',
        prompt: 'Work instructions',
        worktreePath: run.worktreePath,
      });

      // 2. Provider actually started the task and has a running handle
      executor.inspectResults.set(taskId, {
        status: 'running',
        handle: { id: 'recovered-provider-handle-999', taskId },
      });

      // 3. Client reconnects and repeats the dispatch with the same taskId
      const reconnectRun = await Run.open({
        runId: 'run-recovery-test',
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const repeatedDispatch = await reconnectRun.dispatch({
        taskId,
        taskType: 'pc-issue-work',
        instructions: 'Work instructions',
      });

      // Verify NO second agent launched
      expect(executor.launchedTasks.length).toBe(0);
      expect(repeatedDispatch.taskId).toBe(taskId);
      expect(repeatedDispatch.handle.id).toBe('recovered-provider-handle-999');
      expect(repeatedDispatch.status).toBe('running');

      // Verify RunState now has confirmed task_launched
      const snapshot = await reconnectRun.state.read('run-recovery-test');
      expect(snapshot.tasks.get(taskId)?.handle?.id).toBe('recovered-provider-handle-999');
      expect(snapshot.tasks.get(taskId)?.status).toBe('running');
    });

    it('idempotently deduplicates repeat dispatch when task is already running', async () => {
      const run = await Run.open({
        runId: 'run-dedup-test',
        repository: 'test-owner/test-repo',
        issue: 204,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const taskId = 'task-running-1';
      const first = await run.dispatch({
        taskId,
        taskType: 'pc-issue-work',
        instructions: 'First dispatch',
      });
      expect(executor.launchedTasks.length).toBe(1);

      // Repeat identical dispatch
      const second = await run.dispatch({
        taskId,
        taskType: 'pc-issue-work',
        instructions: 'First dispatch',
      });

      expect(executor.launchedTasks.length).toBe(1);
      expect(second.taskId).toBe(first.taskId);
      expect(second.handle.id).toBe(first.handle.id);
    });

    it('rejects conflicting dispatch with same taskId but different parameters', async () => {
      const run = await Run.open({
        runId: 'run-conflict-test',
        repository: 'test-owner/test-repo',
        issue: 205,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const taskId = 'task-conflict-1';
      await run.dispatch({
        taskId,
        taskType: 'pc-issue-work',
        instructions: 'Initial params',
      });

      await expect(
        run.dispatch({
          taskId,
          taskType: 'pc-pr-land', // Different taskType!
          instructions: 'Conflicting params',
        }),
      ).rejects.toThrow(/conflicting|different parameters/i);
    });

    it('refuses to blindly restart when provider inspect status is uncertain', async () => {
      const run = await Run.open({
        runId: 'run-uncertain-recovery-test',
        repository: 'test-owner/test-repo',
        issue: 206,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const taskId = 'task-uncertain-reconnect';
      await run.state.apply(run.runId, {
        type: 'dispatch_intent',
        taskId,
        taskType: 'pc-issue-work',
        prompt: 'Prompt',
        worktreePath: run.worktreePath,
      });

      executor.inspectResults.set(taskId, {
        status: 'uncertain',
        error: 'Cannot query provider process table',
      });

      await expect(
        run.dispatch({
          taskId,
          taskType: 'pc-issue-work',
          instructions: 'Retry dispatch',
        }),
      ).rejects.toThrow(/uncertain|blind restart prevented/i);

      // Never launched a replacement agent
      expect(executor.launchedTasks.length).toBe(0);
    });

    it('RunState atomically handles runtime constraints, version conflicts, and reconstructs goal, plan, tasks, results, and links across restarts', async () => {
      const run = await Run.open({
        runId: 'run-state-reconstruction-test',
        repository: 'test-owner/test-repo',
        issue: 207,
        goal: 'Implement automated genome assembly pipeline',
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      // 1. Record plan
      await run.recordPlan({
        steps: [
          { id: 'step-1', skill: 'pc-issue-work', description: 'Scaffold snakemake' },
          { id: 'step-2', skill: 'pc-pr-land', description: 'Verify and merge' },
        ],
      });

      // 2. Dispatch Task 1 and submit result with artifact links
      const task1 = await run.dispatch({
        taskId: 'task-step-1',
        taskType: 'pc-issue-work',
        instructions: 'Scaffold pipeline',
        inputs: { issue: 207, brief: 'Initial pipeline scaffolding' },
      });

      executor.taskStatuses.set(task1.taskId, 'exited');
      await run.submitResult(task1.taskId, {
        outcome: 'completed',
        summary: 'Scaffolded snakemake rules',
        artifacts: {
          diff: 'git diff scaffold',
          testResults: 'tests pass',
          summary: 'Scaffolded snakemake rules',
          pipelineFile: 'workflow/Snakefile',
        },
      });

      // 3. Dispatch Task 2 linked to predecessor task result
      const task2 = await run.dispatch({
        taskId: 'task-step-2',
        taskType: 'pc-issue-work',
        instructions: 'Verify pipeline with predecessor artifacts',
        inputs: {
          issue: 207,
          predecessorTaskId: task1.taskId,
          predecessorArtifact: 'workflow/Snakefile',
        },
      });

      executor.taskStatuses.set(task2.taskId, 'exited');
      await run.submitResult(task2.taskId, {
        outcome: 'completed',
        summary: 'Verified pipeline delivery',
        artifacts: {
          diff: 'git diff verified',
          testResults: 'all passed',
          summary: 'Verified pipeline delivery',
        },
      });

      // 4. Simulate complete shutdown and restart by opening Run afresh from storage
      const rehydrated = await Run.open({
        runId: 'run-state-reconstruction-test',
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const snapshot = await rehydrated.state.read('run-state-reconstruction-test');

      // Verify reconstructed goal
      expect(snapshot.goal).toBe('Implement automated genome assembly pipeline');

      // Verify reconstructed plan
      expect(snapshot.plan).toEqual({
        steps: [
          { id: 'step-1', skill: 'pc-issue-work', description: 'Scaffold snakemake' },
          { id: 'step-2', skill: 'pc-pr-land', description: 'Verify and merge' },
        ],
      });

      // Verify reconstructed tasks and inputs/links
      expect(snapshot.tasks.size).toBe(2);
      const recTask1 = snapshot.tasks.get('task-step-1');
      expect(recTask1?.status).toBe('completed');
      expect(recTask1?.inputs?.brief).toBe('Initial pipeline scaffolding');

      const recTask2 = snapshot.tasks.get('task-step-2');
      expect(recTask2?.status).toBe('completed');
      expect(recTask2?.inputs?.predecessorTaskId).toBe('task-step-1');
      expect(recTask2?.inputs?.predecessorArtifact).toBe('workflow/Snakefile');

      // Verify reconstructed results and artifact links
      expect(snapshot.results.size).toBe(2);
      expect(snapshot.results.get('task-step-1')?.artifacts?.pipelineFile).toBe('workflow/Snakefile');
      expect(snapshot.results.get('task-step-2')?.artifacts?.summary).toBe('Verified pipeline delivery');
    });
  });

  describe('Safe Teardown & Finish', () => {
    it('refuses to finish while tasks are still active or unconfirmed', async () => {
      const run = await Run.open({
        runId: 'run-finish-active-test',
        repository: 'test-owner/test-repo',
        issue: 208,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      await run.dispatch({
        taskId: 'task-active-1',
        taskType: 'pc-issue-work',
        instructions: 'Running task',
      });

      await expect(
        run.finish({
          conclusion: 'Premature finish',
          evidence: ['ev-1'],
        }),
      ).rejects.toThrow(/still active|unconfirmed/i);

      // Verify worktree was NOT removed
      const exists = await fs
        .access(run.worktreePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      const snapshot = await run.state.read('run-finish-active-test');
      expect(snapshot.status).not.toBe('completed');
    });

    it('refuses to finish if worktree has uncommitted modifications (dirty check)', async () => {
      const run = await Run.open({
        runId: 'run-finish-dirty-test',
        repository: 'test-owner/test-repo',
        issue: 209,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const task = await run.dispatch({
        taskId: 'task-dirty-1',
        taskType: 'pc-issue-work',
        instructions: 'Task that leaves untracked file',
      });

      executor.taskStatuses.set(task.taskId, 'exited');
      await run.submitResult(task.taskId, {
        outcome: 'completed',
        summary: 'Completed work',
        artifacts: { diff: 'diff', testResults: 'pass', summary: 'Completed work' },
      });

      // Create an untracked, uncommitted file in the worktree
      await fs.writeFile(path.join(run.worktreePath, 'uncommitted-research.md'), '# Notes\n');

      // finish must throw WorkflowCleanupError and refuse to release worktree
      await expect(
        run.finish({
          conclusion: 'Finished with dirty worktree',
          evidence: ['sha-123'],
        }),
      ).rejects.toThrow(/uncommitted or untracked changes/i);

      // Worktree must remain intact
      const exists = await fs
        .access(run.worktreePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      const snapshot = await run.state.read('run-finish-dirty-test');
      expect(snapshot.status).not.toBe('completed');
    });

    it('refuses to finish if worktree ownership is foreign', async () => {
      const run = await Run.open({
        runId: 'run-finish-ownership-test',
        repository: 'test-owner/test-repo',
        issue: 210,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const task = await run.dispatch({
        taskId: 'task-ownership-1',
        taskType: 'pc-issue-work',
        instructions: 'Task done',
      });
      executor.taskStatuses.set(task.taskId, 'exited');
      await run.submitResult(task.taskId, {
        outcome: 'completed',
        summary: 'Done',
        artifacts: { diff: 'd', testResults: 'p', summary: 'Done' },
      });

      // Tamper with owner marker to simulate foreign ownership
      const markerPath = path.join(run.worktreePath, '.pc-execution-owner');
      await fs.writeFile(
        markerPath,
        JSON.stringify({ version: '1.0', run_id: 'foreign-run-999', repository: 'other/repo' }),
      );

      await expect(
        run.finish({
          conclusion: 'Foreign owned finish',
          evidence: [],
        }),
      ).rejects.toThrow(/not owned by Run/i);
    });

    it('finishes cleanly when valid: releases worktree, sets status to completed, supports repeatable calls, and preserves results', async () => {
      const run = await Run.open({
        runId: 'run-finish-clean-test',
        repository: 'test-owner/test-repo',
        issue: 211,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const task = await run.dispatch({
        taskId: 'task-clean-1',
        taskType: 'pc-issue-work',
        instructions: 'Deliver clean work',
      });
      executor.taskStatuses.set(task.taskId, 'exited');
      await run.submitResult(task.taskId, {
        outcome: 'completed',
        summary: 'Feature verified',
        artifacts: {
          diff: 'git diff content',
          testResults: 'all 12 tests passed',
          summary: 'Feature verified',
          reportUrl: 'https://github.com/test-owner/test-repo/pull/1',
        },
      });

      // Call finish with conclusion and evidence
      const finishResult = await run.finish({
        conclusion: 'Feature delivery accepted and verified',
        evidence: ['commit-sha-abc', 'pr-url-123'],
      });

      expect(finishResult.completed).toBe(true);
      expect(finishResult.worktreeRetired).toBe(true);
      expect(finishResult.status).toBe('completed');
      expect(finishResult.conclusion).toBe('Feature delivery accepted and verified');
      expect(finishResult.evidence).toEqual(['commit-sha-abc', 'pr-url-123']);

      // Worktree directory should be cleanly removed from disk
      const worktreeExists = await fs
        .access(run.worktreePath)
        .then(() => true)
        .catch(() => false);
      expect(worktreeExists).toBe(false);

      // Repeatable finish: calling finish again is idempotent and does not throw
      const repeatFinish = await run.finish({
        conclusion: 'Feature delivery accepted and verified',
        evidence: ['commit-sha-abc', 'pr-url-123'],
      });
      expect(repeatFinish.completed).toBe(true);
      expect(repeatFinish.worktreeRetired).toBe(true);
      expect(repeatFinish.status).toBe('completed');

      // Accepted results and artifact links survive temporary worktree removal
      const finalSnapshot = await run.state.read('run-finish-clean-test');
      expect(finalSnapshot.status).toBe('completed');
      expect(finalSnapshot.finishConclusion).toBe('Feature delivery accepted and verified');
      expect(finalSnapshot.finishEvidence).toEqual(['commit-sha-abc', 'pr-url-123']);
      expect(finalSnapshot.results.size).toBe(1);
      expect(finalSnapshot.results.get('task-clean-1')?.artifacts?.reportUrl).toBe(
        'https://github.com/test-owner/test-repo/pull/1',
      );

      // Separately visible: execution completion, business conclusions, and resource release
      const obs = await run.observe('task-clean-1');
      expect(obs.execution?.status).toBe('exited'); // Execution completion
      expect(obs.result?.outcome).toBe('completed'); // Business conclusion
      expect(obs.snapshot.status).toBe('completed'); // Overall status
      expect(finishResult.worktreeRetired).toBe(true); // Resource release

      // Reopening a completed run does not recreate the deleted git worktree
      const reopenedRun = await Run.open({
        runId: 'run-finish-clean-test',
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });
      const reopenedWorktreeExists = await fs
        .access(reopenedRun.worktreePath)
        .then(() => true)
        .catch(() => false);
      expect(reopenedWorktreeExists).toBe(false);

      const reopenedObs = await reopenedRun.observe();
      expect(reopenedObs.status).toBe('completed');
    });
  });
});
