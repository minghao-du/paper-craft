/**
 * @fileoverview Slim WorkflowEngine entrypoint delegating to Run.
 * Legacy state machines (computeNextStep, verifyMergePrerequisites, fixed step transition graph)
 * and legacy role branches (worker, review, merge, finalizer) have been completely removed.
 * All operations delegate directly to Run (Assignments, Execution, Worktree, RunState).
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  Run,
  type DispatchTaskParams,
  type DispatchSummary,
  type RunObservation,
  type SubmitResultSummary,
  type StopSummary,
  type FinishOptions,
  type FinishSummaryResult,
} from './run.js';
import { WorkflowFiles } from './files.js';
import { initWorkflowConfig } from './config.js';
import { WorkflowCleanupError, WorkflowOwnershipError } from './repository.js';
import type {
  AgentExecutor,
  InitOptions,
  RunContext,
  StatusOptions,
  TaskResult,
} from './types.js';
import type { RepositoryManager } from './repository.js';

export { WorkflowCleanupError, WorkflowOwnershipError };

export class WorkflowPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowPreflightError';
  }
}

export class WorkflowReviewInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowReviewInvalidatedError';
  }
}

export class WorkflowMergeVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowMergeVerificationError';
  }
}

/**
 * Constructor options for initializing the WorkflowEngine.
 */
export interface WorkflowEngineOptions {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Storage root directory for workflow durable state. */
  storageRoot?: string;
  /** Custom AgentExecutor instance (e.g. for testing with ControlledExecutor). */
  executor?: AgentExecutor;
  /** Optional RepositoryManager instance. */
  repositoryManager?: RepositoryManager;
}

/**
 * Start options for starting a workflow run.
 */
export interface StartRunOptions {
  issue: number;
  configPath?: string;
  provider?: string;
  goal?: string;
  requirements?: string;
  requirementsFile?: string;
}

/**
 * Slim WorkflowEngine delegating all execution and lifecycle to Run.
 */
export class WorkflowEngine {
  public readonly cwd: string;
  public readonly storageRoot?: string;
  public readonly executor?: AgentExecutor;
  public readonly repositoryManager?: RepositoryManager;
  private readonly files: WorkflowFiles;

  constructor(options?: WorkflowEngineOptions) {
    this.cwd = path.resolve(options?.cwd ?? process.cwd());
    this.storageRoot = options?.storageRoot ? path.resolve(options.storageRoot) : undefined;
    this.executor = options?.executor;
    this.repositoryManager = options?.repositoryManager;
    const resolvedStorage = this.storageRoot ?? path.join(this.cwd, '.paper-craft', 'cache');
    this.files = new WorkflowFiles(resolvedStorage);
  }

  /**
   * Scaffolds workflow configuration.
   */
  async init(options?: InitOptions): Promise<{ configPath: string }> {
    return initWorkflowConfig(this.cwd, options);
  }

  /**
   * Starts a new Run or attaches to an existing one via Run.open.
   */
  async start(options: StartRunOptions): Promise<RunContext> {
    let goal = options.goal ?? options.requirements;
    if (options.requirementsFile) {
      const resolvedReq = path.resolve(this.cwd, options.requirementsFile);
      goal = await fs.readFile(resolvedReq, 'utf8');
    }

    // Attempt to discover repository from .pc-workflow.yml if present
    let repository = '';
    try {
      const configPath = path.join(this.cwd, '.pc-workflow.yml');
      const raw = await fs.readFile(configPath, 'utf8');
      const match = raw.match(/repository:\s*([^\s\n]+)/);
      if (match) {
        repository = match[1];
      }
    } catch {
      // Ignored
    }

    const run = await Run.open({
      issue: options.issue,
      goal,
      repository,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      provider: options.provider,
      executor: this.executor,
    });

    const obs = await run.observe();

    return {
      run_id: run.runId,
      repository: obs.snapshot.repository ?? repository,
      issue: obs.snapshot.issue ?? options.issue,
      goal: obs.snapshot.goal ?? goal,
      status: obs.status,
      worktree_path: run.worktreePath,
      provider: obs.snapshot.provider ?? options.provider ?? 'agy',
      created_at: obs.snapshot.createdAt ?? new Date().toISOString(),
      current_step: 'run',
      rework_count: 0,
      shared_requirements: goal ?? '',
    } as unknown as RunContext;
  }

  /**
   * Observes status of a Run.
   */
  async status(runIdOrOptions?: string | StatusOptions): Promise<RunObservation & { run_id: string; current_step?: string; worktree_path?: string; issue?: number; repository?: string }> {
    let runId = typeof runIdOrOptions === 'string' ? runIdOrOptions : runIdOrOptions?.runId;
    if (!runId) {
      const runIds = await this.files.listRunIds();
      if (runIds.length === 0) {
        throw new Error('No workflow runs found.');
      }
      runIds.sort().reverse();
      runId = runIds[0];
    }

    const run = await Run.open({
      runId,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      executor: this.executor,
    });

    const obs = await run.observe();
    return {
      ...obs,
      run_id: obs.runId,
      current_step: 'run',
      worktree_path: obs.snapshot.worktreePath,
      issue: obs.snapshot.issue,
      repository: obs.snapshot.repository,
    };
  }

  /**
   * Dispatches a task through Run.
   */
  async dispatch(
    runId: string,
    instructionsOrParams: string | DispatchTaskParams,
    maybeParams?: Partial<DispatchTaskParams>,
  ): Promise<DispatchSummary & { step: string; role: string }> {
    const run = await Run.open({
      runId,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      executor: this.executor,
    });

    let dispatchParams: DispatchTaskParams;
    if (typeof instructionsOrParams === 'string') {
      dispatchParams = {
        taskType: 'pc-issue-work',
        instructions: instructionsOrParams,
        ...maybeParams,
      };
    } else {
      dispatchParams = instructionsOrParams;
    }

    const summary = await run.dispatch(dispatchParams);
    return {
      ...summary,
      step: summary.taskType,
      role: summary.taskType,
    };
  }

  /**
   * Submits a result for a task through Run.
   */
  async submitResult(
    runId: string,
    taskId: string,
    resultOrPayload: unknown,
  ): Promise<SubmitResultSummary & { outcome?: string; executionTerminated?: boolean }> {
    const run = await Run.open({
      runId,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      executor: this.executor,
    });

    const summary = await run.submitResult(taskId, resultOrPayload);
    return {
      ...summary,
      outcome: summary.result.outcome,
      executionTerminated: true,
    };
  }

  /**
   * Stops active executions on a Run.
   */
  async stop(options: { runId?: string; reason?: string }): Promise<StopSummary> {
    let runId = options.runId;
    if (!runId) {
      const runIds = await this.files.listRunIds();
      if (runIds.length === 0) {
        throw new Error('No workflow runs found.');
      }
      runIds.sort().reverse();
      runId = runIds[0];
    }

    const run = await Run.open({
      runId,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      executor: this.executor,
    });

    return run.stop(options.reason);
  }

  /**
   * Resumes and reconciles an existing Run.
   */
  async resume(runIdOrOptions?: string | { runId?: string; configPath?: string }): Promise<{
    runId: string;
    status: string;
    eventsCount: number;
    repository?: string;
    issue?: number;
    currentStep: string;
    worktreePath: string;
    reconciledTask?: { taskId: string; step: string; role: string; executionStatus: string; action: string; handle?: unknown; error?: string; result?: TaskResult };
    message?: string;
  }> {
    let runId = typeof runIdOrOptions === 'string' ? runIdOrOptions : runIdOrOptions?.runId;
    if (!runId) {
      const runIds = await this.files.listRunIds();
      if (runIds.length === 0) {
        throw new Error('No workflow runs found.');
      }
      runIds.sort().reverse();
      runId = runIds[0];
    }

    const run = await Run.open({
      runId,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      executor: this.executor,
    });

    const obs = await run.observe();
    return {
      runId: run.runId,
      status: obs.status,
      eventsCount: obs.snapshot.eventsCount,
      repository: obs.snapshot.repository,
      issue: obs.snapshot.issue,
      currentStep: 'run',
      worktreePath: run.worktreePath,
      message: 'Run observed and reconciled.',
    };
  }

  /**
   * Releases run resources and completes the Run.
   */
  async releaseRunResources(runId: string): Promise<{ released: boolean; runId: string; status: string }> {
    const run = await Run.open({
      runId,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      executor: this.executor,
    });

    const res = await run.finish({
      conclusion: 'Run released through WorkflowEngine',
    });

    return {
      runId: res.runId,
      released: res.worktreeRetired,
      status: res.status,
    };
  }

  /**
   * Finishes Run with conclusion and evidence.
   */
  async finish(runId: string, options: FinishOptions): Promise<FinishSummaryResult> {
    const run = await Run.open({
      runId,
      repoRoot: this.cwd,
      storageRoot: this.storageRoot,
      executor: this.executor,
    });

    return run.finish(options);
  }
}
