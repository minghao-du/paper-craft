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
  /** Overall Run objective or goal. */
  goal?: string;
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
  /** If true, force re-allocating/preparing the git worktree even if the Run is already completed. */
  reallocateWorktree?: boolean;
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
 * Summary returned upon stopping a Run.
 */
export interface StopSummary {
  /** Unique Run identifier. */
  runId: string;
  /** Whether all target executions were stopped successfully. */
  stopped: boolean;
  /** Resulting Run lifecycle status. */
  status: RunStatus;
  /** Reason for stopping if provided. */
  reason?: string;
  /** Handles that were verified terminated. */
  terminatedHandles: ExecutionHandle[];
  /** True if execution termination status was uncertain. */
  uncertain?: boolean;
  /** Error message if stopping failed. */
  error?: string;
}

/**
 * Options for completing and finalizing a Run.
 */
export interface FinishOptions {
  /** Overall Run conclusion or delivery summary. */
  conclusion: string;
  /** Evidence references (commit shas, PR links, test reports). */
  evidence?: string[];
}

/**
 * Result returned upon finishing and releasing a Run.
 */
export interface FinishSummaryResult {
  /** Unique Run identifier. */
  runId: string;
  /** Whether finish and resource release succeeded. */
  completed: boolean;
  /** Overall conclusion accepted. */
  conclusion: string;
  /** Associated evidence links. */
  evidence: string[];
  /** Whether the dedicated worktree was safely retired. */
  worktreeRetired: boolean;
  /** Path to the worktree directory. */
  worktreePath: string;
  /** Resulting Run lifecycle status. */
  status: RunStatus;
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

    // Read existing durable state if available
    let snapshot: RunSnapshot | null = null;
    try {
      snapshot = await state.read(runId);
    } catch (err) {
      if ((err as Error).message?.includes('Legacy workflow state detected')) {
        throw err;
      }
      if (!(err as Error).message?.includes('not found or missing event log')) {
        throw err;
      }
      // New run
    }

    let worktreePath = options.worktreePath ?? snapshot?.worktreePath;
    if (snapshot?.status === 'completed' && !options.reallocateWorktree) {
      // Completed run: worktree was retired; do not unconditionally recreate git worktree
      if (!worktreePath) {
        worktreePath = path.join(cwd, '.paper-craft', 'worktrees', runId);
      }
    } else {
      // Prepare or verify worktree with 1.0 owner marker
      const wtInfo = await worktree.prepare(runId, {
        worktreePath,
        worktreeRoot: options.worktreeRoot,
        branchName: options.branchName,
        repository: options.repository ?? snapshot?.repository,
      });
      worktreePath = wtInfo.worktreePath;
    }

    if (!snapshot) {
      snapshot = await state.apply(runId, {
        type: 'create_run',
        context: {
          runId,
          repository: options.repository,
          issue: options.issue,
          goal: options.goal,
          worktreePath,
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
      worktreePath,
      assignments,
      execution,
      worktree,
      state,
    });
  }

  /**
   * Records or updates the orchestrator's task plan.
   */
  async recordPlan(plan: unknown): Promise<RunSnapshot> {
    return await this.state.apply(this.runId, {
      type: 'record_plan',
      plan,
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

    // Check existing state for deduplication and recovery
    const snapshot = await this.state.read(this.runId);
    const existingTask = snapshot.tasks.get(taskId);

    if (existingTask) {
      if (
        existingTask.taskType !== params.taskType ||
        (existingTask.worktreePath && existingTask.worktreePath !== targetWorktree)
      ) {
        throw new Error(
          `Task "${taskId}" already exists with different parameters. Conflicting dispatch rejected.`,
        );
      }

      // Case A: Task already has confirmed handle and is running
      if (existingTask.handle && existingTask.status === 'running') {
        return {
          taskId,
          handle: existingTask.handle,
          taskType: existingTask.taskType,
          status: 'running',
          worktreePath: existingTask.worktreePath ?? targetWorktree,
        };
      }

      // Case B: Lost launch confirmation window or reconnection check
      const inspection = await this.execution.inspect(taskId);
      if (inspection.isUncertain || inspection.status === 'uncertain') {
        throw new Error(
          `Cannot dispatch task "${taskId}": execution status is uncertain (${inspection.error ?? 'unconfirmed provider status'}). Blind restart prevented.`,
        );
      }

      if (inspection.status === 'running' || inspection.status === 'exited') {
        const handle =
          inspection.handle ??
          existingTask.handle ?? { id: `handle-${taskId}`, taskId };
        await this.state.apply(this.runId, {
          type: 'task_launched',
          taskId,
          handle,
        });
        return {
          taskId,
          handle,
          taskType: existingTask.taskType,
          status: 'running',
          worktreePath: existingTask.worktreePath ?? targetWorktree,
        };
      }
    }

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

    const task = snapshot.tasks.get(targetTaskId);
    const wt = task?.worktreePath ?? this.worktreePath;
    const executionObs = await this.execution.inspect(targetTaskId, wt);

    // Check if result already submitted in durable state
    let result = snapshot.results.get(targetTaskId);

    // If no submitted result yet, check if execution observed a valid raw receipt
    if (!result && executionObs.rawReceipt) {
      try {
        const subResult = await this.submitResult(targetTaskId, executionObs.rawReceipt);
        result = subResult.result;
      } catch {
        // Raw receipt was invalid or could not be submitted
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

  /**
   * Stops active executions and pauses the Run:
   * 1. Stops running executions via Execution.stop() and confirms termination.
   * 2. Records task_terminated and stop_requested in durable state.
   * 3. Prevents subsequent task dispatches while paused.
   */
  async stop(reason?: string): Promise<StopSummary> {
    const snapshot = await this.state.read(this.runId);
    if (snapshot.status === 'completed') {
      throw new Error(`Cannot stop Run "${this.runId}": Run is already completed.`);
    }

    const terminatedHandles: ExecutionHandle[] = [];
    let isUncertain = false;
    let stopError: string | undefined;

    // Collect active handles to stop
    const handlesToStop: Array<{ taskId: string; handle: ExecutionHandle }> = [];
    if (snapshot.activeTaskId && snapshot.activeHandle) {
      handlesToStop.push({ taskId: snapshot.activeTaskId, handle: snapshot.activeHandle });
    }
    for (const [taskId, task] of snapshot.tasks) {
      if (
        (task.status === 'running' || task.status === 'pending') &&
        task.handle &&
        !handlesToStop.some((h) => h.handle.id === task.handle?.id)
      ) {
        handlesToStop.push({ taskId, handle: task.handle });
      }
    }

    for (const item of handlesToStop) {
      const stopResult = await this.execution.stop(item.handle);
      if (stopResult.stopped) {
        terminatedHandles.push(item.handle);
        await this.state.apply(this.runId, {
          type: 'task_terminated',
          taskId: item.taskId,
          handle: item.handle,
          stopped: true,
        });
      } else {
        if (stopResult.uncertain) {
          isUncertain = true;
        }
        stopError = stopResult.error ?? 'Execution stop could not be verified.';
        await this.state.apply(this.runId, {
          type: 'task_terminated',
          taskId: item.taskId,
          handle: item.handle,
          stopped: false,
        });
      }
    }

    const updatedSnapshot = await this.state.apply(this.runId, {
      type: 'stop_requested',
      reason,
      uncertain: isUncertain,
    });

    return {
      runId: this.runId,
      stopped: !isUncertain && !stopError,
      status: updatedSnapshot.status,
      reason,
      terminatedHandles,
      uncertain: isUncertain,
      error: stopError,
    };
  }

  /**
   * Completes the Run and releases its resources:
   * 1. Verifies all executions are terminated.
   * 2. Inspects worktree ownership and checks for uncommitted changes (dirty check).
   * 3. Safely retires worktree via Worktree.retire.
   * 4. Persists run_finished in durable state with conclusion and evidence links.
   * 5. Supports repeatable, idempotent calls without failing.
   */
  async finish(
    conclusionOrOptions: string | FinishOptions,
    maybeEvidence?: string[],
  ): Promise<FinishSummaryResult> {
    const conclusion =
      typeof conclusionOrOptions === 'string'
        ? conclusionOrOptions
        : conclusionOrOptions.conclusion;
    const evidence = Array.isArray(maybeEvidence)
      ? maybeEvidence
      : typeof conclusionOrOptions === 'object'
        ? conclusionOrOptions.evidence ?? []
        : [];

    const snapshot = await this.state.read(this.runId);

    // 1. If already completed, return idempotent finish summary
    if (snapshot.status === 'completed') {
      return {
        runId: this.runId,
        completed: true,
        conclusion: snapshot.finishConclusion ?? conclusion,
        evidence: snapshot.finishEvidence ?? evidence,
        worktreeRetired: true,
        worktreePath: this.worktreePath,
        status: 'completed',
      };
    }

    // 2. Verify all tasks are terminated / non-active
    if (snapshot.activeTaskId) {
      const obs = await this.execution.inspect(snapshot.activeTaskId);
      if (obs.status === 'running' || obs.isUncertain) {
        throw new Error(
          `Cannot finish Run "${this.runId}": Task "${snapshot.activeTaskId}" is still active (status: ${obs.status}).`,
        );
      }
    }

    for (const [taskId, task] of snapshot.tasks) {
      if (task.status === 'running' || task.status === 'pending') {
        const obs = await this.execution.inspect(taskId);
        if (obs.status === 'running' || obs.isUncertain) {
          throw new Error(
            `Cannot finish Run "${this.runId}": Task "${taskId}" is still active (status: ${obs.status}).`,
          );
        }
      }
      if (task.status === 'uncertain') {
        throw new Error(
          `Cannot finish Run "${this.runId}": Task "${taskId}" has unconfirmed or uncertain status.`,
        );
      }
    }

    // 3. Inspect worktree: verify existence, version 1.0 owner marker matching runId, and dirty check
    const retireResult = await this.worktree.retire(this.worktreePath, this.runId);
    if (!retireResult.retired) {
      throw new Error(
        `Cannot finish Run "${this.runId}": Worktree retirement failed: ${retireResult.error ?? 'Unknown error'}`,
      );
    }

    // 4. Atomically persist run_finished in RunState
    const updated = await this.state.apply(this.runId, {
      type: 'run_finished',
      conclusion,
      evidence,
    });

    return {
      runId: this.runId,
      completed: true,
      conclusion,
      evidence,
      worktreeRetired: true,
      worktreePath: this.worktreePath,
      status: updated.status,
    };
  }
}
