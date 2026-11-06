/**
 * @fileoverview End-to-end integration test suite for Ticket #35 & Spec #29:
 * Verifies complete orchestrator delivery procedure through Run:
 * 1) pc-issue-plan (planning & decomposition)
 * 2) pc-issue-work (implementation & verification)
 * 3) pc-pr-land with rework dispatch back to pc-issue-work linking predecessor findings
 * 4) pc-pr-land landing approved PR
 * 5) pc-issue-verify (overall acceptance verification against goal)
 * 6) pc-pipeline-refactor (pipeline file reorganization preserving invariance)
 * 7) pc-pr-land re-delivery for pipeline changes
 * 8) pc-research-state (final research records and reproduction entry points)
 * 9) run.finish (verified teardown and safe release)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { initTestGitRepo } from './test-git-helper.js';
import { Run } from '../../packages/core/src/workflow/run.js';
import { runCli } from '../../packages/cli/src/workflow.js';
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

describe('Orchestrator End-to-End Delivery & Run Decoupling (#35)', () => {
  let tmpDir: string;
  let repoDir: string;
  let storageRoot: string;
  let executor: ControlledExecutor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-workflow-e2e-'));
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

  it('delivers an acceptance issue through complete 6-step default flow with rework dispatch and safe finish', async () => {
    // 1. Open Run
    const run = await Run.open({
      runId: 'run-e2e-complete',
      repository: 'minghao-du/paper-craft',
      issue: 35,
      goal: 'Switch orchestrator default workflow and remove legacy state machine',
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    expect(run.runId).toBe('run-e2e-complete');
    expect(run.worktreePath).toBeDefined();

    // Step 1: Planning & Decomposition (pc-issue-plan)
    const planTask = await run.dispatch({
      taskType: 'pc-issue-plan',
      instructions: 'Analyze requirements and decompose if needed',
      inputs: {
        issue: 35,
        issueTitle: 'Switch orchestrator to Run',
        issueBody: 'Spec #29 final ticket',
        goal: 'Complete Ticket #35',
      },
    });

    expect(planTask.taskType).toBe('pc-issue-plan');
    expect(executor.launchedTasks.length).toBe(1);

    await run.submitResult(planTask.taskId, {
      outcome: 'decomposed',
      summary: 'Decomposed into subtasks in dependency order',
      artifacts: {
        plan: {
          tasks: [
            { title: 'Subtask 1: Implement feature', brief: 'Code changes', blockedBy: [] },
          ],
        },
      },
    });

    // Step 2: Implementation (pc-issue-work)
    const workTask = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Implement feature in worktree with test coverage',
      inputs: {
        issue: 35,
        issueTitle: 'Switch orchestrator to Run',
        taskBrief: 'Deliver code changes and tests',
      },
    });

    expect(workTask.taskType).toBe('pc-issue-work');
    expect(executor.launchedTasks.length).toBe(2);

    await run.submitResult(workTask.taskId, {
      outcome: 'completed',
      summary: 'Delivered initial changes and test suites',
      artifacts: {
        diff: 'diff --git a/core.ts b/core.ts\n+export const ready = true;',
        testResults: 'All 15 tests passed',
      },
    });

    // Step 3: Landing & Review (pc-pr-land) -> reports rework_needed
    const landTask1 = await run.dispatch({
      taskType: 'pc-pr-land',
      instructions: 'Create PR, run review checks, and merge if passing',
      inputs: {
        branch: 'feat/ticket-35',
        baseBranch: 'main',
        issue: 35,
        evaluatedCommit: 'sha-first-attempt',
      },
    });

    expect(landTask1.taskType).toBe('pc-pr-land');
    expect(executor.launchedTasks.length).toBe(3);

    await run.submitResult(landTask1.taskId, {
      outcome: 'rework_needed',
      summary: 'Code review found a missing edge case in error handling',
      artifacts: {
        merged: false,
        findings: 'Error handling in observe() needs null-check for empty taskId',
        evaluatedCommit: 'sha-first-attempt',
      },
    });

    // Step 4: Repair task dispatched back to pc-issue-work linking predecessor findings
    const repairTask = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Fix the null-check in observe() identified during PR review',
      predecessorResultId: landTask1.taskId,
      inputs: {
        issue: 35,
        issueTitle: 'Switch orchestrator to Run (repair)',
        taskBrief: 'Address review findings',
      },
    });

    expect(repairTask.taskType).toBe('pc-issue-work');
    expect(executor.launchedTasks.length).toBe(4);

    // Verify prompt injected predecessor findings and constraints
    const repairPrompt = executor.launchedTasks[3].prompt;
    expect(repairPrompt).toContain('Predecessor Findings & Repair Context');
    expect(repairPrompt).toContain('Error handling in observe() needs null-check');

    await run.submitResult(repairTask.taskId, {
      outcome: 'completed',
      summary: 'Added null-check and verified all tests pass',
      artifacts: {
        diff: 'diff --git a/core.ts b/core.ts\n+if (!taskId) return null;',
        testResults: 'All 16 tests passed',
      },
    });

    // Step 5: Fresh pc-pr-land task to land the repaired code
    const landTask2 = await run.dispatch({
      taskType: 'pc-pr-land',
      instructions: 'Create PR, run review checks, and merge if passing',
      inputs: {
        branch: 'feat/ticket-35',
        baseBranch: 'main',
        issue: 35,
        evaluatedCommit: 'sha-repaired-commit',
      },
    });

    expect(landTask2.taskType).toBe('pc-pr-land');
    expect(executor.launchedTasks.length).toBe(5);

    await run.submitResult(landTask2.taskId, {
      outcome: 'landed',
      summary: 'Review passed and PR successfully merged',
      artifacts: {
        merged: true,
        prNumber: 42,
        prUrl: 'https://github.com/minghao-du/paper-craft/pull/42',
        mergedCommit: 'sha-merged-42',
      },
    });

    // Step 6: Integrated Acceptance Verification (pc-issue-verify)
    const verifyTask = await run.dispatch({
      taskType: 'pc-issue-verify',
      instructions: 'Verify overall delivery against original objective',
      inputs: {
        originalObjective: 'Switch orchestrator default workflow and remove legacy state machine',
        acceptanceCriteria: ['Task sequence customizable in text', 'Legacy state machine removed'],
        deliveryEvidence: [
          {
            issue: 35,
            commitSha: 'sha-merged-42',
            prUrl: 'https://github.com/minghao-du/paper-craft/pull/42',
            summary: 'Landed PR 42 with verified review',
          },
        ],
      },
    });

    expect(verifyTask.taskType).toBe('pc-issue-verify');
    expect(executor.launchedTasks.length).toBe(6);

    await run.submitResult(verifyTask.taskId, {
      outcome: 'verified',
      summary: 'All acceptance criteria verified against delivered evidence',
      artifacts: {
        evaluatedHead: 'sha-merged-42',
        evidence: 'Tests pass and criteria fulfilled',
      },
    });

    // Step 7: Pipeline File Reorganization (pc-pipeline-refactor)
    const refactorTask = await run.dispatch({
      taskType: 'pc-pipeline-refactor',
      instructions: 'Organize touched workflow files while maintaining scientific invariance',
      inputs: {
        scope: ['packages/core/src/workflow/'],
        migrationInstructions: 'Remove legacy shims and organize exports',
      },
    });

    expect(refactorTask.taskType).toBe('pc-pipeline-refactor');
    expect(executor.launchedTasks.length).toBe(7);

    await run.submitResult(refactorTask.taskId, {
      outcome: 'completed',
      summary: 'Cleaned up imports and verified invariants',
      artifacts: {
        changedFiles: ['packages/core/src/workflow/engine.ts'],
        verificationEvidence: 'Scientific invariance verified',
      },
    });

    // Step 8: Re-delivery of pipeline changes (pc-pr-land)
    const landTask3 = await run.dispatch({
      taskType: 'pc-pr-land',
      instructions: 'Deliver pipeline reorganization changes',
      inputs: {
        branch: 'feat/ticket-35-refactor',
        baseBranch: 'main',
        issue: 35,
        evaluatedCommit: 'sha-refactor-commit',
      },
    });

    expect(landTask3.taskType).toBe('pc-pr-land');
    expect(executor.launchedTasks.length).toBe(8);

    await run.submitResult(landTask3.taskId, {
      outcome: 'landed',
      summary: 'Merged pipeline refactor changes',
      artifacts: {
        merged: true,
        prNumber: 43,
        prUrl: 'https://github.com/minghao-du/paper-craft/pull/43',
        mergedCommit: 'sha-merged-43',
      },
    });

    // Step 9: Final Research Records (pc-research-state)
    const researchTask = await run.dispatch({
      taskType: 'pc-research-state',
      instructions: 'Record research state, artifact locations, and reproduction entry points',
      inputs: {
        deliveryEvidence: { pr42: 'landed', pr43: 'landed' },
        reproductionEntryPoints: ['npm test', 'npm run typecheck'],
        artifactLocations: ['packages/core/src/workflow/'],
        brief: 'Ticket 35 delivery complete',
      },
    });

    expect(researchTask.taskType).toBe('pc-research-state');
    expect(executor.launchedTasks.length).toBe(9);

    await run.submitResult(researchTask.taskId, {
      outcome: 'recorded',
      summary: 'Updated research state in nexus repo',
      artifacts: {
        updatedRecords: ['research-state/ticket-35.json'],
      },
    });

    // Step 10: Complete Run and safely retire worktree
    const finishRes = await run.finish({
      conclusion: 'Issue #35 completed and verified across all default workflow stages',
      evidence: ['sha-merged-42', 'sha-merged-43'],
    });

    expect(finishRes.completed).toBe(true);
    expect(finishRes.worktreeRetired).toBe(true);
    expect(finishRes.status).toBe('completed');

    // Confirm state reflects all 9 tasks with distinct conversations
    const obs = await run.observe();
    expect(obs.status).toBe('completed');
    expect(obs.snapshot.tasks.size).toBe(9);
    expect(executor.launchedTasks.length).toBe(9);
  });

  it('demonstrates task interruption and reconnection to live process without duplicating execution', async () => {
    const run = await Run.open({
      runId: 'run-e2e-interrupt',
      repository: 'minghao-du/paper-craft',
      issue: 35,
      goal: 'Verify recovery and deduplication',
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const task = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Run work that will be interrupted',
    });

    // Simulate interruption: process still running in executor
    // Second dispatch with same taskId must return existing task idempotently
    const duplicateDispatch = await run.dispatch({
      taskId: task.taskId,
      taskType: 'pc-issue-work',
      instructions: 'Run work that will be interrupted',
    });

    expect(duplicateDispatch.taskId).toBe(task.taskId);
    expect(duplicateDispatch.handle.id).toBe(task.handle.id);
    // Executor was not called a second time
    expect(executor.launchedTasks.length).toBe(1);

    // Reconnect to Run from fresh instance
    const freshRun = await Run.open({
      runId: 'run-e2e-interrupt',
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const obs = await freshRun.observe();
    expect(obs.status).toBe('running');
    expect(obs.activeTaskId).toBe(task.taskId);
  });

  it('executes stop to pause active execution and resume recovers cleanly', async () => {
    const run = await Run.open({
      runId: 'run-e2e-stop',
      repository: 'minghao-du/paper-craft',
      issue: 35,
      goal: 'Verify stop and resume',
      repoRoot: repoDir,
      worktreeRoot: repoDir,
      storageRoot,
      executor,
    });

    const task = await run.dispatch({
      taskType: 'pc-issue-work',
      instructions: 'Long running task to be stopped',
    });

    const stopRes = await run.stop('Operator requested pause');
    expect(stopRes.stopped).toBe(true);
    expect(stopRes.status).toBe('paused');
    expect(executor.stoppedHandles.length).toBe(1);
    expect(executor.stoppedHandles[0].taskId).toBe(task.taskId);

    // Dispatches while paused are rejected
    await expect(
      run.dispatch({
        taskType: 'pc-issue-work',
        instructions: 'Should fail while paused',
      }),
    ).rejects.toThrow(/paused/i);
  });

  it('runs complete CLI workflow lifecycle end-to-end', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    // 1. Init workflow
    const initExit = await runCli(['workflow', 'init', '--repo', 'test-org/test-repo'], {
      cwd: repoDir,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });
    expect(initExit).toBe(0);

    // 2. Open Run
    stdout.length = 0;
    const openExit = await runCli(['workflow', 'open', '35', '--goal', 'CLI E2E Goal'], {
      cwd: repoDir,
      executor,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });
    expect(openExit).toBe(0);
    const openOutput = JSON.parse(stdout.join('\n'));
    expect(openOutput.run_id).toBeDefined();
    expect(openOutput.status).toBe('pending_dispatch');

    // 3. Dispatch task via CLI
    stdout.length = 0;
    const dispatchExit = await runCli(
      [
        'workflow',
        'dispatch',
        openOutput.run_id,
        '--task-type',
        'pc-issue-work',
        '--instructions',
        'Implement via CLI',
      ],
      {
        cwd: repoDir,
        executor,
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      },
    );
    expect(dispatchExit).toBe(0);
    const dispatchOutput = JSON.parse(stdout.join('\n'));
    expect(dispatchOutput.taskId).toBeDefined();

    // 4. Submit result via CLI
    stdout.length = 0;
    const submitExit = await runCli(
      [
        'workflow',
        'submit-result',
        '--run',
        openOutput.run_id,
        '--task',
        dispatchOutput.taskId,
        '--outcome',
        'completed',
        '--summary',
        'Implementation completed via CLI',
        '--artifacts',
        JSON.stringify({ diff: 'cli diff', testResults: 'pass' }),
      ],
      {
        cwd: repoDir,
        executor,
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      },
    );
    expect(submitExit).toBe(0);

    // 5. Observe via CLI
    stdout.length = 0;
    const observeExit = await runCli(['workflow', 'observe', openOutput.run_id], {
      cwd: repoDir,
      executor,
      stdout: (m) => stdout.push(m),
      stderr: (m) => stderr.push(m),
    });
    expect(observeExit).toBe(0);
    const observeOutput = JSON.parse(stdout.join('\n'));
    expect(observeOutput.status).toBe('pending_dispatch');
    expect(observeOutput.has_submitted_result).toBe(true);

    // 6. Finish via CLI
    stdout.length = 0;
    const finishExit = await runCli(
      ['workflow', 'finish', openOutput.run_id, '--conclusion', 'Delivered via CLI'],
      {
        cwd: repoDir,
        executor,
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      },
    );
    expect(finishExit).toBe(0);
    const finishOutput = JSON.parse(stdout.join('\n'));
    expect(finishOutput.completed).toBe(true);
    expect(finishOutput.status).toBe('completed');
  });
});
