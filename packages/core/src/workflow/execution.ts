/**
 * @fileoverview Encapsulates single task preparation, launch, execution inspection,
 * and handle recording for the Workflow Engine.
 */

import type {
  AgentExecutor,
  DispatchResult,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStopResult,
  PriorEvidence,
  RunEvent,
} from './types.js';
import type { WorkflowFiles, WorktreeOwnerMarker } from './files.js';

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
