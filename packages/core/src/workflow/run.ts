/**
 * @fileoverview Run entrypoint facade.
 * Coordinates Assignments, Execution, Worktree, and RunState submodules.
 * Exposes open, dispatch, observe, and submitResult.
 * Does not contain hardcoded step transition state machines or automatic next step selection.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentExecutor,
  ExecutionHandle,
  RunStatus,
  TaskResult,
} from './types.js';
import { createAgentExecutor } from './executor.js';
import { Assignments, type PredecessorBinding } from './assignments.js';
import { Execution, type ExecutionObservation } from './execution.js';
import { Worktree } from './worktree.js';
import { RunState, type RunSnapshot } from './run-state.js';

/**
 * Options for opening or attaching to a Run.
 */
export interface OpenRunOptions {
  /** Unique Run identifier. Auto-generated if omitted. */
  runId?: string;
  /** GitHub repository in owner/repo format. */
  repository?: string;
  /** Target GitHub issue number. */
  issue?: number;
  /** Storage root directory for durable state and events. */
  storageRoot?: string;
  /** Base git repository root directory. Defaults to cwd. */
  repoRoot?: string;
  /** Working directory. Defaults to repoRoot or cwd. */
  cwd?: string;
  /** Root directory for placing worktrees. */
  worktreeRoot?: string;
  /** Explicit worktree directory path override. */
  worktreePath?: string;
  /** Target Git branch name. */
  branchName?: string;
  /** Designated provider identifier (e.g. 'agy'). Defaults to 'agy'. */
  provider?: string;
  /** Custom AgentExecutor instance (e.g. for testing with ControlledExecutor). */
  executor?: AgentExecutor;
}

/**
 * Parameters for dispatching an isolated task.
 */
export interface DispatchTaskParams {
  /** Task identifier override. Auto-generated if omitted. */
  taskId?: string;
  /** Formal task type identifier (e.g. 'pc-issue-work'). */
  taskType: string;
  /** Specific instructions and objectives for the task. */
  instructions: string;
  /** Task inputs to bind into the assignment. */
  inputs?: Record<string, unknown>;
  /** Dedicated worktree path override (defaults to Run's worktree). */
  worktreePath?: string;
  /** Explicit predecessor task identifier to link findings from (for rework/repair). */
  predecessorResultId?: string;
}

/**
 * Summary returned upon successful dispatch.
 */
export interface DispatchSummary {
  /** Stable task identifier. */
  taskId: string;
  /** Provider execution handle. */
  handle: ExecutionHandle;
  /** Formal task type. */
  taskType: string;
  /** Execution status (initially 'running'). */
  status: 'running';
  /** Path to the assigned worktree. */
  worktreePath: string;
}

/**
 * Observation returned by Run.observe.
 * Distinguishes provider execution status from domain business conclusion.
 */
export interface RunObservation {
  /** Unique Run identifier. */
  runId: string;
  /** Overall Run lifecycle status. */
  status: RunStatus;
  /** Active or last dispatched task identifier. */
  activeTaskId?: string;
  /** Low-level process execution observation from Execution submodule. */
  execution?: ExecutionObservation;
  /** Validated business result if submitted. */
  result?: TaskResult;
  /** Whether a validated business result has been submitted. */
  hasSubmittedResult: boolean;
  /** Full durable RunSnapshot. */
  snapshot: RunSnapshot;
}

/**
 * Summary returned upon successful result submission.
 */
export interface SubmitResultSummary {
  /** Whether submission was acknowledged and validated. */
  acknowledged: boolean;
  /** Task identifier bound to the result. */
  taskId: string;
  /** Normalized, conforming TaskResult. */
  result: TaskResult;
}

/**
 * Facade coordinating Run lifecycle and delegation across submodules:
 * Assignments, Execution, Worktree, and RunState.
 */
export class Run {
  public readonly runId: string;
  public readonly worktreePath: string;
  public readonly assignments: Assignments;
  public readonly execution: Execution;
  public readonly worktree: Worktree;
  public readonly state: RunState;

  private constructor(params: {
    runId: string;
    worktreePath: string;
    assignments: Assignments;
    execution: Execution;
    worktree: Worktree;
    state: RunState;
  }) {
    this.runId = params.runId;
    this.worktreePath = params.worktreePath;
    this.assignments = params.assignments;
    this.execution = params.execution;
    this.worktree = params.worktree;
    this.state = params.state;
  }

  /**
   * Opens an existing Run or allocates and initializes a new Run.
   */
  static async open(options: OpenRunOptions): Promise<Run> {
    const cwd = path.resolve(options.repoRoot ?? options.cwd ?? process.cwd());
    const runId = options.runId ?? `run-${Date.now()}`;
    const storageRoot = options.storageRoot
      ? path.resolve(options.storageRoot)
      : path.join(cwd, '.paper-craft', 'cache');

    const state = new RunState(storageRoot);
    const worktree = new Worktree(cwd);

    // Prepare or verify worktree with 1.0 owner marker
    const wtInfo = await worktree.prepare(runId, {
      worktreePath: options.worktreePath,
      worktreeRoot: options.worktreeRoot,
      branchName: options.branchName,
      repository: options.repository,
    });

    // Create or attach to Run in durable state
    let snapshot: RunSnapshot;
    try {
      snapshot = await state.read(runId);
    } catch {
      snapshot = await state.apply(runId, {
        type: 'create_run',
        context: {
          runId,
          repository: options.repository,
          issue: options.issue,
          worktreePath: wtInfo.worktreePath,
          provider: options.provider ?? 'agy',
        },
      });
    }

    const assignments = new Assignments();
    const executor =
      options.executor ??
      createAgentExecutor(options.provider ?? snapshot.provider ?? 'agy');
    const execution = new Execution(executor);

    return new Run({
      runId,
      worktreePath: wtInfo.worktreePath,
      assignments,
      execution,
      worktree,
      state,
    });
  }

  /**
   * Dispatches an isolated task:
   * 1. Prepares assignment with pinned contract and injected identity
   * 2. Writes task initialization file in worktree
   * 3. Records dispatch intent in durable RunState before external process launch
   * 4. Spawns fresh agent conversation via Execution submodule
   * 5. Confirms launch in RunState and returns DispatchSummary
   */
  async dispatch(params: DispatchTaskParams): Promise<DispatchSummary> {
    const taskId =
      params.taskId ?? `${this.runId}-${params.taskType}-${Date.now()}`;
    const targetWorktree = params.worktreePath ?? this.worktreePath;

    const snapshot = await this.state.read(this.runId);

    // Explicit predecessor result linking (does not default to latest result)
    const predecessorResultId =
      params.predecessorResultId ??
      (params.inputs?.predecessorResultId as string | undefined);

    let predecessorBinding: PredecessorBinding | undefined;

    if (predecessorResultId) {
      const predResult = snapshot.results.get(predecessorResultId);
      const predTask = snapshot.tasks.get(predecessorResultId);

      if (!predResult && !params.inputs?.findings) {
        throw new Error(
          `Cannot link predecessor result: Predecessor task "${predecessorResultId}" not found in Run "${this.runId}".`,
        );
      }

      const findings =
        (params.inputs?.findings as string | undefined) ??
        (predResult?.artifacts?.findings as string | undefined) ??
        predResult?.summary ??
        '';

      const previousHeadSha =
        (params.inputs?.previousHeadSha as string | undefined) ??
        (predResult?.artifacts?.evaluatedCommit as string | undefined) ??
        (predResult?.artifacts?.reviewed_commit as string | undefined) ??
        (predResult?.artifacts?.commitSha as string | undefined) ??
        (predResult?.artifacts?.diff as string | undefined) ??
        (predTask?.inputs?.evaluatedCommit as string | undefined);

      const originalConstraints =
        (params.inputs?.originalConstraints as string[] | string | undefined) ??
        (predTask?.inputs?.constraints as string[] | string | undefined) ??
        (predTask?.inputs?.originalConstraints as string[] | string | undefined) ??
        (predTask?.inputs?.sharedRequirements as string | undefined);

      predecessorBinding = {
        predecessorResultId,
        findings,
        previousHeadSha,
        originalConstraints,
      };
    }

    // 1. Prepare assignment
    const prepared = this.assignments.prepare({
      runId: this.runId,
      taskId,
      taskType: params.taskType,
      worktreePath: targetWorktree,
      instructions: params.instructions,
      inputs: params.inputs,
      predecessor: predecessorBinding,
    });

    // 2. Write initialization file in worktree
    await fs.mkdir(targetWorktree, { recursive: true });
    await fs.writeFile(
      path.join(targetWorktree, 'initialization.json'),
      JSON.stringify(prepared.initializationPayload, null, 2),
      'utf8',
    );

    // 3. Atomically record dispatch intent before launch
    await this.state.apply(this.runId, {
      type: 'dispatch_intent',
      taskId,
      taskType: params.taskType,
      prompt: prepared.prompt,
      worktreePath: targetWorktree,
      inputs: params.inputs,
    });

    // 4. Launch fresh conversation
    let handle: ExecutionHandle;
    try {
      handle = await this.execution.start(taskId, targetWorktree, prepared.prompt);
    } catch (err) {
      await this.state.apply(this.runId, {
        type: 'task_launch_failed',
        taskId,
        error: (err as Error).message,
      });
      throw err;
    }

    // 5. Confirm launch in RunState
    await this.state.apply(this.runId, {
      type: 'task_launched',
      taskId,
      handle,
    });

    return {
      taskId,
      handle,
      taskType: params.taskType,
      status: 'running',
      worktreePath: targetWorktree,
    };
  }

  /**
   * Observes current Run and execution status.
   * Execution status is reported distinctly from business conclusions.
   * Auto-detects and accepts result.json in worktree if present.
   */
  async observe(taskId?: string): Promise<RunObservation> {
    const snapshot = await this.state.read(this.runId);
    const targetTaskId = taskId ?? snapshot.activeTaskId ?? snapshot.lastTaskId;

    if (!targetTaskId) {
      return {
        runId: this.runId,
        status: snapshot.status,
        hasSubmittedResult: false,
        snapshot,
      };
    }

    const executionObs = await this.execution.inspect(targetTaskId);

    // Check if result already submitted in durable state
    let result = snapshot.results.get(targetTaskId);

    // If no submitted result yet, check if worker wrote result.json in worktree
    if (!result) {
      const task = snapshot.tasks.get(targetTaskId);
      const wt = task?.worktreePath ?? this.worktreePath;
      const resultPath = path.join(wt, 'result.json');
      try {
        const rawResult = await fs.readFile(resultPath, 'utf8');
        const parsed = JSON.parse(rawResult);
        const subResult = await this.submitResult(targetTaskId, parsed);
        result = subResult.result;
      } catch {
        // result.json not written or not ready yet
      }
    }

    return {
      runId: this.runId,
      status: snapshot.status,
      activeTaskId: snapshot.activeTaskId,
      execution: executionObs,
      result,
      hasSubmittedResult: Boolean(result),
      snapshot,
    };
  }

  /**
   * Validates and records a task result submission.
   * Rejects missing required artifacts or disallowed outcomes.
   */
  async submitResult(taskId: string, rawResult: unknown): Promise<SubmitResultSummary> {
    const snapshot = await this.state.read(this.runId);
    const task = snapshot.tasks.get(taskId);
    if (!task) {
      throw new Error(`Cannot submit result: Task "${taskId}" not found in Run "${this.runId}".`);
    }

    const validation = this.assignments.validate(task.taskType, rawResult);
    if (!validation.valid || !validation.normalizedResult) {
      throw new Error(
        `Result validation failed for task "${taskId}": ${validation.errors?.join('; ') ?? 'Unknown validation error'}`,
      );
    }

    await this.state.apply(this.runId, {
      type: 'result_submitted',
      taskId,
      result: validation.normalizedResult,
    });

    return {
      acknowledged: true,
      taskId,
      result: validation.normalizedResult,
    };
  }
}
