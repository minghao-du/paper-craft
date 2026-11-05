/**
 * @fileoverview Deterministic Workflow Engine owning Run lifecycle, intake preflight,
 * execution dispatch, and result persistence.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentExecutor,
  DispatchOptions,
  DispatchResult,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
  GitHubMergeChecker,
  InitOptions,
  IssueChecker,
  MergeStatusResult,
  PreflightCheckResult,
  PriorEvidence,
  ProviderChecker,
  ReconciledTask,
  ReleaseResourcesOptions,
  ReleaseResourcesResult,
  ResumeOptions,
  ResumeResult,
  RunContext,
  RunEvent,
  RunStatus,
  SchedulingContext,
  StartOptions,
  StatusActiveTask,
  StatusOptions,
  StatusResult,
  StepTransitionResult,
  StopRunOptions,
  StopRunResult,
  SubmitResultResponse,
  TaskResult,
  WorkflowDefinition,
} from './types.js';
import {
  initWorkflowConfig,
  loadWorkflowConfig,
} from './config.js';
import {
  DefaultGitHubMergeChecker,
  DefaultIssueChecker,
  DefaultProviderChecker,
} from './checkers.js';
import { AgyExecutor } from './executor.js';
import { WorkflowFiles, type WorktreeOwnerMarker } from './files.js';
import { TaskExecution } from './execution.js';

/**
 * Computes the deterministic step transition given the current step, outcome, rework state, and workflow definition.
 * Pure function: drives step progression, review pass, bounded rework, pause on exhaustion, and blocked states.
 *
 * @param currentStep The current workflow step name.
 * @param outcome The submitted role outcome.
 * @param reworkCount The number of rework cycles completed so far.
 * @param reworkLimit The maximum permitted rework cycles.
 * @param workflow The workflow definition specifying steps and transitions.
 * @returns Deterministic StepTransitionResult.
 */
export function computeNextStep(
  currentStep: string,
  outcome: string,
  reworkCount: number,
  reworkLimit: number,
  workflow: WorkflowDefinition,
): StepTransitionResult {
  const stepDefinition = workflow.steps[currentStep];
  if (!stepDefinition) {
    throw new Error(`Step "${currentStep}" is not defined in workflow definition.`);
  }

  const target = stepDefinition.transitions[outcome];
  if (!target) {
    const permitted = Object.keys(stepDefinition.transitions).join(', ');
    throw new Error(
      `Step "${currentStep}" does not define a transition for outcome "${outcome}". Permitted transitions: [${permitted}].`,
    );
  }

  // 1. Blocked outcome or target
  if (target === 'blocked' || outcome === 'blocked') {
    return {
      nextStep: undefined,
      status: 'blocked',
      isTerminal: true,
      isRework: false,
      reworkCount,
      reason: 'blocked',
    };
  }

  // 2. Terminal completion
  if (target === 'completed') {
    return {
      nextStep: 'completed',
      status: 'completed',
      isTerminal: true,
      isRework: false,
      reworkCount,
      reason: 'completed',
    };
  }

  // 3. Business rework: outcome is rework or target loops back to initial_step (or an earlier step)
  const isReworkTransition =
    outcome === 'rework' ||
    (target === workflow.initial_step && currentStep !== workflow.initial_step);

  if (isReworkTransition) {
    if (reworkCount >= reworkLimit) {
      return {
        nextStep: undefined,
        status: 'paused',
        isTerminal: true,
        isRework: true,
        reworkCount,
        reason: 'rework_limit_exhausted',
      };
    }
    return {
      nextStep: target,
      status: 'running',
      isTerminal: false,
      isRework: true,
      reworkCount: reworkCount + 1,
      reason: 'rework',
    };
  }

  // 4. Normal progression (pass, completed to next step, etc.)
  if (!workflow.steps[target]) {
    throw new Error(`Target step "${target}" is not defined in workflow definition.`);
  }

  return {
    nextStep: target,
    status: 'running',
    isTerminal: false,
    isRework: false,
    reworkCount,
    reason: outcome === 'pass' ? 'review_passed' : 'step_completed',
  };
}

/**
 * Custom error raised when intake preflight checks fail.
 */
export class WorkflowPreflightError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Workflow preflight checks failed:\n- ${errors.join('\n- ')}`);
    this.name = 'WorkflowPreflightError';
    this.errors = errors;
  }
}

/**
 * Custom error raised when a worktree has a conflicting ownership claim.
 */
export class WorkflowOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowOwnershipError';
  }
}

/**
 * Custom error raised when review approval is invalidated due to changed PR head revision.
 */
export class WorkflowReviewInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowReviewInvalidatedError';
  }
}

/**
 * Custom error raised when merge verification fails or review evidence is missing.
 */
export class WorkflowMergeVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowMergeVerificationError';
  }
}

/**
 * Custom error raised when resource cleanup or preservation verification fails.
 */
export class WorkflowCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCleanupError';
  }
}

/**
 * Constructor options for initializing the WorkflowEngine.
 */
export interface WorkflowEngineOptions {
  /** Working directory context. Defaults to process.cwd(). */
  cwd?: string;
  /** Storage root for durable state and event logs. Defaults to '.paper-craft'. */
  storageRoot?: string;
  /** Checker for verifying GitHub issue accessibility. */
  issueChecker?: IssueChecker;
  /** Checker for verifying provider capabilities. */
  providerChecker?: ProviderChecker;
  /** Agent executor instance for launching and managing agent executions. */
  executor?: AgentExecutor;
  /** Checker for verifying PR head revision and GitHub merge status. */
  mergeChecker?: GitHubMergeChecker;
  /** Files manager for persisting workflow runs and events. */
  files?: WorkflowFiles;
  /** Task execution manager for preparing and launching specialist tasks. */
  taskExecution?: TaskExecution;
}

/**
 * The Workflow Engine is the deterministic driver of workflow runs, configuration,
 * provider dispatch, and immutable event logging.
 */
export class WorkflowEngine {
  public readonly cwd: string;
  public readonly storageRoot: string;
  public readonly issueChecker: IssueChecker;
  public readonly providerChecker: ProviderChecker;
  public readonly executor: AgentExecutor;
  public readonly mergeChecker: GitHubMergeChecker;
  public readonly files: WorkflowFiles;
  public readonly taskExecution: TaskExecution;

  constructor(options?: WorkflowEngineOptions) {
    this.cwd = options?.cwd ?? process.cwd();
    this.storageRoot = options?.storageRoot
      ? path.resolve(this.cwd, options.storageRoot)
      : path.join(this.cwd, '.paper-craft');
    this.issueChecker = options?.issueChecker ?? new DefaultIssueChecker();
    this.providerChecker = options?.providerChecker ?? new DefaultProviderChecker();
    this.executor = options?.executor ?? new AgyExecutor();
    this.mergeChecker = options?.mergeChecker ?? new DefaultGitHubMergeChecker();
    this.files = options?.files ?? new WorkflowFiles(this.storageRoot);
    this.taskExecution =
      options?.taskExecution ??
      new TaskExecution({ files: this.files, executor: this.executor });
  }

  /**
   * Scaffolds new workflow configuration files in the working directory.
   */
  async init(options?: InitOptions): Promise<{ configPath: string }> {
    return initWorkflowConfig(this.cwd, options);
  }

  /**
   * Performs thorough preflight verifications without invoking any model.
   */
  async preflight(options: StartOptions): Promise<PreflightCheckResult> {
    const errors: string[] = [];
    const details: Record<string, unknown> = {};

    // Validate issue option
    if (!options.issue || typeof options.issue !== 'number' || options.issue <= 0) {
      errors.push('Issue number is required and must be a positive integer.');
    }

    // Validate requirements options
    if (options.requirements && options.requirementsFile) {
      errors.push('Cannot supply both "requirements" text and "requirementsFile". Provide only one.');
    }

    let sharedRequirementsContent = '';
    if (options.requirementsFile) {
      const resolvedReqPath = path.resolve(this.cwd, options.requirementsFile);
      try {
        sharedRequirementsContent = await fs.readFile(resolvedReqPath, 'utf8');
      } catch {
        errors.push(`Requirements file not found at: ${resolvedReqPath}`);
      }
    } else if (options.requirements) {
      sharedRequirementsContent = options.requirements;
    }

    // Load and validate configuration
    let loadedConfig;
    try {
      loadedConfig = await loadWorkflowConfig(this.cwd, options.configPath);
    } catch (err) {
      errors.push((err as Error).message);
    }

    if (!loadedConfig) {
      return { ok: false, errors, details };
    }

    const { config, workflow, roles } = loadedConfig;
    details.repository = config.repository;
    details.worktree_root = config.worktree_root;

    // Check provider availability
    const targetProvider = options.provider || config.provider || 'agy';
    try {
      const provCheck = await this.providerChecker.check(targetProvider);
      if (!provCheck.available) {
        errors.push(provCheck.error || `Provider "${targetProvider}" is not available.`);
      }
    } catch (err) {
      errors.push(`Provider verification failed: ${(err as Error).message}`);
    }

    // Check issue accessibility
    if (options.issue > 0) {
      try {
        const issueCheck = await this.issueChecker.checkIssue(config.repository, options.issue);
        if (!issueCheck.exists) {
          errors.push(issueCheck.error || `Issue #${options.issue} not found in repository "${config.repository}".`);
        } else {
          details.issueTitle = issueCheck.title;
          details.issueOpen = issueCheck.open;
        }
      } catch (err) {
        errors.push(`Failed to verify Issue #${options.issue}: ${(err as Error).message}`);
      }
    }

    // Check directory usability
    const resolvedWorktreeRoot = path.resolve(this.cwd, config.worktree_root);
    try {
      await fs.mkdir(resolvedWorktreeRoot, { recursive: true });
      await fs.access(resolvedWorktreeRoot, fs.constants.W_OK);
    } catch (err) {
      errors.push(`Worktree root directory "${resolvedWorktreeRoot}" is not usable or writable: ${(err as Error).message}`);
    }

    // Check storage root usability
    try {
      await fs.mkdir(this.storageRoot, { recursive: true });
      await fs.access(this.storageRoot, fs.constants.W_OK);
    } catch (err) {
      errors.push(`Storage directory "${this.storageRoot}" is not usable or writable: ${(err as Error).message}`);
    }

    // Check for unfinished Run conflicts for the same repository and issue
    try {
      const runIds = await this.files.listRunIds();
      for (const entryRunId of runIds) {
        try {
          const events = await this.files.loadRun(entryRunId);
          if (events.length === 0) continue;

          const firstEvent = events[0];
          if (firstEvent.type === 'run_created') {
            const ctx = (firstEvent.payload as { context: RunContext }).context;
            if (ctx.repository === config.repository && ctx.issue === options.issue) {
              const currentStatus = this.deriveRunStatusFromEvents(events);
              if (currentStatus !== 'completed') {
                errors.push(
                  `Active run "${entryRunId}" already exists for issue #${options.issue} in repository "${config.repository}" with status "${currentStatus}". Inspect status with "pc workflow status --run ${entryRunId}" or resume with "pc workflow resume ${entryRunId}" (or recover).`,
                );
              }
            }
          }
        } catch {
          // Ignore unreadable or corrupted historical runs during check
        }
      }
    } catch {
      // runs dir does not exist yet; no conflicts
    }

    // Check worktree ownership conflict
    const targetWorktree = path.resolve(resolvedWorktreeRoot, `issue-${options.issue}`);
    try {
      const ownerData = await this.files.readWorktreeOwner(targetWorktree);
      if (ownerData && ownerData.run_id) {
        errors.push(
          `Target worktree directory "${targetWorktree}" has conflicting ownership marker belonging to "${ownerData.run_id}".`,
        );
      }
    } catch {
      // Marker does not exist; no conflict
    }

    details.sharedRequirements = sharedRequirementsContent;
    details.workflow = workflow;
    details.roles = roles;

    return {
      ok: errors.length === 0,
      errors,
      details,
    };
  }

  /**
   * Starts a new workflow Run after validating preflight gates.
   * Captures an immutable snapshot of configuration, definitions, and requirements.
   */
  async start(options: StartOptions): Promise<RunContext> {
    const preflightResult = await this.preflight(options);
    if (!preflightResult.ok) {
      throw new WorkflowPreflightError(preflightResult.errors);
    }

    const loadedConfig = await loadWorkflowConfig(this.cwd, options.configPath);
    const { config, workflow, roles } = loadedConfig;

    let sharedRequirements = '';
    if (options.requirementsFile) {
      const resolvedReqPath = path.resolve(this.cwd, options.requirementsFile);
      sharedRequirements = await fs.readFile(resolvedReqPath, 'utf8');
    } else if (options.requirements) {
      sharedRequirements = options.requirements;
    }

    const runId = `run-${Date.now()}-${options.issue}-${randomUUID().slice(0, 6)}`;
    const nowIso = new Date().toISOString();
    const provider = options.provider || config.provider || 'agy';
    const resolvedWorktreeRoot = path.resolve(this.cwd, config.worktree_root);
    const worktreePath = path.resolve(resolvedWorktreeRoot, `issue-${options.issue}`);

    const runContext: RunContext = {
      run_id: runId,
      repository: config.repository,
      issue: options.issue,
      issue_title: preflightResult.details?.issueTitle as string | undefined,
      provider,
      worktree_path: worktreePath,
      created_at: nowIso,
      status: 'pending_dispatch',
      current_step: workflow.initial_step,
      rework_count: 0,
      shared_requirements: sharedRequirements,
      config: JSON.parse(JSON.stringify(config)),
      workflow: JSON.parse(JSON.stringify(workflow)),
      roles: JSON.parse(JSON.stringify(roles)),
    };

    await this.files.createRun(runContext);

    if (options.orchestratorHandle) {
      const orchEvent: RunEvent = {
        type: 'orchestrator_registered',
        run_id: runId,
        timestamp: nowIso,
        payload: {
          handle: options.orchestratorHandle,
          type: 'orchestrator',
        },
      };
      await this.appendEvent(runId, orchEvent);
    }

    return runContext;
  }

  /**
   * Registers an orchestrator execution handle to be tracked and gracefully terminated
   * upon workflow resource release before completion.
   */
  async registerOrchestrator(runId: string, handle: ExecutionHandle): Promise<void> {
    if (!runId || typeof runId !== 'string') {
      throw new Error('Valid runId is required to register an orchestrator handle.');
    }
    if (!handle || !handle.id) {
      throw new Error('Valid ExecutionHandle is required.');
    }
    const orchEvent: RunEvent = {
      type: 'orchestrator_registered',
      run_id: runId,
      timestamp: new Date().toISOString(),
      payload: {
        handle,
        type: 'orchestrator',
      },
    };
    await this.appendEvent(runId, orchEvent);
  }

  /**
   * Reads all events for a given run from its JSONL event log.
   */
  async readEvents(runId: string): Promise<RunEvent[]> {
    return this.files.loadRun(runId);
  }

  /**
   * Appends an event to the run's JSONL event log.
   */
  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    return this.files.record(runId, event);
  }

  /**
   * Computes the deterministic step transition for a run given a prospective or submitted outcome.
   */
  async computeNextStep(runId: string, outcome: string): Promise<StepTransitionResult> {
    const context = await this.getSchedulingContext(runId);
    const events = await this.readEvents(runId);
    const initialContext = (events[0].payload as { context: RunContext }).context;
    return computeNextStep(
      context.currentStep,
      outcome,
      context.reworkCount,
      context.reworkLimit,
      initialContext.workflow,
    );
  }

  /**
   * Derives current scheduling context for a Run to supply to an orchestrator.
   */
  async getSchedulingContext(runId: string): Promise<SchedulingContext> {
    const events = await this.readEvents(runId);
    const firstEvent = events[0];
    if (firstEvent.type !== 'run_created') {
      throw new Error(`First event in log for run "${runId}" must be "run_created".`);
    }

    const initialContext = (firstEvent.payload as { context: RunContext }).context;
    let currentStatus: RunStatus = 'pending_dispatch';
    let currentStep = initialContext.current_step;
    let reworkCount = initialContext.rework_count;
    let activeTaskId: string | undefined;
    let activeHandle: ExecutionHandle | undefined;
    let latestResult: TaskResult | undefined;
    let priorEvidence: PriorEvidence | undefined;
    let deliveryArtifacts: Record<string, unknown> = {};
    let mergedCommit: string | undefined;

    for (let i = 1; i < events.length; i++) {
      const evt = events[i];
      switch (evt.type) {
        case 'dispatch_intent': {
          const payload = evt.payload as { taskId: string; step: string };
          activeTaskId = payload.taskId;
          latestResult = undefined;
          currentStatus = 'running';
          break;
        }
        case 'task_launched': {
          const payload = evt.payload as { taskId: string; handle: ExecutionHandle };
          activeTaskId = payload.taskId;
          activeHandle = payload.handle;
          currentStatus = 'running';
          break;
        }
        case 'task_reconciled': {
          const payload = evt.payload as {
            taskId: string;
            handle?: ExecutionHandle;
            action: string;
          };
          if (payload.handle) {
            activeHandle = payload.handle;
          }
          if (payload.action === 'uncertain') {
            currentStatus = 'uncertain';
          }
          break;
        }
        case 'result_submitted': {
          const payload = evt.payload as {
            taskId: string;
            step: string;
            role: string;
            outcome: string;
            summary: string;
            artifacts?: Record<string, unknown>;
          };
          latestResult = {
            outcome: payload.outcome,
            summary: payload.summary,
            artifacts: payload.artifacts,
          };
          if (payload.artifacts) {
            deliveryArtifacts = { ...deliveryArtifacts, ...payload.artifacts };
            if (payload.artifacts.merged_commit) {
              mergedCommit = payload.artifacts.merged_commit as string;
            }
          }
          priorEvidence = {
            ...priorEvidence,
            evaluatedCommit:
              (payload.artifacts?.reviewed_commit as string | undefined) ??
              priorEvidence?.evaluatedCommit ??
              (deliveryArtifacts.reviewed_commit as string | undefined),
            findings:
              (payload.artifacts?.findings as string | undefined) ??
              priorEvidence?.findings ??
              (deliveryArtifacts.findings as string | undefined),
            priorTaskId: payload.taskId,
            priorStep: payload.step,
            priorRole: payload.role,
            priorOutcome: payload.outcome,
            priorSummary: payload.summary,
            artifacts: payload.artifacts,
          };
          break;
        }
        case 'task_terminated': {
          const payload = evt.payload as { taskId: string };
          if (payload.taskId === activeTaskId) {
            activeTaskId = undefined;
            activeHandle = undefined;
          }
          break;
        }
        case 'task_launch_failed': {
          const payload = evt.payload as { taskId: string };
          if (payload.taskId === activeTaskId) {
            activeTaskId = undefined;
            activeHandle = undefined;
          }
          break;
        }
        case 'review_invalidated': {
          if (priorEvidence) {
            priorEvidence = {
              ...priorEvidence,
              evaluatedCommit: undefined,
            };
          }
          break;
        }
        case 'step_transitioned': {
          const payload = evt.payload as {
            toStep?: string;
            reason?: string;
            reworkCount?: number;
            reviewedCommit?: string;
            findings?: string;
            artifacts?: Record<string, unknown>;
            mergedCommit?: string;
          };
          if (payload.toStep === 'completed') {
            currentStep = 'completed';
            currentStatus = 'completed';
          } else if (payload.toStep) {
            currentStep = payload.toStep;
            currentStatus = 'pending_dispatch';
          }
          if (payload.reason === 'rework') {
            reworkCount = payload.reworkCount ?? (reworkCount + 1);
          }
          if (payload.artifacts) {
            deliveryArtifacts = { ...deliveryArtifacts, ...payload.artifacts };
          }
          if (payload.mergedCommit) {
            mergedCommit = payload.mergedCommit;
          }
          if (payload.reason === 'review_invalidated') {
            if (priorEvidence) {
              priorEvidence = {
                ...priorEvidence,
                evaluatedCommit: undefined,
              };
            }
          } else if (payload.reviewedCommit || payload.findings) {
            priorEvidence = {
              ...priorEvidence,
              evaluatedCommit: payload.reviewedCommit ?? (payload.artifacts?.reviewed_commit as string | undefined),
              findings: payload.findings ?? (payload.artifacts?.findings as string | undefined),
            };
          }
          activeTaskId = undefined;
          activeHandle = undefined;
          break;
        }
        case 'run_completed':
          currentStatus = 'completed';
          break;
        case 'run_blocked':
          currentStatus = 'blocked';
          break;
        case 'run_paused':
          currentStatus = 'paused';
          break;
        case 'run_uncertain':
          currentStatus = 'uncertain';
          break;
      }
    }

    const reworkLimit = initialContext.workflow.rework_limit ?? initialContext.config.rework_limit ?? 3;
    const stepDefinition = initialContext.workflow.steps[currentStep];
    const roleName = stepDefinition ? stepDefinition.role : 'none';
    const roleContract = initialContext.roles.roles[roleName] ?? {
      skill: 'none',
      permitted_outcomes: [],
    };

    return {
      runId,
      repository: initialContext.repository,
      issue: initialContext.issue,
      status: currentStatus,
      currentStep,
      reworkCount,
      reworkLimit,
      provider: initialContext.provider,
      worktreePath: initialContext.worktree_path,
      stepDefinition: stepDefinition ?? { role: '', guidance: '', transitions: {} },
      roleContract,
      sharedRequirements: initialContext.shared_requirements,
      activeTaskId,
      activeHandle,
      latestResult,
      priorEvidence,
      evaluatedCommit: priorEvidence?.evaluatedCommit ?? (deliveryArtifacts.reviewed_commit as string | undefined),
      reviewFindings: priorEvidence?.findings ?? (deliveryArtifacts.findings as string | undefined),
      mergedCommit,
      deliveryArtifacts,
    };
  }

  /**
   * Verifies that prerequisites for the merge step are satisfied.
   * Validates that an approved review commit exists and matches the current PR head on GitHub.
   * If PR head has changed, invalidates review approval and transitions workflow back to review.
   */
  async verifyMergePrerequisites(runId: string): Promise<{
    valid: boolean;
    approvedCommit?: string;
    currentHeadSha?: string;
    invalidated?: boolean;
    error?: string;
  }> {
    const context = await this.getSchedulingContext(runId);
    if (context.currentStep !== 'merge' && context.stepDefinition.role !== 'merger') {
      return { valid: true };
    }

    const approvedCommit = context.evaluatedCommit;
    if (!approvedCommit) {
      const blockerEvent: RunEvent = {
        type: 'run_blocked',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          step: context.currentStep,
          reason: 'Cannot dispatch merge: missing approved review revision (stale or absent review evidence).',
        },
      };
      await this.appendEvent(runId, blockerEvent);
      return {
        valid: false,
        error: 'Cannot dispatch merge: missing approved review revision (stale or absent review evidence).',
      };
    }

    let mergeStatus: MergeStatusResult;
    try {
      mergeStatus = await this.mergeChecker.checkMergeStatus(
        context.repository,
        context.issue,
        context.worktreePath,
      );
    } catch (err) {
      mergeStatus = {
        exists: false,
        error: (err as Error).message,
      };
    }

    if (mergeStatus.error) {
      const uncertainEvent: RunEvent = {
        type: 'run_uncertain',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          step: context.currentStep,
          reason: `Merge prerequisite verification failed: ${mergeStatus.error}`,
        },
      };
      await this.appendEvent(runId, uncertainEvent);
      return {
        valid: false,
        error: `Merge prerequisite verification uncertain: ${mergeStatus.error}`,
      };
    }

    if (!mergeStatus.headSha) {
      const blockerEvent: RunEvent = {
        type: 'run_blocked',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          step: context.currentStep,
          reason: 'Merge prerequisite verification failed: PR head commit could not be determined on GitHub.',
        },
      };
      await this.appendEvent(runId, blockerEvent);
      return {
        valid: false,
        error: 'Could not determine PR head commit on GitHub.',
      };
    }

    if (mergeStatus.headSha !== approvedCommit) {
      // PR head has moved: invalidate review approval and transition back to review!
      const invalidEvent: RunEvent = {
        type: 'review_invalidated',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          step: context.currentStep,
          approvedCommit,
          currentHeadSha: mergeStatus.headSha,
          reason: `Current PR head revision "${mergeStatus.headSha}" does not match approved review revision "${approvedCommit}". Review approval invalidated.`,
        },
      };
      await this.appendEvent(runId, invalidEvent);

      const stepTransEvent: RunEvent = {
        type: 'step_transitioned',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          fromStep: 'merge',
          toStep: 'review',
          reason: 'review_invalidated',
          invalidatedCommit: approvedCommit,
          newHeadSha: mergeStatus.headSha,
          message: `PR head changed from ${approvedCommit} to ${mergeStatus.headSha}. Fresh review required before merge.`,
        },
      };
      await this.appendEvent(runId, stepTransEvent);

      return {
        valid: false,
        invalidated: true,
        approvedCommit,
        currentHeadSha: mergeStatus.headSha,
        error: `Current PR head revision "${mergeStatus.headSha}" does not match approved review revision "${approvedCommit}". Review approval has been invalidated and workflow transitioned back to review.`,
      };
    }

    return {
      valid: true,
      approvedCommit,
      currentHeadSha: mergeStatus.headSha,
    };
  }

  /**
   * Dispatches a specialist role task for the current step.
   * Engine binds Run identity, step, role, provider, inputs, and workspace;
   * caller provides task-specific instructions.
   */
  async dispatch(runId: string, taskInstructions: string, options?: DispatchOptions): Promise<DispatchResult> {
    if (!taskInstructions || typeof taskInstructions !== 'string' || !taskInstructions.trim()) {
      throw new Error('Task instructions are required to dispatch a role task.');
    }

    const context = await this.getSchedulingContext(runId);
    if (context.status === 'completed') {
      throw new Error(`Cannot dispatch: run "${runId}" is already completed.`);
    }
    if (context.status === 'blocked') {
      throw new Error(`Cannot dispatch: run "${runId}" is blocked.`);
    }
    if (context.status === 'paused') {
      throw new Error(
        `Cannot dispatch: run "${runId}" is paused. Rework limit of ${context.reworkLimit} rounds exhausted.`,
      );
    }
    if (context.activeTaskId) {
      throw new Error(
        `Cannot dispatch: task "${context.activeTaskId}" is currently running. Run at most one professional task at a time.`,
      );
    }

    if (context.currentStep === 'merge' || context.stepDefinition.role === 'merger') {
      const prereq = await this.verifyMergePrerequisites(runId);
      if (!prereq.valid) {
        if (prereq.invalidated) {
          throw new WorkflowReviewInvalidatedError(
            `Current PR head revision "${prereq.currentHeadSha}" does not match approved review revision "${prereq.approvedCommit}". Review approval has been invalidated and workflow transitioned back to review.`,
          );
        }
        throw new WorkflowMergeVerificationError(prereq.error || 'Merge prerequisites not satisfied.');
      }
    }

    const taskId =
      options?.taskId ??
      `task-${runId}-${context.currentStep}-${context.reworkCount}-${randomUUID().slice(0, 6)}`;

    return this.taskExecution.dispatch({
      runId,
      taskId,
      step: context.currentStep,
      role: context.stepDefinition.role,
      skill: context.roleContract.skill,
      taskInstructions,
      sharedRequirements: context.sharedRequirements,
      worktreePath: context.worktreePath,
      repository: context.repository,
      issue: context.issue,
      permittedOutcomes: context.roleContract.permitted_outcomes,
      requiredArtifacts: context.roleContract.required_artifacts,
      priorEvidence: context.priorEvidence,
      deliveryArtifacts: context.deliveryArtifacts,
      inputs: options?.inputs,
    });
  }

  /**
   * Engine-controlled release of Run resources and records preservation.
   * Validates preservation conditions and worktree ownership before destructive cleanup,
   * terminates all remaining owned agent executions (including registered orchestrator),
   * and records resources_released and run_completed events upon success.
   */
  async releaseRunResources(runId: string, options?: ReleaseResourcesOptions): Promise<ReleaseResourcesResult> {
    const events = await this.readEvents(runId);
    const initialContext = (events[0].payload as { context: RunContext }).context;

    // Check if already released and completed
    const alreadyReleased = events.some((e) => e.type === 'resources_released');
    const alreadyCompleted = events.some((e) => e.type === 'run_completed');
    if (alreadyReleased && alreadyCompleted) {
      return {
        runId,
        released: true,
        worktreeRemoved: false,
        worktreePath: initialContext.worktree_path,
        terminatedHandles: [],
        status: 'completed',
        message: `Resources were already released for run "${runId}".`,
      };
    }

    // 1. Determine artifacts for preservation check
    let artifacts = options?.artifacts;
    if (!artifacts) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'result_submitted') {
          const p = events[i].payload as { artifacts?: Record<string, unknown> };
          if (p.artifacts) {
            artifacts = p.artifacts;
            break;
          }
        }
      }
    }
    artifacts = artifacts ?? {};

    // 2. Validate preservation conditions
    const releaseEvidence = artifacts.release_evidence;
    let preservationValid = true;
    let preservationError: string | undefined;

    if (releaseEvidence === undefined || releaseEvidence === null || releaseEvidence === '') {
      preservationValid = false;
      preservationError = 'Missing required release_evidence for preservation.';
    } else if (typeof releaseEvidence === 'object') {
      const rev = releaseEvidence as Record<string, unknown>;
      if (rev.preserved === false || rev.valid === false) {
        preservationValid = false;
        preservationError = (rev.error as string) || 'Preservation evidence indicates failed preservation.';
      }
    } else if (releaseEvidence === false) {
      preservationValid = false;
      preservationError = 'release_evidence indicates failed preservation.';
    }

    if (artifacts.preservation_evidence !== undefined) {
      const pev = artifacts.preservation_evidence;
      if (
        pev === false ||
        (typeof pev === 'object' &&
          ((pev as Record<string, unknown>).valid === false ||
            (pev as Record<string, unknown>).preserved === false))
      ) {
        preservationValid = false;
        preservationError =
          ((pev as Record<string, unknown>)?.error as string) ||
          'Preservation evidence indicates failed preservation.';
      }
    }

    if (!preservationValid) {
      const reason = preservationError || 'Preservation conditions not satisfied.';
      await this.appendEvent(runId, {
        type: 'cleanup_failed',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          runId,
          reason,
          error: reason,
          worktreePath: initialContext.worktree_path,
        },
      });
      await this.appendEvent(runId, {
        type: 'run_blocked',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          step: 'finalization',
          reason: `Resource release failed: ${reason}`,
        },
      });
      return {
        runId,
        released: false,
        worktreeRemoved: false,
        worktreePath: initialContext.worktree_path,
        terminatedHandles: [],
        status: 'blocked',
        error: reason,
        message: `Resource release failed: ${reason}`,
      };
    }

    const worktreePath = initialContext.worktree_path;

    // 3. Validate worktree ownership conditions before destructive deletion
    let worktreeExists: boolean;
    try {
      const st = await fs.stat(worktreePath);
      worktreeExists = st.isDirectory();
    } catch {
      worktreeExists = false;
    }

    if (worktreeExists) {
      const ownerMarker = await this.files.readWorktreeOwner(worktreePath);

      if (!ownerMarker) {
        const reason = `Cannot clean up worktree: .pc-execution-owner marker is missing at "${worktreePath}". Refusing to destroy unverified directory.`;
        await this.appendEvent(runId, {
          type: 'cleanup_failed',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { runId, worktreePath, reason },
        });
        await this.appendEvent(runId, {
          type: 'run_blocked',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { step: 'finalization', reason },
        });
        return {
          runId,
          released: false,
          worktreeRemoved: false,
          worktreePath,
          terminatedHandles: [],
          status: 'blocked',
          error: reason,
          message: `Resource release failed: ${reason}`,
        };
      }

      if (ownerMarker.run_id !== runId) {
        const reason = `Cannot clean up worktree: ownership mismatch. Worktree belongs to run "${ownerMarker.run_id}", not "${runId}". Refusing to destroy foreign worktree.`;
        await this.appendEvent(runId, {
          type: 'cleanup_failed',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { runId, worktreePath, reason },
        });
        await this.appendEvent(runId, {
          type: 'run_blocked',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { step: 'finalization', reason },
        });
        return {
          runId,
          released: false,
          worktreeRemoved: false,
          worktreePath,
          terminatedHandles: [],
          status: 'blocked',
          error: reason,
          message: `Resource release failed: ${reason}`,
        };
      }
    }

    // 4. Terminate all remaining owned agent executions (including registered orchestrator)
    const allHandles: ExecutionHandle[] = [];
    const handleIdsSeen = new Set<string>();

    for (const evt of events) {
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

    const terminatedHandles: ExecutionHandle[] = [];
    for (const handle of allHandles) {
      try {
        const stopRes = await this.executor.stop(handle);
        if (!stopRes.stopped || stopRes.uncertain) {
          const reason = `Execution handle "${handle.id}" (${handle.taskId}) failed to terminate: ${stopRes.error || 'uncertain termination'}.`;
          await this.appendEvent(runId, {
            type: 'cleanup_failed',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: { runId, handle, reason },
          });
          await this.appendEvent(runId, {
            type: 'run_blocked',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: { step: 'finalization', reason },
          });
          return {
            runId,
            released: false,
            worktreeRemoved: false,
            worktreePath,
            terminatedHandles,
            status: 'blocked',
            error: reason,
            message: `Resource release failed: ${reason}`,
          };
        }
        terminatedHandles.push(handle);
      } catch (err) {
        const reason = `Execution handle "${handle.id}" (${handle.taskId}) threw on stop: ${(err as Error).message}.`;
        await this.appendEvent(runId, {
          type: 'cleanup_failed',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { runId, handle, reason },
        });
        await this.appendEvent(runId, {
          type: 'run_blocked',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { step: 'finalization', reason },
        });
        return {
          runId,
          released: false,
          worktreeRemoved: false,
          worktreePath,
          terminatedHandles,
          status: 'blocked',
          error: reason,
          message: `Resource release failed: ${reason}`,
        };
      }
    }

    // 5. Destructive worktree cleanup (if exists)
    let worktreeRemoved = false;
    if (worktreeExists) {
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch (err) {
        const reason = `Failed to remove worktree at "${worktreePath}": ${(err as Error).message}.`;
        await this.appendEvent(runId, {
          type: 'cleanup_failed',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { runId, worktreePath, reason },
        });
        await this.appendEvent(runId, {
          type: 'run_blocked',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: { step: 'finalization', reason },
        });
        return {
          runId,
          released: false,
          worktreeRemoved: false,
          worktreePath,
          terminatedHandles,
          status: 'blocked',
          error: reason,
          message: `Resource release failed: ${reason}`,
        };
      }
    }

    // 6. Record resources_released and run_completed events
    await this.appendEvent(runId, {
      type: 'resources_released',
      run_id: runId,
      timestamp: new Date().toISOString(),
      payload: {
        runId,
        worktreePath,
        worktreeRemoved,
        terminatedHandles,
        releasedAt: new Date().toISOString(),
      },
    });

    await this.appendEvent(runId, {
      type: 'run_completed',
      run_id: runId,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: options?.taskId,
        step: 'finalization',
        summary: options?.summary || 'Run resources successfully released and final records preserved.',
        completedAt: new Date().toISOString(),
      },
    });

    return {
      runId,
      released: true,
      worktreeRemoved,
      worktreePath,
      terminatedHandles,
      status: 'completed',
      message: 'Resources successfully released and Run marked completed.',
    };
  }

  /**
   * Stops an active workflow Run: terminates all active role tasks and orchestrator executions,
   * appends task_terminated and run_paused events, and verifies termination.
   *
   * @param runIdOrOptions Target Run ID string or StopRunOptions.
   * @returns Result indicating whether executions were stopped and the Run paused.
   */
  async stop(runIdOrOptions?: string | StopRunOptions): Promise<StopRunResult> {
    const options: StopRunOptions =
      typeof runIdOrOptions === 'string'
        ? { runId: runIdOrOptions }
        : runIdOrOptions ?? {};

    let runId = options.runId;
    if (!runId) {
      const latest = await this.status({ configPath: options.configPath });
      runId = latest.run_id;
    }

    if (!runId) {
      throw new Error('Stop requires a valid Run identifier or an active Run in status.');
    }

    const events = await this.readEvents(runId);
    if (events.length === 0) {
      throw new Error(`Run "${runId}" does not exist or has no recorded events.`);
    }

    // Determine current status and current step
    let currentStatus: RunStatus = 'running';
    let currentStep = 'implementation';
    for (const evt of events) {
      if (evt.type === 'step_transitioned') {
        const payload = evt.payload as { toStep?: string };
        if (payload.toStep) {
          currentStep = payload.toStep;
        }
      }
      if (evt.type === 'run_completed') currentStatus = 'completed';
      if (evt.type === 'run_blocked') currentStatus = 'blocked';
      if (evt.type === 'run_paused') currentStatus = 'paused';
      if (evt.type === 'run_uncertain') currentStatus = 'uncertain';
    }

    if (currentStatus === 'completed') {
      return {
        runId,
        stopped: true,
        terminatedHandles: [],
        status: 'completed',
        message: `Run "${runId}" is already completed. No active executions to stop.`,
      };
    }

    // Collect all handles and identify those not yet terminated
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

    const activeHandles = allHandles.filter((h) => !terminatedHandleIds.has(h.id));
    const terminatedHandles: ExecutionHandle[] = [];

    for (const handle of activeHandles) {
      try {
        const stopRes = await this.executor.stop(handle);
        if (!stopRes.stopped || stopRes.uncertain) {
          const reason = `Execution handle "${handle.id}" (${handle.taskId}) failed to terminate: ${stopRes.error || 'uncertain termination'}.`;
          return {
            runId,
            stopped: false,
            terminatedHandles,
            status: currentStatus,
            error: reason,
            message: `Failed to stop run "${runId}": ${reason}`,
          };
        }
        terminatedHandles.push(handle);
        await this.appendEvent(runId, {
          type: 'task_terminated',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: {
            taskId: handle.taskId,
            handle,
            stopped: true,
          },
        });
      } catch (err) {
        const reason = `Execution handle "${handle.id}" (${handle.taskId}) threw on stop: ${(err as Error).message}.`;
        return {
          runId,
          stopped: false,
          terminatedHandles,
          status: currentStatus,
          error: reason,
          message: `Failed to stop run "${runId}": ${reason}`,
        };
      }
    }

    const reason = options.reason || 'Manual stop requested by operator';
    await this.appendEvent(runId, {
      type: 'run_paused',
      run_id: runId,
      timestamp: new Date().toISOString(),
      payload: {
        step: currentStep,
        reason,
        terminatedHandles,
        stoppedAt: new Date().toISOString(),
      },
    });

    return {
      runId,
      stopped: true,
      terminatedHandles,
      status: 'paused',
      message: `Run "${runId}" stopped successfully. All active executions terminated and Run paused at step "${currentStep}".`,
    };
  }

  /**
   * Accepts and validates a specialist role's submitted result.
   * Delegates result recording, duplicate/conflicting checks, and execution teardown
   * to TaskExecution, then computes deterministic step transition and records Run progression.
   */
  async submitResult(runId: string, taskId: string, result: TaskResult): Promise<SubmitResultResponse> {
    // 1. Delegate task result recording, duplicate/conflicting detection, persistence, and execution teardown to TaskExecution
    const facts = await this.taskExecution.recordResult({
      runId,
      taskId,
      result,
    });

    // 2. Handle idempotent resubmission
    if (facts.idempotent) {
      return {
        acknowledged: true,
        taskId: facts.taskId,
        runId: facts.runId,
        step: facts.step,
        outcome: facts.outcome,
        summary: facts.summary,
        artifacts: facts.artifacts,
        executionTerminated: true,
        idempotent: true,
        message: `Result for task "${taskId}" was already acknowledged (idempotent duplicate submission).`,
      };
    }

    const events = await this.readEvents(runId);
    const firstEvent = events[0];
    const initialContext = (firstEvent.payload as { context: RunContext }).context;

    // 3. Verify external GitHub merge outcome for merger role
    if ((facts.role === 'merger' || facts.step === 'merge') && facts.outcome === 'completed') {
      let mergeStatus: MergeStatusResult;
      try {
        mergeStatus = await this.mergeChecker.checkMergeStatus(
          initialContext.repository,
          initialContext.issue,
          facts.worktreePath,
        );
      } catch (err) {
        mergeStatus = {
          exists: false,
          error: (err as Error).message,
        };
      }

      if (mergeStatus.error) {
        await this.appendEvent(runId, {
          type: 'run_uncertain',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: {
            taskId,
            reason: `External merge verification uncertain on GitHub: ${mergeStatus.error}`,
          },
        });

        return {
          acknowledged: true,
          taskId,
          runId,
          step: facts.step,
          outcome: facts.outcome,
          summary: facts.summary,
          artifacts: facts.artifacts,
          executionTerminated: facts.executionTerminated,
          transitionStatus: 'uncertain',
          message: `External merge verification uncertain on GitHub: ${mergeStatus.error}. Preserved explicit uncertainty.`,
        };
      }

      if (!mergeStatus.merged || mergeStatus.state !== 'MERGED') {
        const blockedEvent: RunEvent = {
          type: 'run_blocked',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: {
            taskId,
            step: facts.step,
            reason: `Merge verification failed: PR #${initialContext.issue} is not merged on GitHub (state: ${mergeStatus.state ?? 'unmerged'}). Premature completion prevented.`,
          },
        };
        await this.appendEvent(runId, blockedEvent);

        return {
          acknowledged: true,
          taskId,
          runId,
          step: facts.step,
          outcome: facts.outcome,
          summary: facts.summary,
          artifacts: facts.artifacts,
          executionTerminated: facts.executionTerminated,
          transitionStatus: 'blocked',
          message: `Merge verification failed: PR #${initialContext.issue} is not merged on GitHub. Run is blocked.`,
        };
      }
    }

    // 4. Determine current rework count from event log
    let currentReworkCount = initialContext.rework_count;
    for (const evt of events) {
      if (evt.type === 'step_transitioned') {
        const payload = evt.payload as { reason?: string; reworkCount?: number };
        if (payload.reason === 'rework') {
          currentReworkCount = payload.reworkCount ?? (currentReworkCount + 1);
        }
      }
    }

    const reworkLimit = initialContext.workflow.rework_limit ?? initialContext.config.rework_limit ?? 3;
    const transition = computeNextStep(
      facts.step,
      facts.outcome,
      currentReworkCount,
      reworkLimit,
      initialContext.workflow,
    );

    // 5. Persist transition events
    if (transition.status === 'blocked') {
      const blockedEvent: RunEvent = {
        type: 'run_blocked',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: facts.step,
          reason: facts.summary,
        },
      };
      await this.appendEvent(runId, blockedEvent);
    } else if (transition.status === 'paused') {
      const pausedEvent: RunEvent = {
        type: 'run_paused',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: facts.step,
          reason: transition.reason,
          reworkCount: transition.reworkCount,
          reworkLimit,
          summary: facts.summary,
          artifacts: facts.artifacts,
          message: `Rework limit of ${reworkLimit} rounds exhausted. Run paused with preserved records.`,
        },
      };
      await this.appendEvent(runId, pausedEvent);
    } else if (transition.status === 'completed') {
      const releaseRes = await this.releaseRunResources(runId, {
        taskId,
        summary: facts.summary,
        artifacts: facts.artifacts,
      });

      if (!releaseRes.released) {
        return {
          acknowledged: true,
          taskId,
          runId,
          step: facts.step,
          outcome: facts.outcome,
          summary: facts.summary,
          artifacts: facts.artifacts,
          executionTerminated: facts.executionTerminated,
          transitionStatus: 'blocked',
          message: `Resource release failed: ${releaseRes.error}. Run is blocked.`,
        };
      }

      const stepTransEvent: RunEvent = {
        type: 'step_transitioned',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          fromStep: facts.step,
          toStep: 'completed',
          outcome: facts.outcome,
          reason: transition.reason,
          reworkCount: transition.reworkCount,
          priorTaskId: taskId,
          summary: facts.summary,
          artifacts: facts.artifacts,
        },
      };
      await this.appendEvent(runId, stepTransEvent);

      return {
        acknowledged: true,
        taskId,
        runId,
        step: facts.step,
        outcome: facts.outcome,
        summary: facts.summary,
        artifacts: facts.artifacts,
        executionTerminated: facts.executionTerminated,
        nextStep: 'completed',
        transitionStatus: 'completed',
        reworkCount: transition.reworkCount,
        message: `Result for task "${taskId}" successfully acknowledged. Resources released and Run completed.`,
      };
    } else {
      const stepTransEvent: RunEvent = {
        type: 'step_transitioned',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          fromStep: facts.step,
          toStep: transition.nextStep,
          outcome: facts.outcome,
          reason: transition.reason,
          reworkCount: transition.reworkCount,
          priorTaskId: taskId,
          summary: facts.summary,
          artifacts: facts.artifacts,
          reviewedCommit: facts.artifacts.reviewed_commit,
          mergedCommit: facts.artifacts.merged_commit,
          findings: facts.artifacts.findings,
        },
      };
      await this.appendEvent(runId, stepTransEvent);
    }

    const nextRole = transition.nextStep ? initialContext.workflow.steps[transition.nextStep]?.role : undefined;

    return {
      acknowledged: true,
      taskId,
      runId,
      step: facts.step,
      outcome: facts.outcome,
      summary: facts.summary,
      artifacts: facts.artifacts,
      executionTerminated: facts.executionTerminated,
      nextStep: transition.nextStep,
      nextRole,
      transitionStatus: transition.status,
      reworkCount: transition.reworkCount,
      message: `Result for task "${taskId}" successfully acknowledged. Execution terminated: ${facts.executionTerminated}. Next step: ${transition.nextStep ?? 'none'} (${transition.status}).`,
    };
  }

  /**
   * Reports the current status of a Run reconstructed strictly from its persisted event log.
   * Clearly distinguishes provider execution status from workflow business completion.
   */
  async status(runIdOrOptions?: string | StatusOptions): Promise<StatusResult> {
    let runId: string | undefined;
    if (typeof runIdOrOptions === 'string') {
      runId = runIdOrOptions;
    } else if (runIdOrOptions?.runId) {
      runId = runIdOrOptions.runId;
    }

    if (!runId) {
      try {
        const runDirs = await this.files.listRunIds();
        if (runDirs.length === 0) {
          throw new Error('No workflow runs found.');
        }
        runDirs.sort().reverse();
        runId = runDirs[0];
      } catch (err) {
        throw new Error(`Failed to locate latest workflow run: ${(err as Error).message}`, { cause: err });
      }
    }

    const events = await this.readEvents(runId);
    const firstEvent = events[0];
    if (firstEvent.type !== 'run_created') {
      throw new Error(`First event in log for run "${runId}" must be "run_created".`);
    }

    const initialContext = (firstEvent.payload as { context: RunContext }).context;
    let currentStatus: RunStatus = 'pending_dispatch';
    let currentStep = initialContext.current_step;
    let reworkCount = initialContext.rework_count;

    let activeTaskId: string | undefined;
    let activeStep: string | undefined;
    let activeRole: string | undefined;
    let activeHandle: ExecutionHandle | undefined;
    let latestResult: TaskResult | undefined;
    let isStopped: boolean | undefined;
    let blockedReason: string | undefined;

    for (let i = 1; i < events.length; i++) {
      const evt = events[i];
      switch (evt.type) {
        case 'dispatch_intent': {
          const payload = evt.payload as { taskId: string; step: string; role: string };
          activeTaskId = payload.taskId;
          activeStep = payload.step;
          activeRole = payload.role;
          activeHandle = undefined;
          latestResult = undefined;
          isStopped = false;
          currentStatus = 'running';
          break;
        }
        case 'task_launched': {
          const payload = evt.payload as { taskId: string; handle: ExecutionHandle; step: string; role: string };
          activeTaskId = payload.taskId;
          activeHandle = payload.handle;
          activeStep = payload.step;
          activeRole = payload.role;
          currentStatus = 'running';
          break;
        }
        case 'task_reconciled': {
          const payload = evt.payload as {
            taskId: string;
            handle?: ExecutionHandle;
            action: string;
          };
          if (payload.handle) {
            activeHandle = payload.handle;
          }
          if (payload.action === 'uncertain') {
            currentStatus = 'uncertain';
          }
          break;
        }
        case 'result_submitted': {
          const payload = evt.payload as {
            taskId: string;
            outcome: string;
            summary: string;
            artifacts?: Record<string, unknown>;
          };
          if (payload.taskId === activeTaskId) {
            latestResult = {
              outcome: payload.outcome,
              summary: payload.summary,
              artifacts: payload.artifacts,
            };
          }
          break;
        }
        case 'task_terminated': {
          const payload = evt.payload as { taskId: string; stopped: boolean };
          if (payload.taskId === activeTaskId) {
            isStopped = payload.stopped;
          }
          break;
        }
        case 'step_transitioned': {
          const payload = evt.payload as { toStep?: string; reason?: string; reworkCount?: number };
          if (payload.toStep && payload.toStep !== 'completed') {
            currentStep = payload.toStep;
          }
          if (payload.toStep === 'completed') {
            currentStep = 'completed';
          }
          if (payload.reason === 'rework') {
            reworkCount = payload.reworkCount ?? (reworkCount + 1);
          }
          break;
        }
        case 'run_completed':
          currentStatus = 'completed';
          currentStep = 'completed';
          break;
        case 'run_blocked': {
          currentStatus = 'blocked';
          const payload = evt.payload as { reason?: string };
          blockedReason = payload?.reason;
          break;
        }
        case 'run_paused':
          currentStatus = 'paused';
          break;
        case 'run_uncertain':
          currentStatus = 'uncertain';
          break;
      }
    }

    let activeTaskInfo: StatusActiveTask | undefined;
    if (activeTaskId && activeStep && activeRole) {
      let executionStatus: StatusActiveTask['execution_status'];
      let exitCode: number | undefined;
      let error: string | undefined;
      try {
        const inspection = await this.taskExecution.inspect(activeTaskId);
        executionStatus = inspection.status;
        exitCode = inspection.exitCode;
        error = inspection.error;
      } catch (err) {
        executionStatus = 'uncertain';
        error = (err as Error).message;
      }

      activeTaskInfo = {
        task_id: activeTaskId,
        step: activeStep,
        role: activeRole,
        handle: activeHandle,
        execution_status: executionStatus,
        exit_code: exitCode,
        error,
        business_outcome: latestResult?.outcome,
        result: latestResult,
        stopped: isStopped,
      };
    }

    const reworkLimit = initialContext.workflow.rework_limit ?? initialContext.config.rework_limit ?? 3;
    let summary = `Run ${runId} is ${currentStatus} at step "${currentStep}"`;
    if (reworkCount > 0) {
      summary += ` (rework round ${reworkCount}/${reworkLimit})`;
    }
    summary += ` for issue #${initialContext.issue}.`;

    if (latestResult) {
      summary += ` Collected outcome: ${latestResult.outcome}.`;
    }
    if (currentStatus === 'paused') {
      summary += ` Rework limit of ${reworkLimit} rounds exhausted. Records preserved.`;
    }
    if (currentStatus === 'blocked' && blockedReason) {
      summary += ` Blocker: ${blockedReason}`;
    }
    if (activeTaskInfo?.execution_status === 'exited' && !latestResult) {
      summary += ` Warning: process exited without submitting a business result.`;
    }

    return {
      run_id: runId,
      repository: initialContext.repository,
      issue: initialContext.issue,
      status: currentStatus,
      step: currentStep,
      provider: initialContext.provider,
      created_at: initialContext.created_at,
      worktree_path: initialContext.worktree_path,
      rework_count: reworkCount,
      events_count: events.length,
      summary,
      shared_requirements: initialContext.shared_requirements,
      active_task: activeTaskInfo,
    };
  }

  /**
   * Resumes a previously started Run by reconstructing its recorded progress exclusively
   * from its durable event log, reconciling existing agent executions, and restoring
   * current orchestrator scheduling context.
   */
  async resume(runIdOrOptions?: string | ResumeOptions): Promise<ResumeResult> {
    let runId: string | undefined;
    if (typeof runIdOrOptions === 'string') {
      runId = runIdOrOptions;
    } else if (runIdOrOptions?.runId) {
      runId = runIdOrOptions.runId;
    }

    if (!runId) {
      try {
        const runDirs = await this.files.listRunIds();
        if (runDirs.length === 0) {
          throw new Error('No workflow runs found.');
        }
        runDirs.sort().reverse();
        runId = runDirs[0];
      } catch (err) {
        throw new Error(`Failed to locate latest workflow run: ${(err as Error).message}`, { cause: err });
      }
    }

    const events = await this.readEvents(runId);
    const firstEvent = events[0];
    if (firstEvent.type !== 'run_created') {
      throw new Error(`First event in log for run "${runId}" must be "run_created".`);
    }

    const initialContext = (firstEvent.payload as { context: RunContext }).context;

    // Check worktree ownership safeguards
    let conflictingOwner: string | undefined;
    try {
      const ownerData = await this.files.readWorktreeOwner(initialContext.worktree_path);
      if (ownerData && ownerData.run_id && ownerData.run_id !== runId) {
        conflictingOwner = ownerData.run_id;
      }
    } catch {
      // Owner marker missing or directory does not exist yet
    }

    if (conflictingOwner) {
      throw new WorkflowOwnershipError(
        `Worktree ownership conflict: directory "${initialContext.worktree_path}" is claimed by run "${conflictingOwner}". Cannot resume run "${runId}".`,
      );
    }

    // Reconstruct state from durable event log
    let currentStatus: RunStatus = 'pending_dispatch';
    let currentStep = initialContext.current_step;

    let activeTaskId: string | undefined;
    let activeStep: string | undefined;
    let activeRole: string | undefined;
    let activeHandle: ExecutionHandle | undefined;
    let latestResult: TaskResult | undefined;
    let isStopped: boolean | undefined;
    let taskLaunched = false;

    for (let i = 1; i < events.length; i++) {
      const evt = events[i];
      switch (evt.type) {
        case 'dispatch_intent': {
          const payload = evt.payload as { taskId: string; step: string; role: string };
          activeTaskId = payload.taskId;
          activeStep = payload.step;
          activeRole = payload.role;
          activeHandle = undefined;
          latestResult = undefined;
          isStopped = false;
          taskLaunched = false;
          currentStatus = 'running';
          break;
        }
        case 'task_launched': {
          const payload = evt.payload as { taskId: string; handle: ExecutionHandle; step: string; role: string };
          activeTaskId = payload.taskId;
          activeHandle = payload.handle;
          activeStep = payload.step;
          activeRole = payload.role;
          taskLaunched = true;
          currentStatus = 'running';
          break;
        }
        case 'task_reconciled': {
          const payload = evt.payload as {
            taskId: string;
            handle?: ExecutionHandle;
            action: string;
          };
          if (payload.handle) {
            activeHandle = payload.handle;
          }
          if (payload.action === 'uncertain') {
            currentStatus = 'uncertain';
          }
          break;
        }
        case 'result_submitted': {
          const payload = evt.payload as {
            taskId: string;
            outcome: string;
            summary: string;
            artifacts?: Record<string, unknown>;
          };
          if (payload.taskId === activeTaskId) {
            latestResult = {
              outcome: payload.outcome,
              summary: payload.summary,
              artifacts: payload.artifacts,
            };
          }
          break;
        }
        case 'task_terminated': {
          const payload = evt.payload as { taskId: string; stopped: boolean };
          if (payload.taskId === activeTaskId) {
            isStopped = payload.stopped;
          }
          break;
        }
        case 'step_transitioned': {
          const payload = evt.payload as { toStep?: string };
          if (payload.toStep && payload.toStep !== 'completed') {
            currentStep = payload.toStep;
          }
          if (payload.toStep === 'completed') {
            currentStep = 'completed';
          }
          break;
        }
        case 'run_completed':
          currentStatus = 'completed';
          currentStep = 'completed';
          break;
        case 'run_blocked':
          currentStatus = 'blocked';
          break;
        case 'run_paused':
          currentStatus = 'paused';
          break;
        case 'run_uncertain':
          currentStatus = 'uncertain';
          break;
      }
    }

    // Reconcile task execution if one was dispatched
    let reconciledTask: ReconciledTask | undefined;
    let resumeMessage = `Run "${runId}" resumed at step "${currentStep}".`;

    if (currentStatus === 'completed' || currentStatus === 'blocked') {
      resumeMessage = `Run "${runId}" is already ${currentStatus} at step "${currentStep}".`;
    } else if (activeTaskId && activeStep && activeRole) {
      if (latestResult) {
        // Result was already submitted and durable
        if ((activeStep === 'finalization' || currentStep === 'finalization') && latestResult.outcome === 'completed') {
          // Attempt to reconcile finalization resource release!
          const releaseRes = await this.releaseRunResources(runId, {
            taskId: activeTaskId,
            summary: latestResult.summary,
            artifacts: latestResult.artifacts,
          });

          if (releaseRes.released) {
            await this.appendEvent(runId, {
              type: 'step_transitioned',
              run_id: runId,
              timestamp: new Date().toISOString(),
              payload: {
                fromStep: activeStep,
                toStep: 'completed',
                outcome: latestResult.outcome,
                reason: 'finalization_completed',
                priorTaskId: activeTaskId,
                summary: latestResult.summary,
                artifacts: latestResult.artifacts,
              },
            });
            currentStatus = 'completed';
            currentStep = 'completed';
            resumeMessage = `Resumed and reconciled finalization release for task "${activeTaskId}". Resources released and Run marked completed.`;
          } else {
            currentStatus = 'blocked';
            resumeMessage = `Resumed finalization resource release failed: ${releaseRes.error}. Run is blocked.`;
          }

          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle,
            executionStatus: 'exited',
            action: 'collected',
            result: latestResult,
          };
        } else {
          let executionStatus: ExecutionStatus = isStopped ? 'exited' : 'running';
          try {
            const inspection = await this.executor.inspect(activeTaskId);
            executionStatus = inspection.status;
          } catch {
            // If inspection fails when result is already durable, keep recorded status
          }

          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle,
            executionStatus,
            action: 'collected',
            result: latestResult,
          };
          resumeMessage = `Collected completed task result for task "${activeTaskId}" (outcome: ${latestResult.outcome}).`;
        }
      } else if (activeStep === 'merge' || currentStep === 'merge') {
        let mergeStatus: MergeStatusResult;
        try {
          mergeStatus = await this.mergeChecker.checkMergeStatus(
            initialContext.repository,
            initialContext.issue,
            initialContext.worktree_path,
          );
        } catch (err) {
          mergeStatus = {
            exists: false,
            error: (err as Error).message,
          };
        }

        if (mergeStatus.error) {
          const reconcileEvent: RunEvent = {
            type: 'task_reconciled',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle,
              executionStatus: 'uncertain',
              action: 'uncertain',
              error: mergeStatus.error,
            },
          };
          await this.appendEvent(runId, reconcileEvent);

          const uncertainEvent: RunEvent = {
            type: 'run_uncertain',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: activeTaskId,
              reason: `Interrupted merge status inspection uncertain: ${mergeStatus.error}`,
            },
          };
          await this.appendEvent(runId, uncertainEvent);

          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle,
            executionStatus: 'uncertain',
            action: 'uncertain',
            error: mergeStatus.error,
          };
          resumeMessage = `Interrupted merge inspection uncertain for task "${activeTaskId}": ${mergeStatus.error}. Preserved explicit uncertainty.`;
        } else if (mergeStatus.merged || mergeStatus.state === 'MERGED') {
          // Reconcile state as merged without duplicate merge command!
          const mergedCommit = mergeStatus.mergeCommitSha || 'external-merge-commit';
          const reconciledResult: TaskResult = {
            outcome: 'completed',
            summary: `Reconciled external merge outcome: PR #${initialContext.issue} is confirmed merged on GitHub.`,
            artifacts: {
              merged_commit: mergedCommit,
              reconciled_externally: true,
            },
          };

          const resultEvent: RunEvent = {
            type: 'result_submitted',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              outcome: reconciledResult.outcome,
              summary: reconciledResult.summary,
              artifacts: reconciledResult.artifacts,
            },
          };
          await this.appendEvent(runId, resultEvent);

          if (activeHandle) {
            try {
              await this.executor.stop(activeHandle);
              await this.appendEvent(runId, {
                type: 'task_terminated',
                run_id: runId,
                timestamp: new Date().toISOString(),
                payload: { taskId: activeTaskId, handle: activeHandle, stopped: true },
              });
            } catch {
              // ignore stop error
            }
          }

          const stepTransEvent: RunEvent = {
            type: 'step_transitioned',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              fromStep: 'merge',
              toStep: 'finalization',
              outcome: 'completed',
              reason: 'external_merge_reconciled',
              mergedCommit,
              priorTaskId: activeTaskId,
              summary: reconciledResult.summary,
              artifacts: reconciledResult.artifacts,
            },
          };
          await this.appendEvent(runId, stepTransEvent);

          const reconcileEvent: RunEvent = {
            type: 'task_reconciled',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle,
              executionStatus: 'exited',
              action: 'collected',
            },
          };
          await this.appendEvent(runId, reconcileEvent);

          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle,
            executionStatus: 'exited',
            action: 'collected',
            result: reconciledResult,
          };
          resumeMessage = `Reconciled external merge outcome: PR #${initialContext.issue} is confirmed merged with commit ${mergedCommit}. Advanced to finalization.`;
        } else {
          // PR is not merged yet on GitHub: inspect provider process without duplicating merge
          let inspection: ExecutionInspection;
          try {
            inspection = await this.executor.inspect(activeTaskId);
          } catch (err) {
            inspection = {
              status: 'uncertain',
              error: (err as Error).message,
            };
          }

          if (inspection.status === 'running') {
            activeHandle = activeHandle ?? inspection.handle ?? {
              id: `recovered-handle-${activeTaskId}`,
              taskId: activeTaskId,
            };

            const reconcileEvent: RunEvent = {
              type: 'task_reconciled',
              run_id: runId,
              timestamp: new Date().toISOString(),
              payload: {
                taskId: activeTaskId,
                step: activeStep,
                role: activeRole,
                handle: activeHandle,
                executionStatus: 'running',
                action: 'reconnected',
              },
            };
            await this.appendEvent(runId, reconcileEvent);

            reconciledTask = {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle,
              executionStatus: 'running',
              action: 'reconnected',
            };
            resumeMessage = `Reconnected to running execution for task "${activeTaskId}".`;
          } else if (inspection.status === 'exited') {
            reconciledTask = {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle ?? inspection.handle,
              executionStatus: 'exited',
              action: 'none',
              error: 'Merger process exited without completing the merge.',
            };
            resumeMessage = `Task "${activeTaskId}" exited without completing merge on GitHub.`;
          } else if (inspection.status === 'uncertain' || (taskLaunched && inspection.status === 'not_started')) {
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
                taskId: activeTaskId,
                step: activeStep,
                role: activeRole,
                handle: activeHandle ?? inspection.handle,
                executionStatus: 'uncertain',
                action: 'uncertain',
                error: errorMsg,
              },
            };
            await this.appendEvent(runId, reconcileEvent);

            const uncertainEvent: RunEvent = {
              type: 'run_uncertain',
              run_id: runId,
              timestamp: new Date().toISOString(),
              payload: {
                taskId: activeTaskId,
                reason: errorMsg,
              },
            };
            await this.appendEvent(runId, uncertainEvent);

            currentStatus = 'uncertain';
            reconciledTask = {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle ?? inspection.handle,
              executionStatus: 'uncertain',
              action: 'uncertain',
              error: errorMsg,
            };
            resumeMessage = `Unreconciled execution for task "${activeTaskId}": status is uncertain (${errorMsg}).`;
          } else {
            reconciledTask = {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle,
              executionStatus: 'not_started',
              action: 'none',
            };
            resumeMessage = `Task "${activeTaskId}" was dispatched in intent but not started. Ready for dispatch.`;
          }
        }
      } else {
        // No result submitted yet; inspect provider by stable taskId
        let inspection: ExecutionInspection;
        try {
          inspection = await this.executor.inspect(activeTaskId);
        } catch (err) {
          inspection = {
            status: 'uncertain',
            error: (err as Error).message,
          };
        }

        if (inspection.status === 'running') {
          // Reconnect to running execution
          activeHandle = activeHandle ?? inspection.handle ?? {
            id: `recovered-handle-${activeTaskId}`,
            taskId: activeTaskId,
          };

          const reconcileEvent: RunEvent = {
            type: 'task_reconciled',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle,
              executionStatus: 'running',
              action: 'reconnected',
            },
          };
          await this.appendEvent(runId, reconcileEvent);

          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle,
            executionStatus: 'running',
            action: 'reconnected',
          };
          resumeMessage = `Reconnected to running execution for task "${activeTaskId}".`;
        } else if (inspection.status === 'exited') {
          // Process exited without submitting a result
          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle ?? inspection.handle,
            executionStatus: 'exited',
            action: 'none',
            error: 'Process exited without submitting a result.',
          };
          resumeMessage = `Task "${activeTaskId}" exited without submitting a result.`;
        } else if (inspection.status === 'uncertain' || (taskLaunched && inspection.status === 'not_started')) {
          // Represent unreconciled execution as uncertainty; never assume not started or launch replacement
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
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle ?? inspection.handle,
              executionStatus: 'uncertain',
              action: 'uncertain',
              error: errorMsg,
            },
          };
          await this.appendEvent(runId, reconcileEvent);

          const uncertainEvent: RunEvent = {
            type: 'run_uncertain',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: activeTaskId,
              reason: errorMsg,
            },
          };
          await this.appendEvent(runId, uncertainEvent);

          currentStatus = 'uncertain';
          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle ?? inspection.handle,
            executionStatus: 'uncertain',
            action: 'uncertain',
            error: errorMsg,
          };
          resumeMessage = `Unreconciled execution for task "${activeTaskId}": status is uncertain (${errorMsg}).`;
        } else {
          // not_started: launch never completed before interruption
          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle,
            executionStatus: 'not_started',
            action: 'none',
          };
          resumeMessage = `Task "${activeTaskId}" was dispatched in intent but not started. Ready for dispatch.`;
        }
      }
    }

    // Maintain worktree ownership ONLY if the Run is not completed
    if (currentStatus !== 'completed') {
      const ownerMarker: WorktreeOwnerMarker = {
        run_id: runId,
        repository: initialContext.repository,
        issue: initialContext.issue,
        task_id: activeTaskId,
        role: activeRole ?? initialContext.workflow.steps[currentStep]?.role,
        claimed_at: new Date().toISOString(),
      };
      await this.files.writeWorktreeOwner(initialContext.worktree_path, ownerMarker);
    }

    // Get current scheduling context after reconciliation
    const schedulingContext = await this.getSchedulingContext(runId);
    const updatedEvents = await this.readEvents(runId);

    return {
      runId,
      repository: initialContext.repository,
      issue: initialContext.issue,
      status: schedulingContext.status,
      currentStep: schedulingContext.currentStep,
      worktreePath: initialContext.worktree_path,
      schedulingContext,
      reconciledTask,
      eventsCount: updatedEvents.length,
      message: resumeMessage,
    };
  }

  private deriveRunStatusFromEvents(events: RunEvent[]): RunStatus {
    let status: RunStatus = 'pending_dispatch';
    for (let i = 1; i < events.length; i++) {
      const evt = events[i];
      if (evt.type === 'run_completed') {
        status = 'completed';
      } else if (evt.type === 'run_blocked') {
        status = 'blocked';
      } else if (evt.type === 'run_paused') {
        status = 'paused';
      } else if (evt.type === 'run_uncertain') {
        status = 'uncertain';
      } else if (evt.type === 'task_reconciled') {
        const payload = evt.payload as { action?: string };
        if (payload.action === 'uncertain') status = 'uncertain';
      } else if (evt.type === 'task_launched' || evt.type === 'dispatch_intent') {
        status = 'running';
      }
    }
    return status;
  }

  private deriveRunStatusFromLines(lines: string[]): RunStatus {
    let status: RunStatus = 'pending_dispatch';
    for (let i = 1; i < lines.length; i++) {
      try {
        const evt = JSON.parse(lines[i]) as RunEvent;
        if (evt.type === 'run_completed') {
          status = 'completed';
        } else if (evt.type === 'run_blocked') {
          status = 'blocked';
        } else if (evt.type === 'run_paused') {
          status = 'paused';
        } else if (evt.type === 'run_uncertain') {
          status = 'uncertain';
        } else if (evt.type === 'task_reconciled') {
          const payload = evt.payload as { action?: string };
          if (payload.action === 'uncertain') status = 'uncertain';
        } else if (evt.type === 'task_launched' || evt.type === 'dispatch_intent') {
          status = 'running';
        }
      } catch {
        // ignore parse error in line during quick scan
      }
    }
    return status;
  }
}
