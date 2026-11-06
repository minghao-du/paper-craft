import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { initTestGitRepo } from './test-git-helper.js';
import { WorkflowEngine } from '../../packages/core/src/workflow/engine.js';
import { RepositoryManager } from '../../packages/core/src/workflow/repository.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
} from '../../packages/core/src/workflow/types.js';

/**
 * Controlled in-memory AgentExecutor for deterministic Engine tests.
 */
class ControlledMockExecutor implements AgentExecutor {
  public available = true;
  public checkError?: string;
  public launchError?: string;
  public launchedTasks: Array<{ taskId: string; workingDirectory: string; prompt: string }> = [];
  public sentMessages: Array<{ handle: ExecutionHandle; message: string }> = [];
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
      id: `mock-handle-${taskId}`,
      taskId,
    };
  }

  async inspect(taskId: string): Promise<ExecutionInspection> {
    const status = this.taskStatuses.get(taskId) ?? 'not_started';
    return {
      status,
      handle: { id: `mock-handle-${taskId}`, taskId },
      exitCode: status === 'exited' ? 0 : undefined,
    };
  }

  async send(handle: ExecutionHandle, message: string): Promise<void> {
    this.sentMessages.push({ handle, message });
  }

  async stop(handle: ExecutionHandle): Promise<{ stopped: boolean; uncertain?: boolean }> {
    this.stoppedHandles.push(handle);
    this.taskStatuses.set(handle.taskId, 'exited');
    return { stopped: true };
  }
}

describe('WorkflowEngine Dispatch & Collect (Ticket #3)', () => {
  let tmpDir: string;
  let mockExecutor: ControlledMockExecutor;
  let mockRepoManager: RepositoryManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-dispatch-test-'));
    await initTestGitRepo(tmpDir);
    mockExecutor = new ControlledMockExecutor();

    mockRepoManager = new RepositoryManager({
      issueInspector: async (_repo: string, issue: number) => ({
        exists: true,
        open: true,
        title: `Issue #${issue} for testing`,
      }),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createInitializedEngine(): Promise<WorkflowEngine> {
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      repositoryManager: mockRepoManager,
      executor: mockExecutor,
    });
    await engine.init({ repository: 'test-owner/test-repo' });
    return engine;
  }

  describe('getSchedulingContext()', () => {
    it('automatically supplies orchestrator with step, role contract, and context', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({
        issue: 42,
        requirements: 'Must maintain 100% test coverage and follow TDD.',
      });

      const schedContext = await engine.getSchedulingContext(runContext.run_id);

      expect(schedContext.runId).toBe(runContext.run_id);
      expect(schedContext.repository).toBe('test-owner/test-repo');
      expect(schedContext.issue).toBe(42);
      expect(schedContext.currentStep).toBe('implementation');
      expect(schedContext.status).toBe('pending_dispatch');
      expect(schedContext.reworkCount).toBe(0);
      expect(schedContext.reworkLimit).toBe(3);
      expect(schedContext.worktreePath).toContain('issue-42');
      expect(schedContext.sharedRequirements).toBe('Must maintain 100% test coverage and follow TDD.');

      // Role contract & step definition
      expect(schedContext.stepDefinition.role).toBe('worker');
      expect(schedContext.roleContract.skill).toBe('pc-issue-work');
      expect(schedContext.roleContract.permitted_outcomes).toEqual(['completed', 'blocked']);
      expect(schedContext.roleContract.required_artifacts).toEqual(['diff', 'test_results']);
    });
  });

  describe('dispatch()', () => {
    it('prepares dedicated worktree, persists intent before launch, records handle, and sets status', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({
        issue: 101,
        requirements: 'Strict TypeScript without any "as" assertions.',
      });

      const dispatchResult = await engine.dispatch(
        runContext.run_id,
        'Implement Ticket #3 dispatch and collect contracts',
        { inputs: { spec: 'issue-101-spec' } },
      );

      expect(dispatchResult.taskId).toBeDefined();
      expect(dispatchResult.handle.id).toBe(`mock-handle-${dispatchResult.taskId}`);
      expect(dispatchResult.step).toBe('implementation');
      expect(dispatchResult.role).toBe('worker');
      expect(dispatchResult.worktreePath).toBe(runContext.worktree_path);

      // Verify dedicated worktree files prepared
      const ownerMarkerRaw = await fs.readFile(
        path.join(runContext.worktree_path, '.pc-execution-owner'),
        'utf8',
      );
      const ownerMarker = JSON.parse(ownerMarkerRaw);
      expect(ownerMarker.version).toBe('1.0');
      expect(ownerMarker.run_id).toBe(runContext.run_id);
      expect(ownerMarker.repository).toBe(runContext.repository);

      const initJsonRaw = await fs.readFile(
        path.join(runContext.worktree_path, 'initialization.json'),
        'utf8',
      );
      const initJson = JSON.parse(initJsonRaw);
      expect(initJson.role).toBe('worker');
      expect(initJson.skill).toBe('pc-issue-work');
      expect(initJson.shared_requirements).toBe('Strict TypeScript without any "as" assertions.');
      expect(initJson.task_instructions).toBe('Implement Ticket #3 dispatch and collect contracts');
      expect(initJson.permitted_outcomes).toEqual(['completed', 'blocked']);
      expect(initJson.required_artifacts).toEqual(['diff', 'test_results']);

      // Verify prompt passed to executor contains full task context, inputs, and submission contract
      expect(mockExecutor.launchedTasks.length).toBe(1);
      const launched = mockExecutor.launchedTasks[0];
      expect(launched.taskId).toBe(dispatchResult.taskId);
      expect(launched.prompt).toContain('Skill: pc-issue-work');
      expect(launched.prompt).toContain('Role: worker');
      expect(launched.prompt).toContain('Step: implementation');
      expect(launched.prompt).toContain(`Repository: ${runContext.repository}`);
      expect(launched.prompt).toContain('Issue: #101');
      expect(launched.prompt).toContain(`Working Directory: ${runContext.worktree_path}`);
      expect(launched.prompt).toContain('Implement Ticket #3 dispatch and collect contracts');
      expect(launched.prompt).toContain('Strict TypeScript without any "as" assertions.');
      expect(launched.prompt).toContain('spec: issue-101-spec');
      expect(launched.prompt).toContain(`Run ID: ${runContext.run_id}`);
      expect(launched.prompt).toContain(`Task ID: ${dispatchResult.taskId}`);
      expect(launched.prompt).toContain('Permitted Outcomes: completed, blocked');
      expect(launched.prompt).toContain('Required Artifacts: diff, test_results');
      expect(launched.prompt).toContain(
        `pc workflow submit-result --run "${runContext.run_id}" --task "${dispatchResult.taskId}" --outcome <outcome> --summary "<summary>" --artifacts '<artifacts-json>'`,
      );
      expect(launched.prompt).toContain('(or --artifacts-file <path-to-json-file> for complex or multi-line outputs)');
      expect(launched.prompt).toContain(
        'The top-level dispatch agent is responsible for returning the receipt via this command upon task completion or blockage.',
      );

      // Verify events persisted in log in strict order: run_created -> dispatch_intent -> task_launched
      const events = await engine.readEvents(runContext.run_id);
      expect(events.length).toBe(3);
      expect(events[0].type).toBe('run_created');
      expect(events[1].type).toBe('dispatch_intent');
      expect(events[2].type).toBe('task_launched');

      expect((events[1].payload as { taskId: string }).taskId).toBe(dispatchResult.taskId);
      expect((events[2].payload as { handle: ExecutionHandle }).handle.id).toBe(dispatchResult.handle.id);
    });

    it('records dispatch_intent and handles launch failure cleanly', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 102 });

      mockExecutor.launchError = 'Simulated provider spawn error';

      await expect(
        engine.dispatch(runContext.run_id, 'Instructions'),
      ).rejects.toThrow('Simulated provider spawn error');

      const events = await engine.readEvents(runContext.run_id);
      expect(events.length).toBe(3);
      expect(events[1].type).toBe('dispatch_intent');
      expect(events[2].type).toBe('task_launch_failed');
    });

    it('injects prior evidence and delivery artifacts into task prompt during rework dispatch', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 120, requirements: 'Ensure strict validation.' });

      // 1. Worker dispatches and completes implementation
      const workerTask = await engine.dispatch(runContext.run_id, 'Initial implementation');
      await engine.submitResult(runContext.run_id, workerTask.taskId, {
        outcome: 'completed',
        summary: 'Worker done',
        artifacts: { diff: 'diff-content', test_results: 'pass' },
      });

      // 2. Reviewer dispatches and requests rework with findings
      const reviewerTask = await engine.dispatch(runContext.run_id, 'Review changes');
      await engine.submitResult(runContext.run_id, reviewerTask.taskId, {
        outcome: 'rework',
        summary: 'Found regression in edge case',
        artifacts: {
          findings: 'Edge case with null input causes unhandled rejection',
          reviewed_commit: 'abc1234',
        },
      });

      // 3. Dispatch rework worker
      const reworkTask = await engine.dispatch(runContext.run_id, 'Fix reported regression');
      const launchedRework = mockExecutor.launchedTasks.find((t) => t.taskId === reworkTask.taskId);
      expect(launchedRework).toBeDefined();

      // Verify prompt contains prior evidence and delivery artifacts from earlier step
      expect(launchedRework!.prompt).toContain('## Prior Evidence & Review Findings');
      expect(launchedRework!.prompt).toContain('Evaluated Commit: abc1234');
      expect(launchedRework!.prompt).toContain('Review Findings:\nEdge case with null input causes unhandled rejection');
      expect(launchedRework!.prompt).toContain('## Delivery Artifacts');
      expect(launchedRework!.prompt).toContain('diff: diff-content');
      expect(launchedRework!.prompt).toContain('## Scheduling Directives');
      expect(launchedRework!.prompt).toContain(`Run ID: ${runContext.run_id}`);
      expect(launchedRework!.prompt).toContain(`Task ID: ${reworkTask.taskId}`);
      expect(launchedRework!.prompt).toContain('(or --artifacts-file <path-to-json-file> for complex or multi-line outputs)');
      expect(launchedRework!.prompt).toContain(
        'The top-level dispatch agent is responsible for returning the receipt via this command upon task completion or blockage.',
      );
    });
  });

  describe('Process execution status vs business outcome', () => {
    it('distinguishes running process execution from business completion', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 103 });

      const dispatchResult = await engine.dispatch(runContext.run_id, 'Work in progress');
      const statusRes = await engine.status(runContext.run_id);

      expect(statusRes.status).toBe('running');
      expect(statusRes.active_task?.task_id).toBe(dispatchResult.taskId);
      expect(statusRes.active_task?.execution_status).toBe('running');
      expect(statusRes.active_task?.business_outcome).toBeUndefined();
    });

    it('normal process exit does not complete a step without submitResult', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 104 });

      const dispatchResult = await engine.dispatch(runContext.run_id, 'Do some work');

      // Simulate that the provider process exited naturally with code 0
      mockExecutor.taskStatuses.set(dispatchResult.taskId, 'exited');

      const statusRes = await engine.status(runContext.run_id);

      // Process exited, but workflow step is NOT complete!
      expect(statusRes.active_task?.execution_status).toBe('exited');
      expect(statusRes.active_task?.business_outcome).toBeUndefined();
      expect(statusRes.status).toBe('running');
      expect(statusRes.status).not.toBe('completed');
    });
  });

  describe('submitResult() validation & acknowledgement', () => {
    it('rejects submissions with unknown taskId', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 105 });

      await expect(
        engine.submitResult(runContext.run_id, 'non-existent-task-id', {
          outcome: 'completed',
          summary: 'Done',
          artifacts: { diff: 'diff', test_results: 'pass' },
        }),
      ).rejects.toThrow(/Task "non-existent-task-id" not found/);
    });

    it('rejects submissions with non-permitted outcome for the role', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 106 });
      const dispatchResult = await engine.dispatch(runContext.run_id, 'Implement feature');

      // worker permitted outcomes: ['completed', 'blocked']. 'pass' is for reviewer, not worker.
      await expect(
        engine.submitResult(runContext.run_id, dispatchResult.taskId, {
          outcome: 'pass',
          summary: 'Done with work',
          artifacts: { diff: 'diff', test_results: 'pass' },
        }),
      ).rejects.toThrow(/Outcome "pass" is not permitted for role "worker"/);
    });

    it('rejects submissions missing required artifacts for the role', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 107 });
      const dispatchResult = await engine.dispatch(runContext.run_id, 'Implement feature');

      // worker required_artifacts: ['diff', 'test_results']. Omitting test_results.
      await expect(
        engine.submitResult(runContext.run_id, dispatchResult.taskId, {
          outcome: 'completed',
          summary: 'Missing test results',
          artifacts: { diff: 'diff content' },
        }),
      ).rejects.toThrow(/missing required artifact\(s\): test_results/);
    });

    it('accepts valid submission, verifies execution termination, and persists events', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 108 });
      const dispatchResult = await engine.dispatch(runContext.run_id, 'Implement feature');

      const submitRes = await engine.submitResult(runContext.run_id, dispatchResult.taskId, {
        outcome: 'completed',
        summary: 'Feature implemented successfully with unit tests',
        artifacts: {
          diff: 'diff --git a/file.ts b/file.ts...',
          test_results: 'Tests: 12 passed, 0 failed',
        },
      });

      expect(submitRes.acknowledged).toBe(true);
      expect(submitRes.taskId).toBe(dispatchResult.taskId);
      expect(submitRes.step).toBe('implementation');
      expect(submitRes.outcome).toBe('completed');
      expect(submitRes.executionTerminated).toBe(true);

      // Verify executor.stop() was called
      expect(mockExecutor.stoppedHandles.length).toBe(1);
      expect(mockExecutor.stoppedHandles[0].taskId).toBe(dispatchResult.taskId);

      // Verify events persisted
      const events = await engine.readEvents(runContext.run_id);
      const types = events.map((e) => e.type);
      expect(types).toContain('result_submitted');
      expect(types).toContain('task_terminated');

      // Verify status exposes collected outcome, stopping at milestone without declaring full issue delivery
      const statusRes = await engine.status(runContext.run_id);
      expect(statusRes.active_task?.business_outcome).toBe('completed');
      expect(statusRes.active_task?.stopped).toBe(true);
      expect(statusRes.status).toBe('pending_dispatch'); // Stops at milestone, pending next step dispatch
      expect(statusRes.status).not.toBe('completed');
    });

    it('handles duplicate identical submissions idempotently', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 109 });
      const dispatchResult = await engine.dispatch(runContext.run_id, 'Task instructions');

      const payload = {
        outcome: 'completed',
        summary: 'Completed work',
        artifacts: { diff: 'diff-1', test_results: 'pass' },
      };

      const res1 = await engine.submitResult(runContext.run_id, dispatchResult.taskId, payload);
      expect(res1.acknowledged).toBe(true);

      // Resubmit identical result
      const res2 = await engine.submitResult(runContext.run_id, dispatchResult.taskId, payload);
      expect(res2.acknowledged).toBe(true);
      expect(res2.idempotent).toBe(true);
    });

    it('rejects conflicting submission for the same task', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 110 });
      const dispatchResult = await engine.dispatch(runContext.run_id, 'Task instructions');

      await engine.submitResult(runContext.run_id, dispatchResult.taskId, {
        outcome: 'completed',
        summary: 'Initial submission',
        artifacts: { diff: 'diff-1', test_results: 'pass' },
      });

      // Attempt conflicting submission with different summary / outcome
      await expect(
        engine.submitResult(runContext.run_id, dispatchResult.taskId, {
          outcome: 'blocked',
          summary: 'Now claims blocked',
          artifacts: { diff: 'diff-2', test_results: 'fail' },
        }),
      ).rejects.toThrow(/Conflicting result submitted for task/);
    });

    it('transitions run status to blocked when role submits blocked outcome', async () => {
      const engine = await createInitializedEngine();
      const runContext = await engine.start({ issue: 111 });
      const dispatchResult = await engine.dispatch(runContext.run_id, 'Task instructions');

      const submitRes = await engine.submitResult(runContext.run_id, dispatchResult.taskId, {
        outcome: 'blocked',
        summary: 'Missing upstream dependencies',
        artifacts: { diff: 'none', test_results: 'blocked' },
      });

      expect(submitRes.acknowledged).toBe(true);
      expect(submitRes.outcome).toBe('blocked');

      const statusRes = await engine.status(runContext.run_id);
      expect(statusRes.status).toBe('blocked');
      expect(statusRes.active_task?.business_outcome).toBe('blocked');
    });
  });
});
