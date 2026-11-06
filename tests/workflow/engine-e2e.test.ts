/**
 * @fileoverview End-to-end integration test suite for Ticket #8:
 * Verify complete delivery and recovery with deterministic execution.
 * Retains routine deterministic tests without live model calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkflowEngine } from '../../packages/core/src/workflow/engine.js';
import { runCli } from '../../packages/cli/src/workflow.js';
import {
  RepositoryManager,
  type CheckMergeStatusOptions,
} from '../../packages/core/src/workflow/repository.js';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
  IssueCheckResult,
  MergeStatusResult,
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

class ControlledRepositoryManager extends RepositoryManager {
  public headSha = 'commit-approved-8a8b8c';
  public state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN';
  public merged = false;
  public mergeCommitSha?: string;
  public exists = true;
  public error?: string;

  override async checkIssue(issue: number): Promise<IssueCheckResult> {
    return {
      exists: true,
      open: true,
      title: `Designated Acceptance Issue #${issue}`,
    };
  }

  override async checkMergeStatus(
    _prOrIssue: number | string,
    expectedHeadShaOrOptions?: string | CheckMergeStatusOptions,
    _maybeOptions?: CheckMergeStatusOptions,
  ): Promise<MergeStatusResult> {
    if (this.error) {
      return { exists: false, error: this.error };
    }
    let expectedHeadSha: string | undefined;
    if (typeof expectedHeadShaOrOptions === 'string') {
      expectedHeadSha = expectedHeadShaOrOptions;
    } else if (typeof expectedHeadShaOrOptions === 'object') {
      expectedHeadSha = expectedHeadShaOrOptions.expectedHeadSha;
    }

    const matchesExpectedHead =
      expectedHeadSha !== undefined ? this.headSha === expectedHeadSha : undefined;

    return {
      exists: this.exists,
      headSha: this.headSha,
      state: this.state,
      merged: this.merged,
      mergeCommitSha: this.mergeCommitSha,
      matchesExpectedHead,
    };
  }
}

describe('Workflow MVP End-to-End Lifecycle & Recovery Verification (Ticket #8)', () => {
  let tmpDir: string;
  let executor: ControlledExecutor;
  let repositoryManager: ControlledRepositoryManager;
  let engine: WorkflowEngine;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-workflow-e2e-'));
    executor = new ControlledExecutor();
    repositoryManager = new ControlledRepositoryManager();

    engine = new WorkflowEngine({
      cwd: tmpDir,
      executor,
      repositoryManager,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('delivers an acceptance issue through complete lifecycle: worker -> review -> merge interruption & resume -> finalization & resource release', async () => {
    // 1. Initialization
    const initRes = await engine.init({
      repository: 'minghao-du/paper-craft',
      provider: 'agy',
    });
    expect(initRes.configPath).toBe(path.join(tmpDir, '.pc-workflow.yml'));

    // 2. Start Run with immutable requirements
    const sharedRequirements = 'Verify complete delivery and recovery with real agy (Ticket #8).';
    const run = await engine.start({
      issue: 8,
      requirements: sharedRequirements,
    });

    expect(run.run_id).toBeDefined();
    expect(run.status).toBe('pending_dispatch');
    expect(run.current_step).toBe('implementation');
    expect(run.worktree_path).toBe(path.join(tmpDir, '.worktrees', 'issue-8'));

    // Verify worktree ownership safeguard
    const ownerFile = path.join(run.worktree_path, '.pc-execution-owner');
    expect(await fs.stat(ownerFile).then(() => true)).toBe(true);
    const ownerContent = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
    expect(ownerContent.run_id).toBe(run.run_id);
    expect(ownerContent.issue).toBe(8);

    // 3. Worker Implementation: Scheduling Context & Dispatch
    const workerContext = await engine.getSchedulingContext(run.run_id);
    expect(workerContext.currentStep).toBe('implementation');
    expect(workerContext.stepDefinition.role).toBe('worker');
    expect(workerContext.roleContract.skill).toBe('pc-issue-work');
    expect(workerContext.roleContract.permitted_outcomes).toContain('completed');
    expect(workerContext.roleContract.required_artifacts).toEqual(['diff', 'test_results']);
    expect(workerContext.sharedRequirements).toBe(sharedRequirements);

    const workerDispatch = await engine.dispatch(
      run.run_id,
      'Implement Issue #8 changes according to acceptance criteria',
    );
    expect(workerDispatch.taskId).toBeDefined();
    expect(workerDispatch.step).toBe('implementation');
    expect(workerDispatch.role).toBe('worker');
    expect(executor.launchedTasks.length).toBe(1);

    // Verify task initialization context written to worktree
    const initFile = path.join(run.worktree_path, 'initialization.json');
    expect(await fs.stat(initFile).then(() => true)).toBe(true);
    const initContent = JSON.parse(await fs.readFile(initFile, 'utf8'));
    expect(initContent.run_id).toBe(run.run_id);
    expect(initContent.task_id).toBe(workerDispatch.taskId);
    expect(initContent.shared_requirements).toBe(sharedRequirements);

    // Worker submissions: missing required artifacts rejected
    await expect(
      engine.submitResult(run.run_id, workerDispatch.taskId, {
        outcome: 'completed',
        summary: 'Incomplete implementation',
        artifacts: { diff: 'some diff' }, // missing test_results
      }),
    ).rejects.toThrow('missing required artifact(s): test_results');

    // Valid worker submission
    const workerResult = await engine.submitResult(run.run_id, workerDispatch.taskId, {
      outcome: 'completed',
      summary: 'Implemented end-to-end changes with all checks passing',
      artifacts: {
        diff: 'diff --git a/e2e.ts b/e2e.ts\n+e2e test verified',
        test_results: 'All 98 test suites passed',
      },
    });

    expect(workerResult.acknowledged).toBe(true);
    expect(workerResult.executionTerminated).toBe(true);
    expect(workerResult.nextStep).toBe('review');
    expect(workerResult.transitionStatus).toBe('running');

    // 4. Reviewer Evaluation: Scheduling Context & Dispatch
    const reviewContext = await engine.getSchedulingContext(run.run_id);
    expect(reviewContext.currentStep).toBe('review');
    expect(reviewContext.stepDefinition.role).toBe('reviewer');
    expect(reviewContext.roleContract.skill).toBe('pc-pr-review');
    expect(reviewContext.roleContract.required_artifacts).toEqual(['reviewed_commit', 'findings']);

    const reviewDispatch = await engine.dispatch(
      run.run_id,
      'Review worker diff and test results against criteria',
    );
    expect(reviewDispatch.step).toBe('review');
    expect(reviewDispatch.role).toBe('reviewer');

    // Reviewer approves revision with pass
    const approvedSha = 'commit-approved-8a8b8c';
    const reviewResult = await engine.submitResult(run.run_id, reviewDispatch.taskId, {
      outcome: 'pass',
      summary: 'Reviewed and approved changes. All acceptance criteria satisfied.',
      artifacts: {
        reviewed_commit: approvedSha,
        findings: 'Clean implementation, no defects detected.',
      },
    });

    expect(reviewResult.acknowledged).toBe(true);
    expect(reviewResult.executionTerminated).toBe(true);
    expect(reviewResult.nextStep).toBe('merge');

    // 5. Interruption & Resume during Merge step
    const mergeContext = await engine.getSchedulingContext(run.run_id);
    expect(mergeContext.currentStep).toBe('merge');
    expect(mergeContext.stepDefinition.role).toBe('merger');
    expect(mergeContext.priorEvidence?.evaluatedCommit).toBe(approvedSha);

    // Merge prerequisite verification passes because PR head matches evaluated commit
    repositoryManager.headSha = approvedSha;
    const mergePrereq = await engine.verifyMergePrerequisites(run.run_id);
    expect(mergePrereq.valid).toBe(true);
    expect(mergePrereq.approvedCommit).toBe(approvedSha);

    // Dispatch merger task
    const mergerDispatch = await engine.dispatch(
      run.run_id,
      `Merge reviewed revision ${approvedSha} into main`,
    );
    expect(mergerDispatch.step).toBe('merge');
    expect(mergerDispatch.role).toBe('merger');
    const mergerTaskId = mergerDispatch.taskId;

    // Simulate interruption: merger execution in-flight, engine process restarts
    // External GitHub confirms PR was merged with squash commit
    repositoryManager.state = 'MERGED';
    repositoryManager.merged = true;
    repositoryManager.mergeCommitSha = 'commit-merged-squash-9d9e9f';

    // Resume execution
    const resumeRes = await engine.resume(run.run_id);
    expect(resumeRes.runId).toBe(run.run_id);
    expect(resumeRes.reconciledTask).toBeDefined();
    expect(resumeRes.reconciledTask?.taskId).toBe(mergerTaskId);
    expect(resumeRes.reconciledTask?.step).toBe('merge');
    expect(resumeRes.reconciledTask?.action).toBe('collected');
    expect(resumeRes.currentStep).toBe('finalization');
    expect(resumeRes.message).toContain('Reconciled external merge outcome');

    // Verify no duplicate tasks were dispatched
    expect(executor.launchedTasks.filter((t) => t.taskId === mergerTaskId).length).toBe(1);

    // 6. Finalization: Preservation & Resource Release
    const finalContext = await engine.getSchedulingContext(run.run_id);
    expect(finalContext.currentStep).toBe('finalization');
    expect(finalContext.stepDefinition.role).toBe('finalizer');
    expect(finalContext.roleContract.skill).toBe('pc-pr-land');
    expect(finalContext.roleContract.required_artifacts).toEqual(['release_evidence']);

    // Finalizer inherits all accumulated evidence
    expect(finalContext.mergedCommit).toBe('commit-merged-squash-9d9e9f');
    expect(finalContext.evaluatedCommit).toBe(approvedSha);
    expect(finalContext.sharedRequirements).toBe(sharedRequirements);

    const finalizerDispatch = await engine.dispatch(
      run.run_id,
      'Preserve final delivery records and generate release evidence',
    );
    expect(finalizerDispatch.step).toBe('finalization');

    // Finalizer submits completed result with release evidence
    const finalSubmit = await engine.submitResult(run.run_id, finalizerDispatch.taskId, {
      outcome: 'completed',
      summary: 'Preserved delivery records and created git bundle archive.',
      artifacts: {
        release_evidence: {
          preserved: true,
          bundle: 'paper-craft-issue-8.bundle',
          bundleSha: 'bundle-sha256-verified-12345',
        },
      },
    });

    expect(finalSubmit.acknowledged).toBe(true);
    expect(finalSubmit.nextStep).toBe('completed');
    expect(finalSubmit.transitionStatus).toBe('completed');

    // 7. Verify Resource Release & Complete Run State
    const finalStatus = await engine.status(run.run_id);
    expect(finalStatus.status).toBe('completed');
    expect(finalStatus.step).toBe('completed');

    // Physical worktree has been cleanly deleted
    const worktreeExists = await fs.stat(run.worktree_path).then(() => true).catch(() => false);
    expect(worktreeExists).toBe(false);

    // All execution handles were terminated
    expect(executor.stoppedHandles.length).toBeGreaterThanOrEqual(4);

    // 8. Idempotent Release on Completed Run
    const repeatedRelease = await engine.releaseRunResources(run.run_id);
    expect(repeatedRelease.released).toBe(true);
    expect(repeatedRelease.status).toBe('completed');
    expect(repeatedRelease.worktreeRemoved).toBe(false); // already removed
  });

  it('demonstrates task interruption and reconnection to live process without duplicating execution', async () => {
    await engine.init({ repository: 'minghao-du/paper-craft' });
    const run = await engine.start({ issue: 88 });

    const dispatch = await engine.dispatch(run.run_id, 'Start in-flight task');
    expect(dispatch.taskId).toBeDefined();

    // The task is still running in provider
    executor.taskStatuses.set(dispatch.taskId, 'running');

    // Process restarts and invokes resume
    const freshEngine = new WorkflowEngine({
      cwd: tmpDir,
      executor,
      repositoryManager,
    });

    const resumeRes = await freshEngine.resume(run.run_id);
    expect(resumeRes.reconciledTask?.taskId).toBe(dispatch.taskId);
    expect(resumeRes.reconciledTask?.executionStatus).toBe('running');
    expect(resumeRes.reconciledTask?.action).toBe('reconnected');
    expect(resumeRes.message).toContain(`Reconnected to running execution for task "${dispatch.taskId}"`);

    // No duplicate task was launched
    expect(executor.launchedTasks.length).toBe(1);
  });

  it('executes stop to pause active execution and resume recovers cleanly', async () => {
    await engine.init({ repository: 'minghao-du/paper-craft' });
    const run = await engine.start({ issue: 89 });

    const dispatch = await engine.dispatch(run.run_id, 'Run task to be stopped');
    expect(executor.taskStatuses.get(dispatch.taskId)).toBe('running');

    // Stop execution
    const stopRes = await engine.stop({
      runId: run.run_id,
      reason: 'Testing manual pause and termination',
    });

    expect(stopRes.stopped).toBe(true);
    expect(stopRes.status).toBe('paused');
    expect(stopRes.terminatedHandles.length).toBe(1);
    expect(executor.taskStatuses.get(dispatch.taskId)).toBe('exited');

    // Check status reflects paused state
    const status = await engine.status(run.run_id);
    expect(status.status).toBe('paused');

    // Resume recovers the paused state
    const resumeRes = await engine.resume(run.run_id);
    expect(resumeRes.runId).toBe(run.run_id);
    expect(resumeRes.currentStep).toBe('implementation');
  });

  it('runs complete CLI workflow lifecycle end-to-end', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const runCmd = async (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      stdout.length = 0;
      stderr.length = 0;
      const code = await runCli(argv, {
        cwd: tmpDir,
        engine,
        stdout: (msg) => stdout.push(msg),
        stderr: (msg) => stderr.push(msg),
      });
      return {
        code,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
      };
    };

    // 1. init
    const initRes = await runCmd(['workflow', 'init', '--repo', 'minghao-du/paper-craft']);
    expect(initRes.code).toBe(0);
    expect(initRes.stdout).toContain('Initialized workflow configuration');

    // 2. start
    const startRes = await runCmd([
      'workflow',
      'start',
      '8',
      '--requirements',
      'CLI End-to-End Delivery Verification',
    ]);
    expect(startRes.code).toBe(0);
    const startPayload = JSON.parse(startRes.stdout);
    const runId = startPayload.run_id;
    expect(runId).toBeDefined();

    // 3. status with positional runId
    const statusRes = await runCmd(['workflow', 'status', runId]);
    expect(statusRes.code).toBe(0);
    const statusPayload = JSON.parse(statusRes.stdout);
    expect(statusPayload.run_id).toBe(runId);
    expect(statusPayload.status).toBe('pending_dispatch');

    // 4. dispatch worker
    const dispatchRes = await runCmd([
      'workflow',
      'dispatch',
      runId,
      '--instructions',
      'Implement changes for issue 8 via CLI',
    ]);
    expect(dispatchRes.code).toBe(0);
    const dispatchPayload = JSON.parse(dispatchRes.stdout);
    const taskId = dispatchPayload.taskId;
    expect(taskId).toBeDefined();

    // 5. submit-result worker
    const submitRes = await runCmd([
      'workflow',
      'submit-result',
      '--run',
      runId,
      '--task',
      taskId,
      '--outcome',
      'completed',
      '--summary',
      'Worker completed implementation',
      '--artifacts',
      JSON.stringify({ diff: 'cli diff', test_results: 'cli passed' }),
    ]);
    expect(submitRes.code).toBe(0);

    // 6. stop command
    const stopRes = await runCmd(['workflow', 'stop', runId, '--reason', 'Operator inspection']);
    expect(stopRes.code).toBe(0);
    const stopPayload = JSON.parse(stopRes.stdout);
    expect(stopPayload.status).toBe('paused');

    // 7. resume command
    const resumeRes = await runCmd(['workflow', 'resume', runId]);
    expect(resumeRes.code).toBe(0);
    const resumePayload = JSON.parse(resumeRes.stdout);
    expect(resumePayload.run_id).toBe(runId);
    expect(resumePayload.step).toBe('review');
  });
});
