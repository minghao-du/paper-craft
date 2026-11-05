import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../packages/cli/src/workflow.js';
import { WorkflowEngine } from '../../packages/core/src/workflow/engine.js';
import type { AgentExecutor, ExecutionHandle, ExecutionInspection, IssueChecker, ProviderChecker } from '../../packages/core/src/workflow/types.js';

class MockCliExecutor implements AgentExecutor {
  public launchedTasks: string[] = [];

  async check(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async launch(taskId: string): Promise<ExecutionHandle> {
    this.launchedTasks.push(taskId);
    return { id: `cli-handle-${taskId}`, taskId };
  }

  async inspect(taskId: string): Promise<ExecutionInspection> {
    return { status: 'running', handle: { id: `cli-handle-${taskId}`, taskId } };
  }

  async send(): Promise<void> {}

  async stop(): Promise<{ stopped: boolean }> {
    return { stopped: true };
  }
}

describe('Workflow CLI dispatch & submit-result (Ticket #3)', () => {
  let tmpDir: string;
  let mockExecutor: MockCliExecutor;
  let mockEngine: WorkflowEngine;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-cli-dispatch-'));
    mockExecutor = new MockCliExecutor();

    const mockIssueChecker: IssueChecker = {
      checkIssue: async (_repo, issue) => ({
        exists: true,
        open: true,
        title: `Issue #${issue}`,
      }),
    };
    const mockProviderChecker: ProviderChecker = {
      check: async () => ({ available: true }),
    };

    mockEngine = new WorkflowEngine({
      cwd: tmpDir,
      executor: mockExecutor,
      issueChecker: mockIssueChecker,
      providerChecker: mockProviderChecker,
    });

    await mockEngine.init({ repository: 'org/repo' });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('runs dispatch command via CLI', async () => {
    const run = await mockEngine.start({ issue: 77 });

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      [
        'workflow',
        'dispatch',
        '--run',
        run.run_id,
        '--instructions',
        'Implement feature 77 cleanly',
      ],
      {
        cwd: tmpDir,
        engine: mockEngine,
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.length).toBe(0);

    const output = JSON.parse(stdout.join('\n'));
    expect(output.taskId).toBeDefined();
    expect(output.step).toBe('implementation');
    expect(output.role).toBe('worker');
    expect(mockExecutor.launchedTasks.length).toBe(1);
  });

  it('fails dispatch when instructions are missing', async () => {
    const run = await mockEngine.start({ issue: 78 });

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['workflow', 'dispatch', '--run', run.run_id], {
      cwd: tmpDir,
      engine: mockEngine,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Task instructions are required');
  });

  it('runs submit-result command via CLI', async () => {
    const run = await mockEngine.start({ issue: 79 });
    const dispatchRes = await mockEngine.dispatch(run.run_id, 'Do work');

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      [
        'workflow',
        'submit-result',
        '--run',
        run.run_id,
        '--task',
        dispatchRes.taskId,
        '--outcome',
        'completed',
        '--summary',
        'Implemented feature 79',
        '--artifacts',
        JSON.stringify({ diff: 'diff content', test_results: 'pass' }),
      ],
      {
        cwd: tmpDir,
        engine: mockEngine,
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.length).toBe(0);

    const output = JSON.parse(stdout.join('\n'));
    expect(output.acknowledged).toBe(true);
    expect(output.outcome).toBe('completed');
    expect(output.executionTerminated).toBe(true);
  });

  it('fails submit-result on validation failure (missing required artifacts)', async () => {
    const run = await mockEngine.start({ issue: 80 });
    const dispatchRes = await mockEngine.dispatch(run.run_id, 'Do work');

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      [
        'workflow',
        'submit-result',
        '--run',
        run.run_id,
        '--task',
        dispatchRes.taskId,
        '--outcome',
        'completed',
        '--summary',
        'Implemented feature 80',
        '--artifacts',
        JSON.stringify({ diff: 'diff only' }), // missing test_results
      ],
      {
        cwd: tmpDir,
        engine: mockEngine,
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('missing required artifact');
  });

  it('runs release command via CLI to release resources', async () => {
    const run = await mockEngine.start({ issue: 81 });

    // Emulate completed finalization with release_evidence in events log
    await mockEngine.appendEvent(run.run_id, {
      type: 'result_submitted',
      run_id: run.run_id,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-final-81',
        step: 'finalization',
        role: 'finalizer',
        outcome: 'completed',
        summary: 'Final records preserved',
        artifacts: {
          release_evidence: { preserved: true },
        },
      },
    });

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['workflow', 'release', run.run_id], {
      cwd: tmpDir,
      engine: mockEngine,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    });

    expect(exitCode).toBe(0);
    expect(stderr.length).toBe(0);

    const output = JSON.parse(stdout.join('\n'));
    expect(output.released).toBe(true);
    expect(output.status).toBe('completed');
  });
});
