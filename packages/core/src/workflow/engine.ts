/**
 * @fileoverview Deterministic Workflow Engine owning Run lifecycle, intake preflight, and persistence.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  InitOptions,
  IssueChecker,
  PreflightCheckResult,
  ProviderChecker,
  RunContext,
  RunEvent,
  RunStatus,
  StartOptions,
  StatusOptions,
  StatusResult,
} from './types.js';
import {
  initWorkflowConfig,
  loadWorkflowConfig,
} from './config.js';
import {
  DefaultIssueChecker,
  DefaultProviderChecker,
} from './checkers.js';

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
}

/**
 * The Workflow Engine is the deterministic driver of workflow runs, configuration,
 * and immutable event logging.
 */
export class WorkflowEngine {
  public readonly cwd: string;
  public readonly storageRoot: string;
  public readonly issueChecker: IssueChecker;
  public readonly providerChecker: ProviderChecker;

  constructor(options?: WorkflowEngineOptions) {
    this.cwd = options?.cwd ?? process.cwd();
    this.storageRoot = options?.storageRoot
      ? path.resolve(this.cwd, options.storageRoot)
      : path.join(this.cwd, '.paper-craft');
    this.issueChecker = options?.issueChecker ?? new DefaultIssueChecker();
    this.providerChecker = options?.providerChecker ?? new DefaultProviderChecker();
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
              // Replay to determine current status
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
   * Reports the current status of a Run reconstructed strictly from its persisted event log.
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
      // Find latest created run
      try {
        const entries = await fs.readdir(runsDir, { withFileTypes: true });
        const runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        if (runDirs.length === 0) {
          throw new Error('No workflow runs found.');
        }
        // Sort descending by directory creation / timestamp in name
        runDirs.sort().reverse();
        runId = runDirs[0];
      } catch (err) {
        throw new Error(`Failed to locate latest workflow run: ${(err as Error).message}`, { cause: err });
      }
    }

    const runDir = path.join(runsDir, runId);
    const eventLogPath = path.join(runDir, 'events.jsonl');

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

    const events: RunEvent[] = lines.map((l) => JSON.parse(l));
    const firstEvent = events[0];
    if (firstEvent.type !== 'run_created') {
      throw new Error(`First event in log for run "${runId}" must be "run_created".`);
    }

    const initialContext = (firstEvent.payload as { context: RunContext }).context;
    let currentStatus: RunStatus = 'pending_dispatch';
    let currentStep = initialContext.current_step;
    let reworkCount = initialContext.rework_count;

    for (let i = 1; i < events.length; i++) {
      const evt = events[i];
      switch (evt.type) {
        case 'dispatch_intent':
        case 'task_launched':
          currentStatus = 'running';
          break;
        case 'step_transitioned': {
          const payload = evt.payload as { toStep?: string; reason?: string };
          if (payload.toStep) {
            currentStep = payload.toStep;
          }
          if (payload.reason === 'rework') {
            reworkCount++;
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
      summary: `Run ${runId} is ${currentStatus} at step "${currentStep}" for issue #${initialContext.issue}.`,
      shared_requirements: initialContext.shared_requirements,
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
