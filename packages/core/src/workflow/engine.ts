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

  constructor(options?: WorkflowEngineOptions) {
    this.cwd = options?.cwd ?? process.cwd();
    this.storageRoot = options?.storageRoot
      ? path.resolve(this.cwd, options.storageRoot)
      : path.join(this.cwd, '.paper-craft');
    this.issueChecker = options?.issueChecker ?? new DefaultIssueChecker();
    this.providerChecker = options?.providerChecker ?? new DefaultProviderChecker();
    this.executor = options?.executor ?? new AgyExecutor();
    this.mergeChecker = options?.mergeChecker ?? new DefaultGitHubMergeChecker();
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
    const runsDir = path.join(this.storageRoot, 'runs');
    try {
      const runEntries = await fs.readdir(runsDir, { withFileTypes: true });
      for (const entry of runEntries) {
        if (!entry.isDirectory()) continue;
        const entryRunId = entry.name;
        const eventsPath = path.join(runsDir, entryRunId, 'events.jsonl');
        try {
          const eventsContent = await fs.readFile(eventsPath, 'utf8');
          const lines = eventsContent.trim().split('\n').filter(Boolean);
          if (lines.length === 0) continue;

          const firstEvent = JSON.parse(lines[0]) as RunEvent;
          if (firstEvent.type === 'run_created') {
            const ctx = (firstEvent.payload as { context: RunContext }).context;
            if (ctx.repository === config.repository && ctx.issue === options.issue) {
              const currentStatus = this.deriveRunStatusFromLines(lines);
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
    const ownerMarkerPath = path.join(targetWorktree, '.pc-execution-owner');
    try {
      const ownerRaw = await fs.readFile(ownerMarkerPath, 'utf8');
      const ownerData = JSON.parse(ownerRaw);
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

    // Create worktree directory and claim ownership
    await fs.mkdir(worktreePath, { recursive: true });
    const ownerMarker = {
      run_id: runId,
      repository: config.repository,
      issue: options.issue,
      claimed_at: nowIso,
    };
    await fs.writeFile(
      path.join(worktreePath, '.pc-execution-owner'),
      JSON.stringify(ownerMarker, null, 2),
      'utf8',
    );

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

    // Persist run directory and initial event log
    const runDir = path.join(this.storageRoot, 'runs', runId);
    await fs.mkdir(runDir, { recursive: true });

    const initialEvent: RunEvent = {
      type: 'run_created',
      run_id: runId,
      timestamp: nowIso,
      payload: {
        context: runContext,
      },
    };

    const eventLogPath = path.join(runDir, 'events.jsonl');
    await fs.writeFile(eventLogPath, `${JSON.stringify(initialEvent)}\n`, 'utf8');

    return runContext;
  }

  /**
   * Reads all events for a given run from its JSONL event log.
   */
  async readEvents(runId: string): Promise<RunEvent[]> {
    const eventLogPath = path.join(this.storageRoot, 'runs', runId, 'events.jsonl');
    let rawLog: string;
    try {
      rawLog = await fs.readFile(eventLogPath, 'utf8');
    } catch {
      throw new Error(`Workflow run "${runId}" not found or missing event log at: ${eventLogPath}`);
    }
    const lines = rawLog.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      throw new Error(`Workflow run "${runId}" has empty event log.`);
    }
    return lines.map((l) => JSON.parse(l) as RunEvent);
  }

  /**
   * Appends an event to the run's JSONL event log.
   */
  async appendEvent(runId: string, event: RunEvent): Promise<void> {
    const runDir = path.join(this.storageRoot, 'runs', runId);
    await fs.mkdir(runDir, { recursive: true });
    const eventLogPath = path.join(runDir, 'events.jsonl');
    await fs.appendFile(eventLogPath, `${JSON.stringify(event)}\n`, 'utf8');
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
          priorEvidence = {
            evaluatedCommit: payload.artifacts?.reviewed_commit as string | undefined,
            findings: payload.artifacts?.findings as string | undefined,
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
          };
          if (payload.toStep && payload.toStep !== 'completed') {
            currentStep = payload.toStep;
          }
          if (payload.reason === 'rework') {
            reworkCount = payload.reworkCount ?? (reworkCount + 1);
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
          currentStatus = 'pending_dispatch';
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
      evaluatedCommit: priorEvidence?.evaluatedCommit,
      reviewFindings: priorEvidence?.findings,
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

    // 1. Prepare dedicated worktree
    await fs.mkdir(context.worktreePath, { recursive: true });

    // Update or write ownership marker
    const ownerMarker = {
      run_id: runId,
      repository: context.repository,
      issue: context.issue,
      task_id: taskId,
      role: context.stepDefinition.role,
      claimed_at: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(context.worktreePath, '.pc-execution-owner'),
      JSON.stringify(ownerMarker, null, 2),
      'utf8',
    );

    // Write initialization.json into the worktree
    const initData = {
      run_id: runId,
      task_id: taskId,
      role: context.stepDefinition.role,
      step: context.currentStep,
      skill: context.roleContract.skill,
      checkout: context.worktreePath,
      repository: context.repository,
      issue: context.issue,
      shared_requirements: context.sharedRequirements,
      task_instructions: taskInstructions,
      inputs: {
        ...(context.priorEvidence ? { prior_evidence: context.priorEvidence } : {}),
        ...(options?.inputs ?? {}),
      },
      permitted_outcomes: context.roleContract.permitted_outcomes,
      required_artifacts: context.roleContract.required_artifacts ?? [],
      prior_evidence: context.priorEvidence,
    };
    await fs.writeFile(
      path.join(context.worktreePath, 'initialization.json'),
      JSON.stringify(initData, null, 2),
      'utf8',
    );

    // 2. Persist dispatch intent event BEFORE launch
    const intentEvent: RunEvent = {
      type: 'dispatch_intent',
      run_id: runId,
      timestamp: new Date().toISOString(),
      payload: {
        taskId,
        step: context.currentStep,
        role: context.stepDefinition.role,
        skill: context.roleContract.skill,
        taskInstructions,
        inputs: options?.inputs ?? {},
        priorEvidence: context.priorEvidence,
        worktreePath: context.worktreePath,
      },
    };
    await this.appendEvent(runId, intentEvent);

    // 3. Compose worker prompt
    const promptLines = [
      `# Task Assignment: ${context.currentStep} (${context.stepDefinition.role})`,
      `Run: ${runId}`,
      `Task: ${taskId}`,
      `Skill: ${context.roleContract.skill}`,
      '',
      '## Shared Requirements',
      context.sharedRequirements || 'None specified.',
    ];

    if (context.priorEvidence) {
      promptLines.push('', '## Prior Evidence & Review Findings');
      if (context.priorEvidence.evaluatedCommit) {
        promptLines.push(`Evaluated Commit: ${context.priorEvidence.evaluatedCommit}`);
      }
      if (context.priorEvidence.findings) {
        promptLines.push(`Review Findings:\n${context.priorEvidence.findings}`);
      }
      if (context.priorEvidence.priorSummary) {
        promptLines.push(`Prior Summary: ${context.priorEvidence.priorSummary}`);
      }
    }

    promptLines.push(
      '',
      '## Task Instructions',
      taskInstructions,
      '',
      '## Permitted Outcomes',
      context.roleContract.permitted_outcomes.join(', '),
      '',
      '## Required Artifacts',
      (context.roleContract.required_artifacts ?? []).join(', ') || 'None',
      '',
      '## Submission Contract',
      `When finished, submit your result using:`,
      `pc workflow submit-result --run "${runId}" --task "${taskId}" --outcome <outcome> --summary "<summary>" --artifacts '<artifacts-json>'`,
    );

    const prompt = promptLines.join('\n');

    // 4. Launch execution via provider Executor
    let handle: ExecutionHandle;
    try {
      handle = await this.executor.launch(taskId, context.worktreePath, prompt);
    } catch (err) {
      const launchErrEvent: RunEvent = {
        type: 'task_launch_failed',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          error: (err as Error).message,
        },
      };
      await this.appendEvent(runId, launchErrEvent);
      throw err;
    }

    // 5. Persist task_launched event recording the provider handle
    const launchedEvent: RunEvent = {
      type: 'task_launched',
      run_id: runId,
      timestamp: new Date().toISOString(),
      payload: {
        taskId,
        step: context.currentStep,
        role: context.stepDefinition.role,
        handle,
        launchedAt: new Date().toISOString(),
      },
    };
    await this.appendEvent(runId, launchedEvent);

    return {
      taskId,
      handle,
      step: context.currentStep,
      role: context.stepDefinition.role,
      worktreePath: context.worktreePath,
    };
  }

  /**
   * Accepts and validates a specialist role's submitted result.
   * Validates task ownership, permitted outcomes, and required artifacts before acknowledgement.
   * Verifies termination of that role execution upon submission.
   */
  async submitResult(runId: string, taskId: string, result: TaskResult): Promise<SubmitResultResponse> {
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('Valid taskId is required to submit a result.');
    }
    if (!result || !result.outcome || typeof result.outcome !== 'string') {
      throw new Error('TaskResult must specify an outcome.');
    }
    if (!result.summary || typeof result.summary !== 'string') {
      throw new Error('TaskResult must specify a summary.');
    }

    const events = await this.readEvents(runId);
    const firstEvent = events[0];
    const initialContext = (firstEvent.payload as { context: RunContext }).context;

    // Locate dispatch / task event for taskId
    let taskEvent: RunEvent | undefined;
    let handle: ExecutionHandle | undefined;
    let existingResultEvent: RunEvent | undefined;

    for (const evt of events) {
      if (evt.type === 'dispatch_intent' && (evt.payload as { taskId: string }).taskId === taskId) {
        taskEvent = evt;
      }
      if (evt.type === 'task_launched' && (evt.payload as { taskId: string }).taskId === taskId) {
        handle = (evt.payload as { handle: ExecutionHandle }).handle;
      }
      if (evt.type === 'result_submitted' && (evt.payload as { taskId: string }).taskId === taskId) {
        existingResultEvent = evt;
      }
    }

    if (!taskEvent) {
      throw new Error(`Task "${taskId}" not found in run "${runId}".`);
    }

    const taskPayload = taskEvent.payload as {
      step: string;
      role: string;
      worktreePath: string;
    };

    // Check if result already submitted for this taskId
    if (existingResultEvent) {
      const prior = existingResultEvent.payload as {
        outcome: string;
        summary: string;
        artifacts?: Record<string, unknown>;
      };

      const normalize = (obj: unknown) => JSON.stringify(obj ?? {});
      const isIdentical =
        prior.outcome === result.outcome &&
        prior.summary === result.summary &&
        normalize(prior.artifacts) === normalize(result.artifacts);

      if (isIdentical) {
        return {
          acknowledged: true,
          taskId,
          runId,
          step: taskPayload.step,
          outcome: result.outcome,
          summary: result.summary,
          artifacts: result.artifacts ?? {},
          executionTerminated: true,
          idempotent: true,
          message: `Result for task "${taskId}" was already acknowledged (idempotent duplicate submission).`,
        };
      }

      throw new Error(
        `Conflicting result submitted for task "${taskId}". A prior result with outcome "${prior.outcome}" is already recorded.`,
      );
    }

    // Role contract validation
    const roleContract = initialContext.roles.roles[taskPayload.role];
    if (!roleContract) {
      throw new Error(`Role contract for "${taskPayload.role}" is not defined.`);
    }

    if (!roleContract.permitted_outcomes.includes(result.outcome)) {
      throw new Error(
        `Outcome "${result.outcome}" is not permitted for role "${taskPayload.role}". Permitted outcomes: [${roleContract.permitted_outcomes.join(', ')}].`,
      );
    }

    // Workflow step transitions validation
    const stepDef = initialContext.workflow.steps[taskPayload.step];
    if (!stepDef) {
      throw new Error(`Step "${taskPayload.step}" is not defined in workflow definition.`);
    }
    if (!(result.outcome in stepDef.transitions)) {
      const permitted = Object.keys(stepDef.transitions).join(', ');
      throw new Error(
        `Step "${taskPayload.step}" does not define a transition for outcome "${result.outcome}". Permitted transitions: [${permitted}].`,
      );
    }

    const required = roleContract.required_artifacts ?? [];
    const artifacts = result.artifacts ?? {};
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

    // Determine current rework count from event log
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
      taskPayload.step,
      result.outcome,
      currentReworkCount,
      reworkLimit,
      initialContext.workflow,
    );

    // Verify external GitHub merge outcome for merger role
    if ((taskPayload.role === 'merger' || taskPayload.step === 'merge') && result.outcome === 'completed') {
      let mergeStatus: MergeStatusResult;
      try {
        mergeStatus = await this.mergeChecker.checkMergeStatus(
          initialContext.repository,
          initialContext.issue,
          taskPayload.worktreePath,
        );
      } catch (err) {
        mergeStatus = {
          exists: false,
          error: (err as Error).message,
        };
      }

      if (mergeStatus.error) {
        const nowIso = new Date().toISOString();
        const resultSubmittedEvent: RunEvent = {
          type: 'result_submitted',
          run_id: runId,
          timestamp: nowIso,
          payload: {
            taskId,
            step: taskPayload.step,
            role: taskPayload.role,
            outcome: result.outcome,
            summary: result.summary,
            artifacts,
          },
        };
        await this.appendEvent(runId, resultSubmittedEvent);

        let executionTerminated = true;
        if (handle) {
          const stopRes = await this.executor.stop(handle);
          executionTerminated = stopRes.stopped;
          await this.appendEvent(runId, {
            type: 'task_terminated',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId,
              handle,
              stopped: stopRes.stopped,
              uncertain: stopRes.uncertain,
              error: stopRes.error,
            },
          });
        }

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
          step: taskPayload.step,
          outcome: result.outcome,
          summary: result.summary,
          artifacts,
          executionTerminated,
          transitionStatus: 'uncertain',
          message: `External merge verification uncertain on GitHub: ${mergeStatus.error}. Preserved explicit uncertainty.`,
        };
      }

      if (!mergeStatus.merged || mergeStatus.state !== 'MERGED') {
        const nowIso = new Date().toISOString();
        const resultSubmittedEvent: RunEvent = {
          type: 'result_submitted',
          run_id: runId,
          timestamp: nowIso,
          payload: {
            taskId,
            step: taskPayload.step,
            role: taskPayload.role,
            outcome: result.outcome,
            summary: result.summary,
            artifacts,
          },
        };
        await this.appendEvent(runId, resultSubmittedEvent);

        let executionTerminated = true;
        if (handle) {
          const stopRes = await this.executor.stop(handle);
          executionTerminated = stopRes.stopped;
          await this.appendEvent(runId, {
            type: 'task_terminated',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId,
              handle,
              stopped: stopRes.stopped,
              uncertain: stopRes.uncertain,
              error: stopRes.error,
            },
          });
        }

        const blockedEvent: RunEvent = {
          type: 'run_blocked',
          run_id: runId,
          timestamp: new Date().toISOString(),
          payload: {
            taskId,
            step: taskPayload.step,
            reason: `Merge verification failed: PR #${initialContext.issue} is not merged on GitHub (state: ${mergeStatus.state ?? 'unmerged'}). Premature completion prevented.`,
          },
        };
        await this.appendEvent(runId, blockedEvent);

        return {
          acknowledged: true,
          taskId,
          runId,
          step: taskPayload.step,
          outcome: result.outcome,
          summary: result.summary,
          artifacts,
          executionTerminated,
          transitionStatus: 'blocked',
          message: `Merge verification failed: PR #${initialContext.issue} is not merged on GitHub. Run is blocked.`,
        };
      }
    }

    // Persist result_submitted event
    const nowIso = new Date().toISOString();
    const resultSubmittedEvent: RunEvent = {
      type: 'result_submitted',
      run_id: runId,
      timestamp: nowIso,
      payload: {
        taskId,
        step: taskPayload.step,
        role: taskPayload.role,
        outcome: result.outcome,
        summary: result.summary,
        artifacts,
      },
    };
    await this.appendEvent(runId, resultSubmittedEvent);

    // Verify termination of the role execution
    let executionTerminated = true;
    if (handle) {
      const stopRes = await this.executor.stop(handle);
      executionTerminated = stopRes.stopped;

      const termEvent: RunEvent = {
        type: 'task_terminated',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          handle,
          stopped: stopRes.stopped,
          uncertain: stopRes.uncertain,
          error: stopRes.error,
        },
      };
      await this.appendEvent(runId, termEvent);
    }

    // Persist transition events
    if (transition.status === 'blocked') {
      const blockedEvent: RunEvent = {
        type: 'run_blocked',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: taskPayload.step,
          reason: result.summary,
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
          step: taskPayload.step,
          reason: transition.reason,
          reworkCount: transition.reworkCount,
          reworkLimit,
          summary: result.summary,
          artifacts,
          message: `Rework limit of ${reworkLimit} rounds exhausted. Run paused with preserved records.`,
        },
      };
      await this.appendEvent(runId, pausedEvent);
    } else if (transition.status === 'completed') {
      const stepTransEvent: RunEvent = {
        type: 'step_transitioned',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          fromStep: taskPayload.step,
          toStep: 'completed',
          outcome: result.outcome,
          reason: transition.reason,
          reworkCount: transition.reworkCount,
          priorTaskId: taskId,
          summary: result.summary,
          artifacts,
        },
      };
      await this.appendEvent(runId, stepTransEvent);

      const compEvent: RunEvent = {
        type: 'run_completed',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          taskId,
          step: taskPayload.step,
          summary: result.summary,
        },
      };
      await this.appendEvent(runId, compEvent);
    } else {
      const stepTransEvent: RunEvent = {
        type: 'step_transitioned',
        run_id: runId,
        timestamp: new Date().toISOString(),
        payload: {
          fromStep: taskPayload.step,
          toStep: transition.nextStep,
          outcome: result.outcome,
          reason: transition.reason,
          reworkCount: transition.reworkCount,
          priorTaskId: taskId,
          summary: result.summary,
          artifacts,
          reviewedCommit: artifacts.reviewed_commit,
          mergedCommit: artifacts.merged_commit,
          findings: artifacts.findings,
        },
      };
      await this.appendEvent(runId, stepTransEvent);
    }

    const nextRole = transition.nextStep ? initialContext.workflow.steps[transition.nextStep]?.role : undefined;

    return {
      acknowledged: true,
      taskId,
      runId,
      step: taskPayload.step,
      outcome: result.outcome,
      summary: result.summary,
      artifacts,
      executionTerminated,
      nextStep: transition.nextStep,
      nextRole,
      transitionStatus: transition.status,
      reworkCount: transition.reworkCount,
      message: `Result for task "${taskId}" successfully acknowledged. Execution terminated: ${executionTerminated}. Next step: ${transition.nextStep ?? 'none'} (${transition.status}).`,
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

    const runsDir = path.join(this.storageRoot, 'runs');

    if (!runId) {
      try {
        const entries = await fs.readdir(runsDir, { withFileTypes: true });
        const runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
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
          if (payload.reason === 'rework') {
            reworkCount = payload.reworkCount ?? (reworkCount + 1);
          }
          break;
        }
        case 'run_completed':
          currentStatus = 'completed';
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
        const inspection = await this.executor.inspect(activeTaskId);
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

    const runsDir = path.join(this.storageRoot, 'runs');

    if (!runId) {
      try {
        const entries = await fs.readdir(runsDir, { withFileTypes: true });
        const runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
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
    const ownerMarkerPath = path.join(initialContext.worktree_path, '.pc-execution-owner');
    let conflictingOwner: string | undefined;
    try {
      const ownerRaw = await fs.readFile(ownerMarkerPath, 'utf8');
      const ownerData = JSON.parse(ownerRaw);
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
          const payload = evt.payload as { toStep?: string };
          if (payload.toStep && payload.toStep !== 'completed') {
            currentStep = payload.toStep;
          }
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

    // Reconcile task execution if one was dispatched
    let reconciledTask: ReconciledTask | undefined;
    let resumeMessage = `Run "${runId}" resumed at step "${currentStep}".`;

    if (currentStatus === 'completed' || currentStatus === 'blocked') {
      resumeMessage = `Run "${runId}" is already ${currentStatus} at step "${currentStep}".`;
    } else if (activeTaskId && activeStep && activeRole) {
      if (latestResult) {
        // Result was already submitted and durable
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
          } else if (inspection.status === 'uncertain') {
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
                error: inspection.error,
              },
            };
            await this.appendEvent(runId, reconcileEvent);

            const uncertainEvent: RunEvent = {
              type: 'run_uncertain',
              run_id: runId,
              timestamp: new Date().toISOString(),
              payload: {
                taskId: activeTaskId,
                reason: inspection.error || 'Execution status is uncertain from provider.',
              },
            };
            await this.appendEvent(runId, uncertainEvent);

            reconciledTask = {
              taskId: activeTaskId,
              step: activeStep,
              role: activeRole,
              handle: activeHandle ?? inspection.handle,
              executionStatus: 'uncertain',
              action: 'uncertain',
              error: inspection.error || 'Execution status is uncertain.',
            };
            resumeMessage = `Unreconciled execution for task "${activeTaskId}": status is uncertain (${inspection.error ?? 'unknown error'}).`;
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
        } else if (inspection.status === 'uncertain') {
          // Represent unreconciled execution as uncertainty; never assume not started or launch replacement
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
              error: inspection.error,
            },
          };
          await this.appendEvent(runId, reconcileEvent);

          const uncertainEvent: RunEvent = {
            type: 'run_uncertain',
            run_id: runId,
            timestamp: new Date().toISOString(),
            payload: {
              taskId: activeTaskId,
              reason: inspection.error || 'Execution status is uncertain from provider.',
            },
          };
          await this.appendEvent(runId, uncertainEvent);

          reconciledTask = {
            taskId: activeTaskId,
            step: activeStep,
            role: activeRole,
            handle: activeHandle ?? inspection.handle,
            executionStatus: 'uncertain',
            action: 'uncertain',
            error: inspection.error || 'Execution status is uncertain.',
          };
          resumeMessage = `Unreconciled execution for task "${activeTaskId}": status is uncertain (${inspection.error ?? 'unknown error'}).`;
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

    // Maintain worktree ownership
    await fs.mkdir(initialContext.worktree_path, { recursive: true });
    const ownerMarker = {
      run_id: runId,
      repository: initialContext.repository,
      issue: initialContext.issue,
      task_id: activeTaskId,
      role: activeRole ?? initialContext.workflow.steps[currentStep]?.role,
      claimed_at: new Date().toISOString(),
    };
    await fs.writeFile(
      ownerMarkerPath,
      JSON.stringify(ownerMarker, null, 2),
      'utf8',
    );

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

  private deriveRunStatusFromLines(lines: string[]): RunStatus {
    let status: RunStatus = 'pending_dispatch';
    for (let i = 1; i < lines.length; i++) {
      try {
        const evt = JSON.parse(lines[i]) as RunEvent;
        if (evt.type === 'run_completed') return 'completed';
        if (evt.type === 'run_blocked') return 'blocked';
        if (evt.type === 'run_paused') return 'paused';
        if (evt.type === 'run_uncertain') return 'uncertain';
        if (evt.type === 'task_reconciled') {
          const payload = evt.payload as { action?: string };
          if (payload.action === 'uncertain') return 'uncertain';
        }
        if (evt.type === 'task_launched' || evt.type === 'dispatch_intent') {
          status = 'running';
        }
      } catch {
        // ignore parse error in line during quick scan
      }
    }
    return status;
  }
}
