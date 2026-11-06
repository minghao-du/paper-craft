/**
 * @fileoverview RunState submodule for Run.
 * Single source of truth for runtime constraints, state persistence (append-only JSONL),
 * atomic state transitions, concurrency versioning, and state reconstruction.
 * Internal pure functions RunPolicy and RunView enforce constraints and state folding.
 */

import * as path from 'node:path';
import type {
  ExecutionHandle,
  RoleDefinitions,
  RunEvent,
  RunStatus,
  TaskResult,
  WorkflowConfig,
  WorkflowDefinition,
} from './types.js';
import { WorkflowFiles } from './files.js';

/**
 * Record of a dispatched task within a Run.
 */
export interface TaskRecord {
  /** Stable task identifier. */
  taskId: string;
  /** Task type identifier. */
  taskType: string;
  /** Internal task status. */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';
  /** Provider execution handle if launched. */
  handle?: ExecutionHandle;
  /** Generated prompt. */
  prompt?: string;
  /** Assigned worktree directory. */
  worktreePath?: string;
  /** Inputs provided to task. */
  inputs?: Record<string, unknown>;
  /** Error message if failed. */
  error?: string;
  /** Timestamp when launched. */
  launchedAt?: string;
  /** Timestamp when completed. */
  completedAt?: string;
  /** Submitted result if available. */
  result?: TaskResult;
}

/**
 * Semantic operations accepted by RunState.apply.
 */
export type RunOperation =
  | {
      type: 'create_run';
      context: {
        runId: string;
        repository?: string;
        issue?: number;
        worktreePath?: string;
        provider?: string;
      };
    }
  | { type: 'record_plan'; plan: unknown }
  | {
      type: 'dispatch_intent';
      taskId: string;
      taskType: string;
      prompt: string;
      worktreePath: string;
      inputs?: Record<string, unknown>;
    }
  | { type: 'task_launched'; taskId: string; handle: ExecutionHandle }
  | { type: 'task_launch_failed'; taskId: string; error: string }
  | { type: 'result_submitted'; taskId: string; result: TaskResult }
  | { type: 'task_terminated'; taskId: string; handle: ExecutionHandle; stopped: boolean }
  | { type: 'stop_requested'; reason?: string }
  | { type: 'run_finished'; conclusion: string; evidence: string[] };

/**
 * Reconstructed materialized snapshot of a Run.
 */
export interface RunSnapshot {
  /** Unique Run identifier. */
  runId: string;
  /** Current lifecycle status. */
  status: RunStatus;
  /** Target repository in owner/repo format. */
  repository?: string;
  /** Target issue number. */
  issue?: number;
  /** Dedicated worktree path. */
  worktreePath?: string;
  /** Designated provider identifier. */
  provider?: string;
  /** Orchestrator's plan if recorded. */
  plan?: unknown;
  /** Active running task identifier. */
  activeTaskId?: string;
  /** Last dispatched task identifier. */
  lastTaskId?: string;
  /** Active execution handle. */
  activeHandle?: ExecutionHandle;
  /** Map of taskId to TaskRecord. */
  tasks: Map<string, TaskRecord>;
  /** Map of taskId to validated TaskResult. */
  results: Map<string, TaskResult>;
  /** Total count of persisted events in the run's log. */
  eventsCount: number;
  /** Stop reason if paused. */
  stopReason?: string;
  /** Finish conclusion if completed. */
  finishConclusion?: string;
  /** Finish evidence if completed. */
  finishEvidence?: string[];
  /** Timestamp when created. */
  createdAt?: string;
}

/**
 * Private pure function: evaluates policy constraints against current snapshot
 * before applying an operation. Throws on constraint violations.
 */
function runPolicy(snapshot: RunSnapshot | null, operation: RunOperation): void {
  if (operation.type === 'create_run') {
    if (snapshot && snapshot.eventsCount > 0) {
      if (snapshot.runId !== operation.context.runId) {
        throw new Error(
          `Cannot initialize Run with id "${operation.context.runId}": existing run has id "${snapshot.runId}".`,
        );
      }
    }
    return;
  }

  if (!snapshot) {
    throw new Error(`Run does not exist. Cannot apply operation "${operation.type}".`);
  }

  if (snapshot.status === 'completed') {
    throw new Error(
      `Cannot apply operation "${operation.type}": Run "${snapshot.runId}" is already completed.`,
    );
  }

  if (operation.type === 'dispatch_intent') {
    if (snapshot.status === 'paused') {
      throw new Error(`Cannot dispatch task: Run "${snapshot.runId}" is paused/stopped.`);
    }

    const existingTask = snapshot.tasks.get(operation.taskId);
    if (existingTask) {
      if (
        existingTask.taskType === operation.taskType &&
        existingTask.worktreePath === operation.worktreePath
      ) {
        // Idempotent re-dispatch of identical task
        return;
      }
      throw new Error(
        `Task "${operation.taskId}" already exists with different parameters. Conflicting dispatch rejected.`,
      );
    }

    if (snapshot.activeTaskId) {
      const active = snapshot.tasks.get(snapshot.activeTaskId);
      if (active && (active.status === 'running' || active.status === 'pending')) {
        throw new Error(
          `Cannot dispatch task "${operation.taskId}": Task "${snapshot.activeTaskId}" is currently ${active.status}.`,
        );
      }
    }
    return;
  }

  if (operation.type === 'task_launched') {
    const task = snapshot.tasks.get(operation.taskId);
    if (!task) {
      throw new Error(
        `Cannot record launch: Task "${operation.taskId}" has no recorded dispatch intent.`,
      );
    }
    return;
  }

  if (operation.type === 'task_launch_failed') {
    const task = snapshot.tasks.get(operation.taskId);
    if (!task) {
      throw new Error(
        `Cannot record launch failure: Task "${operation.taskId}" has no recorded dispatch intent.`,
      );
    }
    return;
  }

  if (operation.type === 'result_submitted') {
    const task = snapshot.tasks.get(operation.taskId);
    if (!task) {
      throw new Error(`Cannot submit result: Task "${operation.taskId}" not found in Run.`);
    }
    if (snapshot.results.has(operation.taskId)) {
      const existing = snapshot.results.get(operation.taskId)!;
      if (JSON.stringify(existing) === JSON.stringify(operation.result)) {
        return; // Idempotent duplicate submission
      }
      throw new Error(
        `Result for task "${operation.taskId}" has already been submitted with a different outcome.`,
      );
    }
    return;
  }

  if (operation.type === 'run_finished') {
    if (snapshot.activeTaskId) {
      const active = snapshot.tasks.get(snapshot.activeTaskId);
      if (active && (active.status === 'running' || active.status === 'pending')) {
        throw new Error(
          `Cannot finish Run: Task "${snapshot.activeTaskId}" is still active.`,
        );
      }
    }
    return;
  }
}

/**
 * Private pure function: folds append-only events into a materialized RunSnapshot.
 */
function runView(events: RunEvent[]): RunSnapshot {
  const snapshot: RunSnapshot = {
    runId: '',
    status: 'pending_dispatch',
    tasks: new Map(),
    results: new Map(),
    eventsCount: events.length,
  };

  for (const event of events) {
    switch (event.type) {
      case 'run_created': {
        const payload = event.payload as {
          run_id?: string;
          runId?: string;
          repository?: string;
          issue?: number;
          worktree_path?: string;
          worktreePath?: string;
          provider?: string;
        };
        snapshot.runId = event.run_id || payload.run_id || payload.runId || '';
        snapshot.repository = payload.repository;
        snapshot.issue = payload.issue;
        snapshot.worktreePath = payload.worktree_path || payload.worktreePath;
        snapshot.provider = payload.provider;
        snapshot.createdAt = event.timestamp;
        snapshot.status = 'pending_dispatch';
        break;
      }
      case 'plan_recorded': {
        snapshot.plan = (event.payload as { plan: unknown }).plan;
        break;
      }
      case 'dispatch_intent': {
        const p = event.payload as {
          taskId: string;
          taskType: string;
          prompt: string;
          worktreePath: string;
          inputs?: Record<string, unknown>;
        };
        const task: TaskRecord = {
          taskId: p.taskId,
          taskType: p.taskType,
          status: 'pending',
          prompt: p.prompt,
          worktreePath: p.worktreePath,
          inputs: p.inputs,
        };
        snapshot.tasks.set(p.taskId, task);
        snapshot.activeTaskId = p.taskId;
        snapshot.lastTaskId = p.taskId;
        snapshot.status = 'running';
        break;
      }
      case 'task_launched': {
        const p = event.payload as {
          taskId: string;
          handle: ExecutionHandle;
        };
        const task = snapshot.tasks.get(p.taskId);
        if (task) {
          task.status = 'running';
          task.handle = p.handle;
          task.launchedAt = event.timestamp;
        }
        snapshot.activeHandle = p.handle;
        snapshot.status = 'running';
        break;
      }
      case 'task_launch_failed': {
        const p = event.payload as {
          taskId: string;
          error: string;
        };
        const task = snapshot.tasks.get(p.taskId);
        if (task) {
          task.status = 'failed';
          task.error = p.error;
        }
        snapshot.status = 'uncertain';
        break;
      }
      case 'result_submitted': {
        const p = event.payload as {
          taskId: string;
          result: TaskResult;
        };
        const task = snapshot.tasks.get(p.taskId);
        if (task) {
          task.status = 'completed';
          task.completedAt = event.timestamp;
          task.result = p.result;
        }
        snapshot.results.set(p.taskId, p.result);
        snapshot.activeTaskId = undefined;
        snapshot.activeHandle = undefined;

        if (p.result.outcome === 'blocked') {
          snapshot.status = 'blocked';
        } else {
          snapshot.status = 'pending_dispatch';
        }
        break;
      }
      case 'task_terminated': {
        const p = event.payload as {
          taskId: string;
        };
        const task = snapshot.tasks.get(p.taskId);
        if (task && task.status === 'running') {
          task.status = 'uncertain';
        }
        snapshot.activeHandle = undefined;
        break;
      }
      case 'stop_requested': {
        snapshot.status = 'paused';
        snapshot.stopReason = (event.payload as { reason?: string }).reason;
        break;
      }
      case 'run_finished': {
        const p = event.payload as {
          conclusion: string;
          evidence: string[];
        };
        snapshot.status = 'completed';
        snapshot.finishConclusion = p.conclusion;
        snapshot.finishEvidence = p.evidence;
        break;
      }
    }
  }

  return snapshot;
}

/**
 * RunState manages durable append-only event logs, atomic operation transitions,
 * and state reconstruction.
 */
export class RunState {
  private readonly storageRoot: string;
  private readonly files: WorkflowFiles;

  constructor(storageRoot: string) {
    this.storageRoot = path.resolve(storageRoot);
    this.files = new WorkflowFiles(this.storageRoot);
  }

  /**
   * Reads the current durable state of a Run and reconstructs RunSnapshot.
   */
  async read(runId: string): Promise<RunSnapshot> {
    const events = await this.files.loadRun(runId);
    return runView(events);
  }

  /**
   * Applies a semantic operation atomically: enforces RunPolicy constraints,
   * writes event to durable append-only log, and returns updated RunSnapshot.
   */
  async apply(runId: string, operation: RunOperation): Promise<RunSnapshot> {
    let currentSnapshot: RunSnapshot | null = null;
    let events: RunEvent[] = [];
    try {
      events = await this.files.loadRun(runId);
      currentSnapshot = runView(events);
    } catch {
      // First operation on this run
    }

    // 1. Enforce constraints
    runPolicy(currentSnapshot, operation);

    // 2. Format event
    const eventType =
      operation.type === 'create_run'
        ? 'run_created'
        : operation.type === 'record_plan'
          ? 'plan_recorded'
          : operation.type;

    const payload =
      operation.type === 'create_run'
        ? operation.context
        : operation.type === 'record_plan'
          ? { plan: operation.plan }
          : operation;

    const newEvent: RunEvent = {
      type: eventType,
      run_id: runId,
      timestamp: new Date().toISOString(),
      payload: payload as Record<string, unknown>,
    };

    // 3. Persist atomically
    if (operation.type === 'create_run' && !currentSnapshot) {
      await this.files.createRun({
        run_id: runId,
        repository: operation.context.repository ?? '',
        issue: operation.context.issue ?? 0,
        provider: operation.context.provider ?? 'agy',
        worktree_path: operation.context.worktreePath ?? '',
        created_at: newEvent.timestamp,
        status: 'pending_dispatch',
        current_step: 'initial',
        rework_count: 0,
        shared_requirements: '',
        config: {} as unknown as WorkflowConfig,
        workflow: {} as unknown as WorkflowDefinition,
        roles: {} as unknown as RoleDefinitions,
      });
      events = [newEvent];
    } else {
      await this.files.record(runId, newEvent);
      events.push(newEvent);
    }

    // 4. Return new reconstructed snapshot
    return runView(events);
  }
}
