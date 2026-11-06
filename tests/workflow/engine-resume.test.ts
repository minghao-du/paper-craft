import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkflowEngine, WorkflowOwnershipError } from '../../packages/core/src/workflow/engine.js';
import { runCli } from '../../packages/cli/src/workflow.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  IssueChecker,
  RunEvent,
} from '../../packages/core/src/workflow/types.js';

/**
 * Controlled in-memory AgentExecutor for testing interruption windows and recovery.
 */
class ResumeTestMockExecutor implements AgentExecutor {
  public available = true;
  public launchedTasks: Array<{ taskId: string; workingDirectory: string; prompt: string }> = [];
  public inspectResults = new Map<string, ExecutionInspection>();
  public inspectErrors = new Map<string, string>();
  public stoppedHandles: ExecutionHandle[] = [];

  async check(): Promise<{ available: boolean }> {
    return { available: this.available };
  }

  async launch(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle> {
    this.launchedTasks.push({ taskId, workingDirectory, prompt });
    const handle: ExecutionHandle = { id: `handle-${taskId}`, taskId };
    this.inspectResults.set(taskId, { status: 'running', handle });
    return handle;
  }

  async inspect(taskId: string): Promise<ExecutionInspection> {
    const errorMsg = this.inspectErrors.get(taskId);
    if (errorMsg) {
      throw new Error(errorMsg);
    }
    const res = this.inspectResults.get(taskId);
    if (!res) {
      return { status: 'not_started' };
    }
    return res;
  }

  async send(): Promise<void> {}

  async stop(handle: ExecutionHandle): Promise<{ stopped: boolean }> {
    this.stoppedHandles.push(handle);
    const existing = this.inspectResults.get(handle.taskId);
    if (existing) {
      existing.status = 'exited';
    }
    return { stopped: true };
  }
}

describe('WorkflowEngine Resume & Reconciliation (Ticket #5)', () => {
  let tmpDir: string;
  let mockExecutor: ResumeTestMockExecutor;
  let mockIssueChecker: IssueChecker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-resume-test-'));
    mockExecutor = new ResumeTestMockExecutor();

    mockIssueChecker = {
      checkIssue: async (_repo: string, issue: number) => ({
        exists: true,
        open: true,
        title: `Issue #${issue} for resume tests`,
      }),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createInitializedEngine(): Promise<WorkflowEngine> {
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      issueChecker: mockIssueChecker,
      executor: mockExecutor,
    });
    await engine.init({ repository: 'test-owner/test-repo' });
    return engine;
  }

  describe('Reconstructing progress solely from durable events.jsonl', () => {
    it('reconstructs state strictly from event log without a second authoritative file', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({
        issue: 501,
        requirements: 'Must maintain 100% test coverage.',
      });

      const runDir = path.join(tmpDir, '.paper-craft', 'runs', run.run_id);
      const filesInRunDir = await fs.readdir(runDir);
      // Ensure ONLY events.jsonl is authoritative in the run directory
      expect(filesInRunDir).toEqual(['events.jsonl']);

      const resumed = await engine.resume(run.run_id);
      expect(resumed.runId).toBe(run.run_id);
      expect(resumed.status).toBe('pending_dispatch');
      expect(resumed.currentStep).toBe('implementation');
      expect(resumed.schedulingContext.sharedRequirements).toBe('Must maintain 100% test coverage.');
      expect(resumed.schedulingContext.roleContract.skill).toBe('pc-issue-work');
    });

    it('uses captured Run definitions even if configuration files are modified or deleted', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({
        issue: 502,
        requirements: 'Strict requirements snapshot.',
      });

      // Deliberately delete the workflow configuration file on disk
      await fs.unlink(path.join(tmpDir, '.pc-workflow.yml'));

      // Resume must still succeed by relying on snapshot in events.jsonl
      const resumed = await engine.resume(run.run_id);
      expect(resumed.runId).toBe(run.run_id);
      expect(resumed.repository).toBe('test-owner/test-repo');
      expect(resumed.schedulingContext.sharedRequirements).toBe('Strict requirements snapshot.');
      expect(resumed.schedulingContext.stepDefinition.role).toBe('worker');
    });
  });

  describe('Interruption after dispatch_intent (before launch)', () => {
    it('inspects by stable taskId, detects not started, does not blindly launch replacement', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 503 });

      // Simulate crash right after dispatch_intent was written to events.jsonl
      const taskId = `task-${run.run_id}-implementation-0-abc123`;
      const intentEvent: RunEvent = {
        type: 'dispatch_intent',
        run_id: run.run_id,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: 'implementation',
          role: 'worker',
          skill: 'pc-issue-work',
          taskInstructions: 'Implement something',
          inputs: {},
          worktreePath: run.worktree_path,
        },
      };
      await engine.appendEvent(run.run_id, intentEvent);

      // Executor inspects taskId -> not_started (launch was never called)
      mockExecutor.inspectResults.set(taskId, { status: 'not_started' });

      const resumed = await engine.resume(run.run_id);

      expect(resumed.runId).toBe(run.run_id);
      expect(resumed.reconciledTask?.taskId).toBe(taskId);
      expect(resumed.reconciledTask?.executionStatus).toBe('not_started');
      expect(resumed.reconciledTask?.action).toBe('none');

      // CRITICAL: Ensure engine did NOT blindly launch a replacement
      expect(mockExecutor.launchedTasks.length).toBe(0);
      expect(resumed.schedulingContext.activeTaskId).toBe(taskId);
      expect(resumed.schedulingContext.activeHandle).toBeUndefined();
    });
  });

  describe('Interruption after launch succeeded, but before handle recording', () => {
    it('reconnects to running execution by stable taskId and captures handle', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 504 });

      const taskId = `task-${run.run_id}-implementation-0-xyz789`;
      const intentEvent: RunEvent = {
        type: 'dispatch_intent',
        run_id: run.run_id,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: 'implementation',
          role: 'worker',
          skill: 'pc-issue-work',
          taskInstructions: 'Implement something',
          inputs: {},
          worktreePath: run.worktree_path,
        },
      };
      await engine.appendEvent(run.run_id, intentEvent);

      // Simulate: provider launch succeeded and process is running with handle,
      // but crash occurred before engine could write task_launched event!
      const unrecordedHandle: ExecutionHandle = {
        id: 'external-provider-handle-999',
        taskId,
      };
      mockExecutor.inspectResults.set(taskId, {
        status: 'running',
        handle: unrecordedHandle,
      });

      const resumed = await engine.resume(run.run_id);

      expect(resumed.runId).toBe(run.run_id);
      expect(resumed.status).toBe('running');
      expect(resumed.reconciledTask?.taskId).toBe(taskId);
      expect(resumed.reconciledTask?.executionStatus).toBe('running');
      expect(resumed.reconciledTask?.action).toBe('reconnected');
      expect(resumed.reconciledTask?.handle?.id).toBe('external-provider-handle-999');

      // Scheduling context now carries the recovered handle
      expect(resumed.schedulingContext.activeTaskId).toBe(taskId);
      expect(resumed.schedulingContext.activeHandle?.id).toBe('external-provider-handle-999');

      // Verify task_reconciled event was persisted to durable log
      const events = await engine.readEvents(run.run_id);
      const reconciledEvt = events.find((e) => e.type === 'task_reconciled');
      expect(reconciledEvt).toBeDefined();
      expect((reconciledEvt?.payload as { action: string }).action).toBe('reconnected');

      // CRITICAL: Did NOT blindly launch a second execution
      expect(mockExecutor.launchedTasks.length).toBe(0);
    });
  });

  describe('Collecting completed task results on resume', () => {
    it('reconnects and collects completed task result when task finished before interruption', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 505 });
      const dispatch = await engine.dispatch(run.run_id, 'Instructions');

      // Specialist finished and submitted result
      await engine.submitResult(run.run_id, dispatch.taskId, {
        outcome: 'completed',
        summary: 'Work finished cleanly',
        artifacts: { diff: 'some-diff', test_results: 'pass' },
      });

      // Resume
      const resumed = await engine.resume(run.run_id);

      expect(resumed.reconciledTask?.taskId).toBe(dispatch.taskId);
      expect(resumed.reconciledTask?.action).toBe('collected');
      expect(resumed.reconciledTask?.result?.outcome).toBe('completed');
      expect(resumed.schedulingContext.latestResult?.outcome).toBe('completed');
    });

    it('reports exited status when process exited without submitting result without blindly restarting', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 506 });
      const dispatch = await engine.dispatch(run.run_id, 'Instructions');

      // Process exited without submitting result
      mockExecutor.inspectResults.set(dispatch.taskId, {
        status: 'exited',
        handle: dispatch.handle,
        exitCode: 1,
      });

      const resumed = await engine.resume(run.run_id);

      expect(resumed.reconciledTask?.taskId).toBe(dispatch.taskId);
      expect(resumed.reconciledTask?.executionStatus).toBe('exited');
      expect(resumed.reconciledTask?.result).toBeUndefined();
      // Must not blindly restart
      expect(mockExecutor.launchedTasks.length).toBe(1); // Only the initial dispatch
    });
  });

  describe('Uncertain execution reconciliation', () => {
    it('represents unreconciled execution as uncertainty and never assumes not started', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 507 });
      const dispatch = await engine.dispatch(run.run_id, 'Do work');

      // Provider inspector returns uncertain or throws communication error
      mockExecutor.inspectResults.set(dispatch.taskId, {
        status: 'uncertain',
        handle: dispatch.handle,
        error: 'Connection timeout to provider daemon',
      });

      const resumed = await engine.resume(run.run_id);

      expect(resumed.status).toBe('uncertain');
      expect(resumed.reconciledTask?.action).toBe('uncertain');
      expect(resumed.reconciledTask?.executionStatus).toBe('uncertain');
      expect(resumed.reconciledTask?.error).toContain('Connection timeout');

      // CRITICAL: Did NOT blindly launch a replacement task
      expect(mockExecutor.launchedTasks.length).toBe(1);

      // Verify event log has uncertainty recorded
      const events = await engine.readEvents(run.run_id);
      expect(events.some((e) => e.type === 'run_uncertain' || e.type === 'task_reconciled')).toBe(true);
    });

    it('treats inspection exception as uncertainty rather than unstarted', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 508 });
      const dispatch = await engine.dispatch(run.run_id, 'Do work');

      mockExecutor.inspectErrors.set(dispatch.taskId, 'Provider process table unreachable');

      const resumed = await engine.resume(run.run_id);

      expect(resumed.status).toBe('uncertain');
      expect(resumed.reconciledTask?.action).toBe('uncertain');
      expect(resumed.reconciledTask?.executionStatus).toBe('uncertain');
      expect(resumed.reconciledTask?.error).toContain('Provider process table unreachable');
      expect(mockExecutor.launchedTasks.length).toBe(1);
    });

    it('flags launched task as uncertain when provider inspector returns not_started across a fresh process', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 516 });
      const dispatch = await engine.dispatch(run.run_id, 'Do work');

      // Task was launched (task_launched event is in log).
      // Now simulate a fresh process where executor has no in-memory record and returns not_started.
      mockExecutor.inspectResults.set(dispatch.taskId, {
        status: 'not_started',
      });

      const resumed = await engine.resume(run.run_id);

      // Must be flagged uncertain, NOT assumed not_started
      expect(resumed.status).toBe('uncertain');
      expect(resumed.reconciledTask?.action).toBe('uncertain');
      expect(resumed.reconciledTask?.executionStatus).toBe('uncertain');
      expect(resumed.reconciledTask?.error).toContain('previously launched');

      // CRITICAL: Did NOT blindly launch a replacement task
      expect(mockExecutor.launchedTasks.length).toBe(1);
    });

    it('reports not_started when task had only dispatch_intent without task_launched', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 517 });

      // Append dispatch_intent manually without task_launched to simulate crash before launch
      const taskId = 'task-interrupted-before-launch';
      await engine.appendEvent(run.run_id, {
        type: 'dispatch_intent',
        run_id: run.run_id,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: 'implementation',
          role: 'worker',
          skill: 'pc-issue-work',
          taskInstructions: 'Do work',
          inputs: {},
          worktreePath: run.worktree_path,
        },
      });

      mockExecutor.inspectResults.set(taskId, {
        status: 'not_started',
      });

      const resumed = await engine.resume(run.run_id);

      // Truly not started because launch never completed
      expect(resumed.reconciledTask?.executionStatus).toBe('not_started');
      expect(resumed.reconciledTask?.action).toBe('none');
      expect(resumed.schedulingContext.activeTaskId).toBe(taskId);
      expect(resumed.schedulingContext.activeHandle).toBeUndefined();
    });
  });

  describe('Result persistence and repeated submission safeguards', () => {
    it('allows identical repeated submission idempotently after interruption', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 509 });
      const dispatch = await engine.dispatch(run.run_id, 'Do work');

      const payload = {
        outcome: 'completed',
        summary: 'Done with work',
        artifacts: { diff: 'diff', test_results: 'pass' },
      };

      const res1 = await engine.submitResult(run.run_id, dispatch.taskId, payload);
      expect(res1.acknowledged).toBe(true);

      // Worker retries exact same submission (e.g. after network glitch or interruption)
      const res2 = await engine.submitResult(run.run_id, dispatch.taskId, payload);
      expect(res2.acknowledged).toBe(true);
      expect(res2.idempotent).toBe(true);
    });

    it('rejects conflicting repeated submission for the same taskId', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 510 });
      const dispatch = await engine.dispatch(run.run_id, 'Do work');

      await engine.submitResult(run.run_id, dispatch.taskId, {
        outcome: 'completed',
        summary: 'Original outcome',
        artifacts: { diff: 'diff-1', test_results: 'pass' },
      });

      // Different outcome/summary for same task
      await expect(
        engine.submitResult(run.run_id, dispatch.taskId, {
          outcome: 'blocked',
          summary: 'Conflicting claim',
          artifacts: { diff: 'diff-2', test_results: 'fail' },
        }),
      ).rejects.toThrow(/Conflicting result submitted for task/);
    });
  });

  describe('Worktree ownership safeguards during resume', () => {
    it('rejects resume when worktree has conflicting ownership belonging to another run', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 511 });

      // Overwrite worktree owner marker with another runId
      const ownerMarkerPath = path.join(run.worktree_path, '.pc-execution-owner');
      await fs.writeFile(
        ownerMarkerPath,
        JSON.stringify({ run_id: 'other-foreign-run-999', claimed_at: new Date().toISOString() }),
        'utf8',
      );

      await expect(engine.resume(run.run_id)).rejects.toThrow(WorkflowOwnershipError);
    });

    it('maintains and restores ownership marker when valid or missing', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 512 });

      // Delete owner marker to test restoration
      const ownerMarkerPath = path.join(run.worktree_path, '.pc-execution-owner');
      await fs.unlink(ownerMarkerPath);

      const resumed = await engine.resume(run.run_id);
      expect(resumed.runId).toBe(run.run_id);

      const ownerRaw = await fs.readFile(ownerMarkerPath, 'utf8');
      const ownerData = JSON.parse(ownerRaw);
      expect(ownerData.run_id).toBe(run.run_id);
    });
  });

  describe('CLI resume command', () => {
    it('executes pc workflow resume <runId> and prints clean structured json', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 513 });
      await engine.dispatch(run.run_id, 'Instructions');

      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await runCli(['workflow', 'resume', '--run', run.run_id], {
        cwd: tmpDir,
        engine,
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      });

      expect(exitCode).toBe(0);
      expect(stderr.length).toBe(0);

      const output = JSON.parse(stdout.join('\n'));
      expect(output.run_id).toBe(run.run_id);
      expect(output.status).toBe('running');
      expect(output.step).toBe('implementation');
      expect(output.reconciled_task).toBeDefined();
    });

    it('supports pc workflow recover as an alias for resume', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 514 });

      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await runCli(['workflow', 'recover', run.run_id], {
        cwd: tmpDir,
        engine,
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      });

      expect(exitCode).toBe(0);
      expect(stderr.length).toBe(0);

      const output = JSON.parse(stdout.join('\n'));
      expect(output.run_id).toBe(run.run_id);
      expect(output.status).toBe('pending_dispatch');
    });

    it('defaults to latest run when runId is omitted', async () => {
      const engine = await createInitializedEngine();
      const run = await engine.start({ issue: 515 });

      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await runCli(['workflow', 'resume'], {
        cwd: tmpDir,
        engine,
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      });

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout.join('\n'));
      expect(output.run_id).toBe(run.run_id);
    });
  });
});
