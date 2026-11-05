/**
 * @fileoverview Encapsulates single task preparation, launch, execution inspection,
 * and handle recording for the Workflow Engine.
 */

import type {
  AgentExecutor,
  DispatchResult,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
  ExecutionStopResult,
  PriorEvidence,
  RoleContract,
  RunContext,
  RunEvent,
  TaskResult,
  WorkflowStep,
} from './types.js';
import type { WorkflowFiles, WorktreeOwnerMarker } from './files.js';

/**
 * Result returned by TaskExecution after stopping active executions.
 */
export interface ExecutionTeardownResult {
  /** Whether all target executions were stopped successfully. */
  stopped: boolean;
  /** True if execution termination status was uncertain. */
  uncertain?: boolean;
  /** Handles that were successfully stopped. */
  terminatedHandles: ExecutionHandle[];
  /** Error message if stopping failed. */
  error?: string;
}

/**
 * Options for ensuring execution processes are stopped.
 */
export interface EnsureStoppedOptions {
  /** If specified, only stop executions associated with this taskId. */
  taskId?: string;
  /** If true, stops all handles regardless of prior termination events (useful during finalization release). */
  all?: boolean;
  /** If true, records task_terminated events for stopped handles (defaults to true when only active handles are stopped). */
  recordTerminated?: boolean;
}

/**
 * Facts returned by TaskExecution after inspecting and reconciling a task execution.
 */
export interface TaskReconciliationResult {
  /** Task identifier. */
  taskId: string;
  /** Step associated with the task. */
  step: string;
  /** Role executing the task. */
  role: string;
  /** Execution handle if active or recovered. */
  handle?: ExecutionHandle;
  /** Execution process status. */
  executionStatus: ExecutionStatus;
  /** Reconciliation action taken. */
  action: 'collected' | 'reconnected' | 'uncertain' | 'none';
  /** Recorded task result if already submitted. */
  result?: TaskResult;
  /** Error details if reconciliation failed or is uncertain. */
  error?: string;
  /** True if execution status could not be verified with certainty. */
  isUncertain?: boolean;
}

/**
 * Options for initializing TaskExecution.
 */
export interface TaskExecutionOptions {
  /** The files manager for persisting task files and events. */
  files: WorkflowFiles;
  /** The agent executor for launching and inspecting provider executions. */
  executor: AgentExecutor;
}

/**
 * Parameters required to dispatch a specialist task.
 */
export interface TaskDispatchParams {
  /** Unique Run identifier. */
  runId: string;
  /** Stable task identifier. */
  taskId: string;
  /** Active workflow step name. */
  step: string;
  /** Specialist role assigned to the step. */
  role: string;
  /** Canonical skill invoked by this role. */
  skill: string;
  /** Specific task instructions from operator. */
  taskInstructions: string;
  /** Immutable shared requirements for the Run. */
  sharedRequirements?: string;
  /** Worktree directory path. */
  worktreePath: string;
  /** Target repository in owner/repo format. */
  repository: string;
  /** Target issue number. */
  issue: number;
  /** Outcomes permitted by the role contract. */
  permittedOutcomes: string[];
  /** Artifact keys required by the role contract. */
  requiredArtifacts?: string[];
  /** Prior review findings or evaluated commits. */
  priorEvidence?: PriorEvidence;
  /** Accumulated delivery artifacts. */
  deliveryArtifacts?: Record<string, unknown>;
  /** Optional caller-supplied inputs. */
  inputs?: Record<string, unknown>;
}

/**
 * Parameters for recording and persisting a specialist role's submitted result.
 */
export interface RecordTaskResultParams {
  /** Unique Run identifier. */
  runId: string;
  /** Stable task identifier. */
  taskId: string;
  /** The submitted task result facts. */
  result: TaskResult;
  /** Optional role contract for validating permitted outcomes and required artifacts. */
  roleContract?: RoleContract;
  /** Optional workflow step definition for validating outcome transitions. */
  stepDefinition?: WorkflowStep;
}

/**
 * Facts returned by TaskExecution after associating, validating, persisting the result,
 * and terminating the executor process.
 */
export interface TaskExecutionResultFacts {
  /** Whether the submission was acknowledged. */
  acknowledged: boolean;
  /** Task identifier bound to the result. */
  taskId: string;
  /** Run identifier. */
  runId: string;
  /** Workflow step at the time of submission. */
  step: string;
  /** Role that executed the task. */
  role: string;
  /** Submitted outcome string. */
  outcome: string;
  /** Summary of the result. */
  summary: string;
  /** Captured artifacts dictionary. */
  artifacts: Record<string, unknown>;
  /** Whether execution termination was verified. */
  executionTerminated: boolean;
  /** Worktree directory path for the task. */
  worktreePath: string;
  /** Active execution handle if present. */
  handle?: ExecutionHandle;
  /** True if this was an idempotent resubmission of an identical result. */
  idempotent?: boolean;
}

/**
 * Encapsulates single task preparation, dispatch intent logging,
 * process launching, handle recording, and execution inspection.
 * TaskExecution returns task facts and never makes Run progression decisions.
 */
export class TaskExecution {
  private readonly files: WorkflowFiles;
  private readonly executor: AgentExecutor;

  constructor(options: TaskExecutionOptions) {
    this.files = options.files;
    this.executor = options.executor;
  }

  /**
   * Dispatches a single task:
   * 1. Prepares worktree files (.pc-execution-owner and initialization.json).
   * 2. Composes worker prompt.
   * 3. Records dispatch_intent event BEFORE external launch.
   * 4. Launches agent executor process.
   * 5. Records task_launched event with handle upon success, or task_launch_failed on error.
   * 6. Returns task facts (DispatchResult).
   *
   * @param params Parameters specifying task context and instructions.
   * @returns DispatchResult containing task facts.
   */
  async dispatch(params: TaskDispatchParams): Promise<DispatchResult> {
    const nowIso = new Date().toISOString();

    // 1. Prepare dedicated worktree files via WorkflowFiles
    const ownerMarker: WorktreeOwnerMarker = {
      run_id: params.runId,
      repository: params.repository,
      issue: params.issue,
      task_id: params.taskId,
      role: params.role,
      claimed_at: nowIso,
    };

    const initData: Record<string, unknown> = {
      run_id: params.runId,
      task_id: params.taskId,
      role: params.role,
      step: params.step,
      skill: params.skill,
      checkout: params.worktreePath,
      repository: params.repository,
      issue: params.issue,
      shared_requirements: params.sharedRequirements ?? '',
      task_instructions: params.taskInstructions,
      inputs: {
        ...(params.priorEvidence ? { prior_evidence: params.priorEvidence } : {}),
        ...(params.deliveryArtifacts ? { delivery_artifacts: params.deliveryArtifacts } : {}),
        ...(params.inputs ?? {}),
      },
      permitted_outcomes: params.permittedOutcomes,
      required_artifacts: params.requiredArtifacts ?? [],
      prior_evidence: params.priorEvidence,
      delivery_artifacts: params.deliveryArtifacts,
    };

    await this.files.prepareTaskFiles(params.worktreePath, ownerMarker, initData);

    // 2. Compose worker prompt
    const prompt = this.composeWorkerPrompt(params);

    // 3. Persist dispatch intent event BEFORE launch
    const intentEvent: RunEvent = {
      type: 'dispatch_intent',
      run_id: params.runId,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: params.taskId,
        step: params.step,
        role: params.role,
        skill: params.skill,
        taskInstructions: params.taskInstructions,
        inputs: params.inputs ?? {},
        priorEvidence: params.priorEvidence,
        deliveryArtifacts: params.deliveryArtifacts,
        worktreePath: params.worktreePath,
      },
    };
    await this.files.record(params.runId, intentEvent);

    // 4. Launch execution via provider Executor
    let handle: ExecutionHandle;
    try {
      handle = await this.executor.launch(params.taskId, params.worktreePath, prompt);
    } catch (err) {
      const launchErrEvent: RunEvent = {
        type: 'task_launch_failed',
        run_id: params.runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId: params.taskId,
          error: (err as Error).message,
        },
      };
      await this.files.record(params.runId, launchErrEvent);
      throw err;
    }

    // 5. Persist task_launched event recording the provider handle
    const launchedEvent: RunEvent = {
      type: 'task_launched',
      run_id: params.runId,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: params.taskId,
        step: params.step,
        role: params.role,
        handle,
        launchedAt: new Date().toISOString(),
      },
    };
    await this.files.record(params.runId, launchedEvent);

    // 6. Return task facts
    return {
      taskId: params.taskId,
      handle,
      step: params.step,
      role: params.role,
      worktreePath: params.worktreePath,
    };
  }

  /**
   * Inspects execution status of a task by its stable taskId.
   *
   * @param taskId Stable task identifier.
   */
  async inspect(taskId: string): Promise<ExecutionInspection> {
    return this.executor.inspect(taskId);
  }

  /**
   * Terminates an active execution by its handle.
   *
   * @param handle Execution handle to stop.
   */
  async stop(handle: ExecutionHandle): Promise<ExecutionStopResult> {
    return this.executor.stop(handle);
  }

  /**
   * Completely handles single task result association, duplicate and conflicting
   * submission detection, result persistence (result_submitted event recorded via WorkflowFiles.record),
   * and execution teardown (stopping the executor handle).
   * Returns task execution result facts without evaluating Run-level progression decisions.
   *
   * @param params Parameters specifying the task result to record.
   * @returns Facts about the recorded task execution.
   */
  async recordResult(params: RecordTaskResultParams): Promise<TaskExecutionResultFacts> {
    if (!params.taskId || typeof params.taskId !== 'string') {
      throw new Error('Valid taskId is required to submit a result.');
    }
    if (!params.result || !params.result.outcome || typeof params.result.outcome !== 'string') {
      throw new Error('TaskResult must specify an outcome.');
    }
    if (!params.result.summary || typeof params.result.summary !== 'string') {
      throw new Error('TaskResult must specify a summary.');
    }

    const events = await this.files.loadRun(params.runId);
    const firstEvent = events[0];
    if (!firstEvent || firstEvent.type !== 'run_created') {
      throw new Error(`First event in log for run "${params.runId}" must be "run_created".`);
    }
    const initialContext = (firstEvent.payload as { context: RunContext }).context;

    // Locate dispatch / task event for taskId
    let taskEvent: RunEvent | undefined;
    let handle: ExecutionHandle | undefined;
    let existingResultEvent: RunEvent | undefined;

    for (const evt of events) {
      if (evt.type === 'dispatch_intent' && (evt.payload as { taskId: string }).taskId === params.taskId) {
        taskEvent = evt;
      }
      if (evt.type === 'task_launched' && (evt.payload as { taskId: string }).taskId === params.taskId) {
        handle = (evt.payload as { handle: ExecutionHandle }).handle;
      }
      if (evt.type === 'result_submitted' && (evt.payload as { taskId: string }).taskId === params.taskId) {
        existingResultEvent = evt;
      }
    }

    if (!taskEvent) {
      throw new Error(`Task "${params.taskId}" not found in run "${params.runId}".`);
    }

    const taskPayload = taskEvent.payload as {
      step: string;
      role: string;
      worktreePath: string;
    };

    // Duplicate or conflicting submission check
    if (existingResultEvent) {
      const prior = existingResultEvent.payload as {
        outcome: string;
        summary: string;
        artifacts?: Record<string, unknown>;
      };

      const normalize = (obj: unknown) => JSON.stringify(obj ?? {});
      const isIdentical =
        prior.outcome === params.result.outcome &&
        prior.summary === params.result.summary &&
        normalize(prior.artifacts) === normalize(params.result.artifacts);

      if (isIdentical) {
        return {
          acknowledged: true,
          idempotent: true,
          taskId: params.taskId,
          runId: params.runId,
          step: taskPayload.step,
          role: taskPayload.role,
          outcome: params.result.outcome,
          summary: params.result.summary,
          artifacts: (params.result.artifacts ?? {}) as Record<string, unknown>,
          executionTerminated: true,
          worktreePath: taskPayload.worktreePath,
          handle,
        };
      }

      throw new Error(
        `Conflicting result submitted for task "${params.taskId}". A prior result with outcome "${prior.outcome}" is already recorded.`,
      );
    }

    // Role contract & step transitions validation
    const roleContract =
      params.roleContract ?? initialContext.roles?.roles?.[taskPayload.role];
    if (roleContract) {
      if (!roleContract.permitted_outcomes.includes(params.result.outcome)) {
        throw new Error(
          `Outcome "${params.result.outcome}" is not permitted for role "${taskPayload.role}". Permitted outcomes: [${roleContract.permitted_outcomes.join(', ')}].`,
        );
      }

      const required = roleContract.required_artifacts ?? [];
      const artifacts = params.result.artifacts ?? {};
      const missingArtifacts: string[] = [];
      for (const key of required) {
        const val = artifacts[key];
        if (val === undefined || val === null || val === '') {
          missingArtifacts.push(key);
        }
      }
      if (missingArtifacts.length > 0) {
        throw new Error(
          `Result submission for role "${taskPayload.role}" is missing required artifact(s): ${missingArtifacts.join(', ')}.`,
        );
      }
    } else {
      throw new Error(`Role contract for "${taskPayload.role}" is not defined.`);
    }

    const stepDef =
      params.stepDefinition ?? initialContext.workflow?.steps?.[taskPayload.step];
    if (!stepDef) {
      throw new Error(`Step "${taskPayload.step}" is not defined in workflow definition.`);
    }
    if (!(params.result.outcome in stepDef.transitions)) {
      const permitted = Object.keys(stepDef.transitions).join(', ');
      throw new Error(
        `Step "${taskPayload.step}" does not define a transition for outcome "${params.result.outcome}". Permitted transitions: [${permitted}].`,
      );
    }

    // 1. Persist result_submitted event
    const nowIso = new Date().toISOString();
    const artifacts = params.result.artifacts ?? {};
    const resultSubmittedEvent: RunEvent = {
      type: 'result_submitted',
      run_id: params.runId,
      timestamp: nowIso,
      payload: {
        taskId: params.taskId,
        step: taskPayload.step,
        role: taskPayload.role,
        outcome: params.result.outcome,
        summary: params.result.summary,
        artifacts,
      },
    };
    await this.files.record(params.runId, resultSubmittedEvent);

    // 2. Teardown execution (stop handle) and persist task_terminated event
    let executionTerminated = true;
    if (handle) {
      const stopRes = await this.executor.stop(handle);
      executionTerminated = stopRes.stopped;

      const termEvent: RunEvent = {
        type: 'task_terminated',
        run_id: params.runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId: params.taskId,
          handle,
          stopped: stopRes.stopped,
          uncertain: stopRes.uncertain,
          error: stopRes.error,
        },
      };
      await this.files.record(params.runId, termEvent);
    }

    // 3. Return task execution result facts
    return {
      acknowledged: true,
      taskId: params.taskId,
      runId: params.runId,
      step: taskPayload.step,
      role: taskPayload.role,
      outcome: params.result.outcome,
      summary: params.result.summary,
      artifacts,
      executionTerminated,
      worktreePath: taskPayload.worktreePath,
      handle,
    };
  }

  /**
   * Alias for recordResult.
   */
  async submitResult(params: RecordTaskResultParams): Promise<TaskExecutionResultFacts> {
    return this.recordResult(params);
  }

  /**
   * Completely handles execution termination for active tasks or all registered handles in a Run.
   * Discovers active provider handles, terminates executions via AgentExecutor.stop,
   * records task_terminated events when applicable, and verifies termination without
   * requiring Engine to interpret low-level handles.
   *
   * @param runId Unique Run identifier.
   * @param options Teardown options (target taskId, whether to force stop all handles, and whether to record task_terminated).
   * @returns Facts describing whether executions were stopped.
   */
  async ensureStopped(runId: string, options?: EnsureStoppedOptions): Promise<ExecutionTeardownResult> {
    const events = await this.files.loadRun(runId);
    const handleIdsSeen = new Set<string>();
    const terminatedHandleIds = new Set<string>();
    const allHandles: ExecutionHandle[] = [];

    for (const evt of events) {
      if (evt.type === 'task_terminated' && evt.payload.handle) {
        terminatedHandleIds.add((evt.payload.handle as ExecutionHandle).id);
      }
      if (evt.type === 'task_launched' && evt.payload.handle) {
        const h = evt.payload.handle as ExecutionHandle;
        if (!handleIdsSeen.has(h.id)) {
          handleIdsSeen.add(h.id);
          allHandles.push(h);
        }
      }
      if (evt.type === 'orchestrator_registered' && evt.payload.handle) {
        const h = evt.payload.handle as ExecutionHandle;
        if (!handleIdsSeen.has(h.id)) {
          handleIdsSeen.add(h.id);
          allHandles.push(h);
        }
      }
      if (evt.type === 'execution_handle_registered' && evt.payload.handle) {
        const h = evt.payload.handle as ExecutionHandle;
        if (!handleIdsSeen.has(h.id)) {
          handleIdsSeen.add(h.id);
          allHandles.push(h);
        }
      }
    }

    let targetHandles = allHandles;
    if (options?.taskId) {
      targetHandles = targetHandles.filter((h) => h.taskId === options.taskId);
    }
    if (!options?.all) {
      targetHandles = targetHandles.filter((h) => !terminatedHandleIds.has(h.id));
    }

    const terminatedHandles: ExecutionHandle[] = [];
    const shouldRecordTerminated = options?.recordTerminated ?? !options?.all;

    for (const handle of targetHandles) {
      try {
        const stopRes = await this.executor.stop(handle);
        if (!stopRes.stopped || stopRes.uncertain) {
          const reason = `Execution handle "${handle.id}" (${handle.taskId}) failed to terminate: ${stopRes.error || 'uncertain termination'}.`;
          return {
            stopped: false,
            uncertain: stopRes.uncertain,
            terminatedHandles,
            error: reason,
          };
        }
        terminatedHandles.push(handle);
        if (shouldRecordTerminated) {
          await this.files.record(runId, {
            type: 'task_terminated',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: handle.taskId,
              handle,
              stopped: true,
            },
          });
        }
      } catch (err) {
        const reason = `Execution handle "${handle.id}" (${handle.taskId}) threw on stop: ${(err as Error).message}.`;
        return {
          stopped: false,
          terminatedHandles,
          error: reason,
        };
      }
    }

    return {
      stopped: true,
      terminatedHandles,
    };
  }

  /**
   * Ensures the active task execution is stopped.
   *
   * @param runId Unique Run identifier.
   * @param taskId Optional task identifier to stop.
   * @returns Facts describing whether execution was stopped.
   */
  async stopActiveTask(runId: string, taskId?: string): Promise<ExecutionTeardownResult> {
    return this.ensureStopped(runId, { taskId, recordTerminated: true });
  }

  /**
   * Completely handles execution status confirmation, uncertain state reconciliation,
   * reconnecting to running tasks, and persisting task_reconciled events.
   *
   * @param runId Unique Run identifier.
   * @param targetTaskId Optional specific task identifier to reconcile.
   * @returns Reconciliation facts about the task execution.
   */
  async reconcileExecution(runId: string, targetTaskId?: string): Promise<TaskReconciliationResult> {
    const events = await this.files.loadRun(runId);

    let taskId = targetTaskId;
    let activeStep = 'implementation';
    let activeRole = 'worker';
    let activeHandle: ExecutionHandle | undefined;
    let taskLaunched = false;
    let isStopped = false;
    let latestResult: TaskResult | undefined;

    // Scan events to find the target task and its execution state
    for (const evt of events) {
      if (evt.type === 'dispatch_intent') {
        const p = evt.payload as { taskId: string; step: string; role: string };
        if (!targetTaskId || p.taskId === targetTaskId) {
          taskId = p.taskId;
          activeStep = p.step;
          activeRole = p.role;
          activeHandle = undefined;
          taskLaunched = false;
          isStopped = false;
          latestResult = undefined;
        }
      }
      if (evt.type === 'task_launched') {
        const p = evt.payload as { taskId: string; handle: ExecutionHandle; step: string; role: string };
        if (p.taskId === taskId) {
          activeHandle = p.handle;
          activeStep = p.step;
          activeRole = p.role;
          taskLaunched = true;
        }
      }
      if (evt.type === 'task_reconciled') {
        const p = evt.payload as { taskId: string; handle?: ExecutionHandle };
        if (p.taskId === taskId && p.handle) {
          activeHandle = p.handle;
        }
      }
      if (evt.type === 'result_submitted') {
        const p = evt.payload as { taskId: string; outcome: string; summary: string; artifacts?: Record<string, unknown> };
        if (p.taskId === taskId) {
          latestResult = {
            outcome: p.outcome,
            summary: p.summary,
            artifacts: p.artifacts,
          };
        }
      }
      if (evt.type === 'task_terminated') {
        const p = evt.payload as { taskId: string; stopped: boolean };
        if (p.taskId === taskId) {
          isStopped = p.stopped;
        }
      }
    }

    if (!taskId) {
      return {
        taskId: '',
        step: activeStep,
        role: activeRole,
        executionStatus: 'not_started',
        action: 'none',
      };
    }

    // 1. If result was already recorded
    if (latestResult) {
      let executionStatus: ExecutionStatus = isStopped ? 'exited' : 'running';
      try {
        const inspection = await this.executor.inspect(taskId);
        executionStatus = inspection.status;
      } catch {
        // If inspection fails when result is already durable, keep recorded status
      }
      return {
        taskId,
        step: activeStep,
        role: activeRole,
        handle: activeHandle,
        executionStatus,
        action: 'collected',
        result: latestResult,
      };
    }

    // 2. No result recorded yet; inspect provider executor by stable taskId
    let inspection: ExecutionInspection;
    try {
      inspection = await this.executor.inspect(taskId);
    } catch (err) {
      inspection = {
        status: 'uncertain',
        error: (err as Error).message,
      };
    }

    if (inspection.status === 'running') {
      const handle = activeHandle ?? inspection.handle ?? {
        id: `recovered-handle-${taskId}`,
        taskId,
      };

      const reconcileEvent: RunEvent = {
        type: 'task_reconciled',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: activeStep,
          role: activeRole,
          handle,
          executionStatus: 'running',
          action: 'reconnected',
        },
      };
      await this.files.record(runId, reconcileEvent);

      return {
        taskId,
        step: activeStep,
        role: activeRole,
        handle,
        executionStatus: 'running',
        action: 'reconnected',
      };
    }

    if (inspection.status === 'exited') {
      return {
        taskId,
        step: activeStep,
        role: activeRole,
        handle: activeHandle ?? inspection.handle,
        executionStatus: 'exited',
        action: 'none',
        error: 'Process exited without submitting a result.',
      };
    }

    if (inspection.status === 'uncertain' || (taskLaunched && inspection.status === 'not_started')) {
      const errorMsg =
        inspection.error ||
        (inspection.status === 'not_started'
          ? 'Execution was previously launched but cannot be reliably reconciled by provider.'
          : 'Execution status is uncertain from provider.');

      const reconcileEvent: RunEvent = {
        type: 'task_reconciled',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: activeStep,
          role: activeRole,
          handle: activeHandle ?? inspection.handle,
          executionStatus: 'uncertain',
          action: 'uncertain',
          error: errorMsg,
        },
      };
      await this.files.record(runId, reconcileEvent);

      return {
        taskId,
        step: activeStep,
        role: activeRole,
        handle: activeHandle ?? inspection.handle,
        executionStatus: 'uncertain',
        action: 'uncertain',
        isUncertain: true,
        error: errorMsg,
      };
    }

    // not_started: launch never completed before interruption
    return {
      taskId,
      step: activeStep,
      role: activeRole,
      handle: activeHandle,
      executionStatus: 'not_started',
      action: 'none',
    };
  }

  /**
   * Persists a task_reconciled event indicating explicit uncertainty.
   *
   * @param params Reconciled uncertainty details.
   */
  async recordTaskUncertain(params: {
    runId: string;
    taskId: string;
    step: string;
    role: string;
    error: string;
    handle?: ExecutionHandle;
  }): Promise<void> {
    const reconcileEvent: RunEvent = {
      type: 'task_reconciled',
      run_id: params.runId,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: params.taskId,
        step: params.step,
        role: params.role,
        handle: params.handle,
        executionStatus: 'uncertain',
        action: 'uncertain',
        error: params.error,
      },
    };
    await this.files.record(params.runId, reconcileEvent);
  }

  /**
   * Retrieves previously recorded TaskResult for a task if present in the event log.
   * Useful when reconciling interrupted states where task result was saved but Run not progressed.
   *
   * @param runId Unique Run identifier.
   * @param taskId Stable task identifier.
   * @returns Recorded TaskResult or null if not yet recorded.
   */
  async getTaskResult(runId: string, taskId: string): Promise<TaskResult | null> {
    const events = await this.files.loadRun(runId);
    for (let i = events.length - 1; i >= 0; i--) {
      const evt = events[i];
      if (evt.type === 'result_submitted' && (evt.payload as { taskId: string }).taskId === taskId) {
        const payload = evt.payload as {
          outcome: string;
          summary: string;
          artifacts?: Record<string, unknown>;
        };
        return {
          outcome: payload.outcome,
          summary: payload.summary,
          artifacts: payload.artifacts,
        };
      }
    }
    return null;
  }

  /**
   * Composes the worker prompt instructing the agent on task expectations,
   * requirements, prior evidence, and submission contract.
   *
   * @param params Parameters for the task assignment.
   * @returns Formatted prompt string.
   */
  composeWorkerPrompt(params: TaskDispatchParams): string {
    const promptLines = [
      `# Task Assignment: ${params.step} (${params.role})`,
      `Run: ${params.runId}`,
      `Task: ${params.taskId}`,
      `Skill: ${params.skill}`,
      '',
      '## Shared Requirements',
      params.sharedRequirements || 'None specified.',
    ];

    if (params.deliveryArtifacts && Object.keys(params.deliveryArtifacts).length > 0) {
      promptLines.push('', '## Delivery Artifacts');
      for (const [key, val] of Object.entries(params.deliveryArtifacts)) {
        promptLines.push(`${key}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
      }
    }

    if (params.priorEvidence) {
      promptLines.push('', '## Prior Evidence & Review Findings');
      if (params.priorEvidence.evaluatedCommit) {
        promptLines.push(`Evaluated Commit: ${params.priorEvidence.evaluatedCommit}`);
      }
      if (params.priorEvidence.findings) {
        promptLines.push(`Review Findings:\n${params.priorEvidence.findings}`);
      }
      if (params.priorEvidence.priorSummary) {
        promptLines.push(`Prior Summary: ${params.priorEvidence.priorSummary}`);
      }
    }

    promptLines.push(
      '',
      '## Task Instructions',
      params.taskInstructions,
      '',
      '## Permitted Outcomes',
      params.permittedOutcomes.join(', '),
      '',
      '## Required Artifacts',
      (params.requiredArtifacts ?? []).join(', ') || 'None',
      '',
      '## Submission Contract',
      `When finished, submit your result using:`,
      `pc workflow submit-result --run "${params.runId}" --task "${params.taskId}" --outcome <outcome> --summary "<summary>" --artifacts '<artifacts-json>'`,
    );

    return promptLines.join('\n');
  }
}
