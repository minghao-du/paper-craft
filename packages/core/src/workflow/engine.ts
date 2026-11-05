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
  InitOptions,
  IssueChecker,
  PreflightCheckResult,
  PriorEvidence,
  ProviderChecker,
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

  constructor(options?: WorkflowEngineOptions) {
    this.cwd = options?.cwd ?? process.cwd();
    this.storageRoot = options?.storageRoot
      ? path.resolve(this.cwd, options.storageRoot)
      : path.join(this.cwd, '.paper-craft');
    this.issueChecker = options?.issueChecker ?? new DefaultIssueChecker();
    this.providerChecker = options?.providerChecker ?? new DefaultProviderChecker();
    this.executor = options?.executor ?? new AgyExecutor();
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
                  `Active run "${entryRunId}" already exists for issue #${options.issue} in repository "${config.repository}" with status "${currentStatus}". Inspect status with "pc workflow status --run ${entryRunId}" or recover with "pc workflow recover ${entryRunId}".`,
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
          if (payload.reviewedCommit || payload.findings) {
            priorEvidence = {
              ...priorEvidence,
              evaluatedCommit: payload.reviewedCommit ?? (payload.artifacts?.reviewed_commit as string | undefined),
              findings: payload.findings ?? (payload.artifacts?.findings as string | undefined),
            };
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

    for (let i = 1; i < events.length; i++) {
      const evt = events[i];
      switch (evt.type) {
        case 'dispatch_intent': {
          const payload = evt.payload as { taskId: string; step: string; role: string };
          activeTaskId = payload.taskId;
          activeStep = payload.step;
          activeRole = payload.role;
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
        case 'run_blocked':
          currentStatus = 'blocked';
          break;
        case 'run_paused':
          currentStatus = 'paused';
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

  private deriveRunStatusFromLines(lines: string[]): RunStatus {
    let status: RunStatus = 'pending_dispatch';
    for (let i = 1; i < lines.length; i++) {
      try {
        const evt = JSON.parse(lines[i]) as RunEvent;
        if (evt.type === 'run_completed') return 'completed';
        if (evt.type === 'run_blocked') return 'blocked';
        if (evt.type === 'run_paused') return 'paused';
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
