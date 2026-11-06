/**
 * @fileoverview Unit and integration tests for Run dispatch and observation (Ticket #30).
 * Verifies Run entrypoint, Assignments, Execution, Worktree, and RunState submodules.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { initTestGitRepo } from './test-git-helper.js';
import { Run } from '../../packages/core/src/workflow/run.js';
import { readWorktreeOwner } from '../../packages/core/src/workflow/repository/worktree.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
} from '../../packages/core/src/workflow/types.js';

class ControlledExecutor implements AgentExecutor {
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
      id: `handle-${taskId}-${this.launchedTasks.length}`,
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

describe('Run Dispatch & Observation (#30)', () => {
  let tmpDir: string;
  let repoDir: string;
  let storageRoot: string;
  let executor: ControlledExecutor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-run-test-'));
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

  it('opens a Run, allocates worktree with 1.0 owner marker, and initializes RunState', async () => {
    const run = await Run.open({
      runId: 'run-alpha',
      repository: 'test-owner/test-repo',
      issue: 42,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    expect(run.runId).toBe('run-alpha');
    expect(run.worktreePath).toBeDefined();

    // Verify version 1.0 owner marker
    const marker = await readWorktreeOwner(run.worktreePath);
    expect(marker).not.toBeNull();
    expect(marker?.version).toBe('1.0');
    expect(marker?.run_id).toBe('run-alpha');
    expect(marker?.repository).toBe('test-owner/test-repo');

    // Verify durable state snapshot
    const snapshot = await run.state.read('run-alpha');
    expect(snapshot.runId).toBe('run-alpha');
    expect(snapshot.status).toBe('pending_dispatch');
    expect(snapshot.eventsCount).toBe(1);
  });

  it('dispatches a minimal task with injected identity and pinned contract version without auto-advancing step', async () => {
    const run = await Run.open({
      runId: 'run-dispatch-test',
      repository: 'test-owner/test-repo',
      issue: 101,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const dispatchResult = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Implement feature X in src/feature.ts',
      inputs: { issue: 101, taskBrief: 'Implement feature X' },
    });

    expect(dispatchResult.taskId).toBeDefined();
    expect(dispatchResult.status).toBe('running');
    expect(dispatchResult.handle.id).toContain('handle-');

    // Verify executor was called with fresh conversation
    expect(executor.launchedTasks.length).toBe(1);
    const launched = executor.launchedTasks[0];
    expect(launched.taskId).toBe(dispatchResult.taskId);
    expect(launched.workingDirectory).toBe(run.worktreePath);

    // Verify prompt has injected identity and delivery expectations, without workflow submit-result receipt protocol
    expect(launched.prompt).toContain(dispatchResult.taskId);
    expect(launched.prompt).toContain('run-dispatch-test');
    expect(launched.prompt).toContain('Implement feature X in src/feature.ts');
    expect(launched.prompt).toContain('completed, blocked');
    expect(launched.prompt).not.toContain('pc workflow submit-result');

    // Verify task initialization file written to worktree
    const initRaw = await fs.readFile(path.join(run.worktreePath, 'initialization.json'), 'utf8');
    const initPayload = JSON.parse(initRaw);
    expect(initPayload.taskId).toBe(dispatchResult.taskId);
    expect(initPayload.runId).toBe('run-dispatch-test');
    expect(initPayload.contractVersion).toBe('1.0');

    // Verify Run does NOT automatically transition to next step
    const obs = await run.observe();
    expect(obs.runId).toBe('run-dispatch-test');
    expect(obs.activeTaskId).toBe(dispatchResult.taskId);
    expect(obs.hasSubmittedResult).toBe(false);
    expect(obs.status).toBe('running');
  });

  it('observes execution status distinct from business outcome', async () => {
    const run = await Run.open({
      runId: 'run-observe-test',
      repository: 'test-owner/test-repo',
      issue: 102,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const dispatchResult = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Work on ticket 102',
    });

    // Case A: Running process, no business result yet
    let obs = await run.observe();
    expect(obs.execution?.status).toBe('running');
    expect(obs.result).toBeUndefined();
    expect(obs.hasSubmittedResult).toBe(false);

    // Case B: Process exited, but no result submitted yet
    executor.taskStatuses.set(dispatchResult.taskId, 'exited');
    obs = await run.observe();
    expect(obs.execution?.status).toBe('exited');
    expect(obs.result).toBeUndefined();
    expect(obs.hasSubmittedResult).toBe(false);

    // Case C: Process exited and business outcome submitted as 'blocked'
    await run.submitResult(dispatchResult.taskId, {
      outcome: 'blocked',
      summary: 'Missing upstream dependencies',
      artifacts: { reason: 'Dependency unavailable' },
    });

    obs = await run.observe();
    expect(obs.execution?.status).toBe('exited');
    expect(obs.hasSubmittedResult).toBe(true);
    expect(obs.result?.outcome).toBe('blocked');
    // Notice: Run status is blocked based on outcome, but execution was cleanly exited
    expect(obs.status).toBe('blocked');
  });

  it('validates submitted results against contract: accepts valid outputs and rejects missing required outputs', async () => {
    const run = await Run.open({
      runId: 'run-validate-test',
      repository: 'test-owner/test-repo',
      issue: 103,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const dispatchResult = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Deliver verified implementation',
    });

    // 1. Rejects invalid outcome
    await expect(
      run.submitResult(dispatchResult.taskId, {
        outcome: 'invalid_outcome',
        summary: 'Did something',
      }),
    ).rejects.toThrow(/not permitted/i);

    // 2. Rejects completed outcome missing required artifacts ('diff', 'testResults', 'summary')
    await expect(
      run.submitResult(dispatchResult.taskId, {
        outcome: 'completed',
        summary: 'Done work',
        artifacts: { diff: 'some diff' }, // missing testResults
      }),
    ).rejects.toThrow(/Missing required artifact.*testResults/i);

    // 3. Accepts conforming completed outcome with all required artifacts
    const validSubmission = await run.submitResult(dispatchResult.taskId, {
      outcome: 'completed',
      summary: 'Implemented and tested feature',
      artifacts: {
        diff: 'git diff content',
        testResults: 'All 5 tests passed',
        summary: 'Implemented and tested feature',
      },
    });

    expect(validSubmission.acknowledged).toBe(true);
    expect(validSubmission.result.outcome).toBe('completed');

    // 4. Observe confirms valid result persisted
    const obs = await run.observe();
    expect(obs.hasSubmittedResult).toBe(true);
    expect(obs.result?.artifacts?.diff).toBe('git diff content');
  });

  it('starts fresh agent conversations for multiple tasks without session reuse', async () => {
    const run = await Run.open({
      runId: 'run-fresh-session-test',
      repository: 'test-owner/test-repo',
      issue: 104,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    // Task 1
    const task1 = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'First task',
    });
    executor.taskStatuses.set(task1.taskId, 'exited');
    await run.submitResult(task1.taskId, {
      outcome: 'completed',
      summary: 'Task 1 complete',
      artifacts: { diff: 'diff 1', testResults: 'pass 1', summary: 'Task 1 complete' },
    });

    // Task 2 (same role/skill type, sequential)
    const task2 = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Second task',
    });

    expect(task2.taskId).not.toBe(task1.taskId);
    expect(task2.handle.id).not.toBe(task1.handle.id);
    expect(executor.launchedTasks.length).toBe(2);
    expect(executor.launchedTasks[0].taskId).toBe(task1.taskId);
    expect(executor.launchedTasks[1].taskId).toBe(task2.taskId);
  });

  it('auto-reads valid result.json from worktree when observed and records it in state', async () => {
    const run = await Run.open({
      runId: 'run-result-file-test',
      repository: 'test-owner/test-repo',
      issue: 105,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const task = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Worker writing result.json',
    });

    // Simulate agent writing conforming result.json directly to its worktree
    const resultJson = {
      outcome: 'completed',
      summary: 'Delivered result via file',
      artifacts: {
        diff: 'file-diff',
        testResults: 'file-tests-passed',
        summary: 'Delivered result via file',
      },
    };
    await fs.writeFile(
      path.join(run.worktreePath, 'result.json'),
      JSON.stringify(resultJson, null, 2),
      'utf8',
    );

    // Observe should detect result.json, validate it, and persist it in state
    const obs = await run.observe();
    expect(obs.hasSubmittedResult).toBe(true);
    expect(obs.result?.outcome).toBe('completed');
    expect(obs.result?.artifacts?.diff).toBe('file-diff');

    // Confirm state has it
    const snapshot = await run.state.read('run-result-file-test');
    expect(snapshot.results.get(task.taskId)?.outcome).toBe('completed');
  });

  it('Worktree submodule inspects version 1.0 owner marker and protects dirty worktrees from retirement', async () => {
    const run = await Run.open({
      runId: 'run-worktree-test',
      repository: 'test-owner/test-repo',
      issue: 106,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    // Clean worktree inspection
    const inspection = await run.worktree.inspect(run.worktreePath, 'run-worktree-test');
    expect(inspection.exists).toBe(true);
    expect(inspection.ownedByRun).toBe(true);
    expect(inspection.markerVersion).toBe('1.0');
    expect(inspection.isDirty).toBe(false);

    // Make worktree dirty with an untracked user file
    await fs.writeFile(path.join(run.worktreePath, 'new-file.txt'), 'hello');
    const dirtyInspection = await run.worktree.inspect(run.worktreePath, 'run-worktree-test');
    expect(dirtyInspection.isDirty).toBe(true);

    // Attempting to retire dirty worktree must throw WorkflowCleanupError
    await expect(
      run.worktree.retire(run.worktreePath, 'run-worktree-test'),
    ).rejects.toThrow(/contains uncommitted or untracked changes/i);

    // Clean up untracked file, retirement should succeed
    await fs.rm(path.join(run.worktreePath, 'new-file.txt'));
    const retireResult = await run.worktree.retire(run.worktreePath, 'run-worktree-test');
    expect(retireResult.retired).toBe(true);
  });

  it('RunState enforces runtime policy constraints atomically', async () => {
    const run = await Run.open({
      runId: 'run-state-policy-test',
      repository: 'test-owner/test-repo',
      issue: 107,
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const task = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'First task running',
    });
    expect(task.taskId).toBeDefined();

    // While task is active/running, cannot dispatch another task
    await expect(
      run.dispatch({
        taskType: 'pc-issue-work',
        instructions: 'Second concurrent task should be rejected',
      }),
    ).rejects.toThrow(/is currently/i);

    // Cannot submit result for non-existent task
    await expect(
      run.submitResult('non-existent-task-id', {
        outcome: 'completed',
        summary: 'Non-existent',
      }),
    ).rejects.toThrow(/not found/i);
  });
});
