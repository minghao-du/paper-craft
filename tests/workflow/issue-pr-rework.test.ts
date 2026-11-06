/**
 * @fileoverview Tests for issue implementation, PR landing, and rework dispatch (Ticket #32).
 * Verifies contract validation for pc-issue-work and pc-pr-land, non-passing outcome Run lifecycle,
 * predecessor result linking for repair tasks, and fresh agent conversation dispatch.
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

describe('Issue Work, PR Land, and Rework Dispatch (#32)', () => {
  let tmpDir: string;
  let repoDir: string;
  let storageRoot: string;
  let executor: ControlledExecutor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-issue-pr-rework-'));
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

  describe('Contract Output Validation', () => {
    it('pc-issue-work requires changes and test evidence on completion', async () => {
      const run = await Run.open({
        runId: 'run-work-val',
        repository: 'owner/repo',
        issue: 32,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const task = await run.dispatch({
        taskType: 'pc-issue-work',
        instructions: 'Implement feature',
      });

      // 1. Missing changes (no diff/commitSha/changes)
      await expect(
        run.submitResult(task.taskId, {
          outcome: 'completed',
          summary: 'Finished work without diff',
          artifacts: { testResults: 'All 5 tests passed' },
        }),
      ).rejects.toThrow(/changes|diff/i);

      // 2. Missing test evidence (no testResults/verificationEvidence)
      await expect(
        run.submitResult(task.taskId, {
          outcome: 'completed',
          summary: 'Finished work without tests',
          artifacts: { diff: 'diff --git ...' },
        }),
      ).rejects.toThrow(/test evidence|testResults/i);

      // 3. Valid submission with changes and test evidence succeeds
      const valid = await run.submitResult(task.taskId, {
        outcome: 'completed',
        summary: 'Feature implemented with passing tests',
        artifacts: {
          diff: 'diff --git a/src/index.ts b/src/index.ts',
          testResults: '✓ 3 tests passed in 120ms',
        },
      });

      expect(valid.acknowledged).toBe(true);
      expect(valid.result.outcome).toBe('completed');
    });

    it('pc-pr-land validates prNumber, prUrl, merged boolean, and findings if not merged', async () => {
      const run = await Run.open({
        runId: 'run-land-val',
        repository: 'owner/repo',
        issue: 32,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      // --- Subcase A: outcome 'landed' requires merged: true, prNumber, prUrl ---
      const landTask = await run.dispatch({
        taskType: 'pc-pr-land',
        instructions: 'Deliver PR',
      });

      // Missing merged boolean
      await expect(
        run.submitResult(landTask.taskId, {
          outcome: 'landed',
          summary: 'Landed PR',
          artifacts: { prNumber: 42, prUrl: 'https://github.com/owner/repo/pull/42' },
        }),
      ).rejects.toThrow(/merged/i);

      // merged is false but outcome is 'landed'
      await expect(
        run.submitResult(landTask.taskId, {
          outcome: 'landed',
          summary: 'Landed PR',
          artifacts: { prNumber: 42, prUrl: 'https://github.com/owner/repo/pull/42', merged: false },
        }),
      ).rejects.toThrow(/merged.*true/i);

      // Missing prNumber
      await expect(
        run.submitResult(landTask.taskId, {
          outcome: 'landed',
          summary: 'Landed PR',
          artifacts: { prUrl: 'https://github.com/owner/repo/pull/42', merged: true },
        }),
      ).rejects.toThrow(/prNumber/i);

      // Valid landed outcome
      const validLanded = await run.submitResult(landTask.taskId, {
        outcome: 'landed',
        summary: 'Squash merged PR #42 to main',
        artifacts: {
          prNumber: 42,
          prUrl: 'https://github.com/owner/repo/pull/42',
          merged: true,
          mergedCommit: 'abcdef1234567890',
        },
      });
      expect(validLanded.acknowledged).toBe(true);
      expect(validLanded.result.outcome).toBe('landed');

      // --- Subcase B: outcome 'rework_needed' requires merged: false and findings ---
      const reworkTask = await run.dispatch({
        taskType: 'pc-pr-land',
        instructions: 'Deliver another PR',
      });

      // Missing findings when not merged
      await expect(
        run.submitResult(reworkTask.taskId, {
          outcome: 'rework_needed',
          summary: 'Review found defects',
          artifacts: { merged: false },
        }),
      ).rejects.toThrow(/findings/i);

      // Valid rework_needed outcome
      const validRework = await run.submitResult(reworkTask.taskId, {
        outcome: 'rework_needed',
        summary: 'Review failed due to missing error handling',
        artifacts: {
          merged: false,
          findings: 'Error handling missing in src/api.ts on line 42',
          evaluatedCommit: 'deadbeef112233',
        },
      });
      expect(validRework.acknowledged).toBe(true);
      expect(validRework.result.outcome).toBe('rework_needed');
    });
  });

  describe('Non-Passing Outcome and Run Lifecycle', () => {
    it('review findings requiring rework does not mark Run complete', async () => {
      const run = await Run.open({
        runId: 'run-rework-lifecycle',
        repository: 'owner/repo',
        issue: 32,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      const landTask = await run.dispatch({
        taskType: 'pc-pr-land',
        instructions: 'Deliver PR',
      });

      executor.taskStatuses.set(landTask.taskId, 'exited');

      // Submit rework_needed
      await run.submitResult(landTask.taskId, {
        outcome: 'rework_needed',
        summary: 'Code review found 2 blocking issues',
        artifacts: {
          merged: false,
          findings: 'Fix null pointer check and add regression test',
          evaluatedCommit: 'c0ffee1234',
        },
      });

      // Observe: Run must NOT be completed! It remains pending_dispatch for orchestrator repair task
      const obs = await run.observe();
      expect(obs.status).not.toBe('completed');
      expect(obs.status).toBe('pending_dispatch');
      expect(obs.hasSubmittedResult).toBe(true);
      expect(obs.result?.outcome).toBe('rework_needed');

      const snapshot = await run.state.read('run-rework-lifecycle');
      expect(snapshot.status).not.toBe('completed');
    });
  });

  describe('Predecessor Result Linking for Repair Dispatch', () => {
    it('automatically binds explicit predecessor findings and original constraints into repair assignment', async () => {
      const run = await Run.open({
        runId: 'run-repair-link',
        repository: 'owner/repo',
        issue: 32,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      // 1. Initial implementation task
      const workTask1 = await run.dispatch({
        taskType: 'pc-issue-work',
        instructions: 'Initial implementation',
        inputs: {
          issue: 32,
          constraints: ['Must run under 120s', 'Must not touch production DB'],
        },
      });
      executor.taskStatuses.set(workTask1.taskId, 'exited');
      await run.submitResult(workTask1.taskId, {
        outcome: 'completed',
        summary: 'Initial implementation done',
        artifacts: {
          diff: 'diff --git a/index.ts',
          testResults: 'tests pass',
          commitSha: 'commit-sha-1111',
        },
      });

      // 2. PR Land task which runs review and finds issues
      const landTask = await run.dispatch({
        taskType: 'pc-pr-land',
        instructions: 'Create PR and review',
        inputs: {
          issue: 32,
          branch: 'feat/test',
          baseBranch: 'main',
        },
      });
      executor.taskStatuses.set(landTask.taskId, 'exited');
      await run.submitResult(landTask.taskId, {
        outcome: 'rework_needed',
        summary: 'Review failed: missing validation on input parameter',
        artifacts: {
          merged: false,
          findings: 'Input parameter "timeout" is not validated against negative numbers',
          evaluatedCommit: 'sha-review-evaluated-2222',
        },
      });

      // 3. Orchestrator dispatches repair task explicitly referencing landTask.taskId as predecessorResultId
      const repairTask = await run.dispatch({
        taskType: 'pc-issue-work',
        instructions: 'Fix review findings and add negative number test',
        predecessorResultId: landTask.taskId,
      });

      // A. Verify a fresh agent conversation was launched (distinct handle and taskId)
      expect(repairTask.taskId).not.toBe(landTask.taskId);
      expect(repairTask.taskId).not.toBe(workTask1.taskId);
      expect(repairTask.handle.id).not.toBe(landTask.handle.id);
      expect(executor.launchedTasks.length).toBe(3);

      const launchedRepair = executor.launchedTasks[2];
      expect(launchedRepair.taskId).toBe(repairTask.taskId);

      // B. Verify prompt contains explicit predecessor findings and commit SHA without brittle full-prompt snapshots
      expect(launchedRepair.prompt).toContain(landTask.taskId);
      expect(launchedRepair.prompt).toContain('Input parameter "timeout" is not validated against negative numbers');
      expect(launchedRepair.prompt).toContain('sha-review-evaluated-2222');

      // C. Verify initialization.json payload in worktree contains bound predecessor context
      const initRaw = await fs.readFile(path.join(run.worktreePath, 'initialization.json'), 'utf8');
      const initPayload = JSON.parse(initRaw);
      expect(initPayload.taskId).toBe(repairTask.taskId);
      expect(initPayload.predecessor).toBeDefined();
      expect(initPayload.predecessor.predecessorResultId).toBe(landTask.taskId);
      expect(initPayload.predecessor.findings).toContain('Input parameter "timeout" is not validated against negative numbers');
      expect(initPayload.predecessor.previousHeadSha).toBe('sha-review-evaluated-2222');
    });

    it('does not default to latest result when predecessorResultId is not specified', async () => {
      const run = await Run.open({
        runId: 'run-no-default-pred',
        repository: 'owner/repo',
        issue: 32,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      // Previous task with failure
      const prevTask = await run.dispatch({
        taskType: 'pc-pr-land',
        instructions: 'Deliver PR',
      });
      executor.taskStatuses.set(prevTask.taskId, 'exited');
      await run.submitResult(prevTask.taskId, {
        outcome: 'rework_needed',
        summary: 'Prior defect findings',
        artifacts: {
          merged: false,
          findings: 'Old findings that should not be automatically copied',
          evaluatedCommit: 'old-sha-999',
        },
      });

      // Dispatch a fresh, independent task without predecessorResultId
      const independentTask = await run.dispatch({
        taskType: 'pc-issue-work',
        instructions: 'Independent unrelated task',
        inputs: { issue: 33 },
      });

      const launched = executor.launchedTasks[1];
      expect(launched.taskId).toBe(independentTask.taskId);

      // Must NOT contain old findings or old evaluated commit
      expect(launched.prompt).not.toContain('Old findings that should not be automatically copied');
      expect(launched.prompt).not.toContain('old-sha-999');

      const initRaw = await fs.readFile(path.join(run.worktreePath, 'initialization.json'), 'utf8');
      const initPayload = JSON.parse(initRaw);
      expect(initPayload.predecessor).toBeUndefined();
    });

    it('rejects repair dispatch if specified predecessorResultId does not exist', async () => {
      const run = await Run.open({
        runId: 'run-bad-pred',
        repository: 'owner/repo',
        issue: 32,
        repoRoot: repoDir,
        worktreeRoot: repoDir,
        storageRoot,
        executor,
      });

      await expect(
        run.dispatch({
          taskType: 'pc-issue-work',
          instructions: 'Repair something',
          predecessorResultId: 'non-existent-task-id',
        }),
      ).rejects.toThrow(/predecessor.*not found/i);
    });
  });
});
