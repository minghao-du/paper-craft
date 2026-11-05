/**
 * @fileoverview Unified storage layout and files management for workflow runs,
 * events persistence, requirement snapshots, and worktree ownership markers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RunContext, RunEvent } from './types.js';

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
 * Custom error raised when resource cleanup or preservation verification fails.
 */
export class WorkflowCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCleanupError';
  }
}

/**
 * Result returned by WorkflowFiles after validating ownership and releasing a worktree.
 */
export interface ReleaseWorktreeResult {
  /** Whether the release verification and cleanup completed successfully. */
  released: boolean;
  /** Whether the worktree directory existed and was deleted. */
  worktreeRemoved: boolean;
  /** Target worktree directory path. */
  worktreePath: string;
  /** Error message if cleanup failed or ownership check was violated. */
  error?: string;
}

/**
 * Ownership marker recorded in `.pc-execution-owner` to claim worktree authority.
 */
export interface WorktreeOwnerMarker {
  /** Unique Run identifier owning this worktree. */
  run_id: string;
  /** Repository in owner/repo format. */
  repository: string;
  /** Target issue number. */
  issue: number;
  /** Active task ID if assigned. */
  task_id?: string;
  /** Active specialist role if assigned. */
  role?: string;
  /** ISO timestamp when ownership was claimed or updated. */
  claimed_at: string;
}

/**
 * Options for configuring WorkflowFiles storage.
 */
export interface WorkflowFilesOptions {
  /** Storage root directory for durable state and event logs. */
  storageRoot: string;
}

/**
 * Manages run documents, requirement snapshots, event persistence, and worktree ownership markers.
 * Files does not evaluate business progression or execution rules.
 */
export class WorkflowFiles {
  public readonly storageRoot: string;

  constructor(optionsOrRoot: string | WorkflowFilesOptions) {
    this.storageRoot =
      typeof optionsOrRoot === 'string'
        ? optionsOrRoot
        : optionsOrRoot.storageRoot;
  }

  /**
   * Returns the directory path for a specific Run.
   */
  getRunDir(runId: string): string {
    return path.join(this.storageRoot, 'runs', runId);
  }

  /**
   * Returns the path to the events.jsonl log file for a specific Run.
   */
  getEventLogPath(runId: string): string {
    return path.join(this.getRunDir(runId), 'events.jsonl');
  }

  /**
   * Returns the root directory containing all runs.
   */
  getRunsDir(): string {
    return path.join(this.storageRoot, 'runs');
  }

  /**
   * Returns the path to the .pc-execution-owner marker file for a worktree.
   */
  getWorktreeOwnerPath(worktreePath: string): string {
    return path.join(worktreePath, '.pc-execution-owner');
  }

  /**
   * Returns the path to the initialization.json file for a worktree.
   */
  getTaskInitializationPath(worktreePath: string): string {
    return path.join(worktreePath, 'initialization.json');
  }

  /**
   * Reads all recorded RunEvent entries for a given Run from its event log.
   * Throws if the log does not exist or is empty.
   *
   * @param runId The unique identifier of the run.
   * @returns Array of loaded RunEvents.
   */
  async loadRun(runId: string): Promise<RunEvent[]> {
    const eventLogPath = this.getEventLogPath(runId);
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
   * Creates the initial Run documents:
   * - Claims worktree ownership by writing .pc-execution-owner
   * - Creates the run directory
   * - Persists the initial run_created event snapshot into events.jsonl
   *
   * @param context The RunContext to record.
   */
  async createRun(context: RunContext): Promise<void> {
    const ownerMarker: WorktreeOwnerMarker = {
      run_id: context.run_id,
      repository: context.repository,
      issue: context.issue,
      claimed_at: context.created_at,
    };
    await this.writeWorktreeOwner(context.worktree_path, ownerMarker);

    const runDir = this.getRunDir(context.run_id);
    await fs.mkdir(runDir, { recursive: true });

    const initialEvent: RunEvent = {
      type: 'run_created',
      run_id: context.run_id,
      timestamp: context.created_at,
      payload: {
        context,
      },
    };

    const eventLogPath = this.getEventLogPath(context.run_id);
    await fs.writeFile(eventLogPath, `${JSON.stringify(initialEvent)}\n`, 'utf8');
  }

  /**
   * Appends an event to the run's JSONL event log.
   *
   * @param runId The unique identifier of the run.
   * @param event The RunEvent to persist.
   */
  async record(runId: string, event: RunEvent): Promise<void> {
    const runDir = this.getRunDir(runId);
    await fs.mkdir(runDir, { recursive: true });
    const eventLogPath = this.getEventLogPath(runId);
    await fs.appendFile(eventLogPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  /**
   * Reads and parses the .pc-execution-owner marker from a worktree directory.
   * Returns null if the marker does not exist or cannot be read.
   *
   * @param worktreePath Path to the worktree directory.
   */
  async readWorktreeOwner(worktreePath: string): Promise<WorktreeOwnerMarker | null> {
    const ownerPath = this.getWorktreeOwnerPath(worktreePath);
    try {
      const raw = await fs.readFile(ownerPath, 'utf8');
      return JSON.parse(raw) as WorktreeOwnerMarker;
    } catch {
      return null;
    }
  }

  /**
   * Writes the .pc-execution-owner marker to claim or update worktree ownership.
   *
   * @param worktreePath Path to the worktree directory.
   * @param marker The ownership marker data to write.
   */
  async writeWorktreeOwner(worktreePath: string, marker: WorktreeOwnerMarker): Promise<void> {
    await fs.mkdir(worktreePath, { recursive: true });
    const ownerPath = this.getWorktreeOwnerPath(worktreePath);
    await fs.writeFile(ownerPath, JSON.stringify(marker, null, 2), 'utf8');
  }

  /**
   * Writes initialization.json into the target worktree.
   *
   * @param worktreePath Path to the worktree directory.
   * @param data The initialization data payload.
   */
  async writeTaskInitialization(worktreePath: string, data: Record<string, unknown>): Promise<void> {
    await fs.mkdir(worktreePath, { recursive: true });
    const initPath = this.getTaskInitializationPath(worktreePath);
    await fs.writeFile(initPath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Prepares all task-specific files in the worktree:
   * - Updates worktree ownership marker (.pc-execution-owner)
   * - Writes initialization context (initialization.json)
   *
   * @param worktreePath Path to the worktree directory.
   * @param marker Worktree ownership marker data.
   * @param initData Task initialization data payload.
   */
  async prepareTaskFiles(
    worktreePath: string,
    marker: WorktreeOwnerMarker,
    initData: Record<string, unknown>,
  ): Promise<void> {
    await this.writeWorktreeOwner(worktreePath, marker);
    await this.writeTaskInitialization(worktreePath, initData);
  }

  /**
   * Lists all Run identifiers found in the storage runs directory.
   * Returns empty array if the runs directory does not exist.
   */
  async listRunIds(): Promise<string[]> {
    const runsDir = this.getRunsDir();
    try {
      const entries = await fs.readdir(runsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Validates worktree ownership and safely removes the worktree directory,
   * while strictly preserving permanent event records in the storage root.
   *
   * @param worktreePath Path to the worktree to clean up.
   * @param expectedRunId Run identifier expected to own the worktree.
   * @returns Facts describing whether release succeeded and whether the worktree was removed.
   */
  async releaseWorktree(worktreePath: string, expectedRunId: string): Promise<ReleaseWorktreeResult> {
    let worktreeExists: boolean;
    try {
      const st = await fs.stat(worktreePath);
      worktreeExists = st.isDirectory();
    } catch {
      worktreeExists = false;
    }

    if (!worktreeExists) {
      return {
        released: true,
        worktreeRemoved: false,
        worktreePath,
      };
    }

    const ownerMarker = await this.readWorktreeOwner(worktreePath);
    if (!ownerMarker) {
      return {
        released: false,
        worktreeRemoved: false,
        worktreePath,
        error: `Cannot clean up worktree: .pc-execution-owner marker is missing at "${worktreePath}". Refusing to destroy unverified directory.`,
      };
    }

    if (ownerMarker.run_id !== expectedRunId) {
      return {
        released: false,
        worktreeRemoved: false,
        worktreePath,
        error: `Cannot clean up worktree: ownership mismatch. Worktree belongs to run "${ownerMarker.run_id}", not "${expectedRunId}". Refusing to destroy foreign worktree.`,
      };
    }

    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
      return {
        released: true,
        worktreeRemoved: true,
        worktreePath,
      };
    } catch (err) {
      return {
        released: false,
        worktreeRemoved: false,
        worktreePath,
        error: `Failed to remove worktree at "${worktreePath}": ${(err as Error).message}.`,
      };
    }
  }

  /**
   * Releases run resources for a specific run. Validates worktree ownership and removes the worktree
   * while preserving permanent run archive records in storageRoot/runs/<run_id>/events.jsonl.
   *
   * @param runId Run identifier.
   * @param worktreePath Worktree directory path.
   */
  async releaseRunResources(runId: string, worktreePath: string): Promise<ReleaseWorktreeResult> {
    return this.releaseWorktree(worktreePath, runId);
  }

  /**
   * Reads an external text file (such as a shared requirements document).
   *
   * @param filePath Absolute path to file to read.
   */
  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf8');
  }

  /**
   * Ensures a directory exists and is writable.
   *
   * @param dirPath Directory path to verify.
   */
  async ensureDirectoryWritable(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.access(dirPath, fs.constants.W_OK);
  }

  /**
   * Ensures the storage root exists and is writable.
   */
  async ensureStorageUsable(): Promise<void> {
    await this.ensureDirectoryWritable(this.storageRoot);
  }
}
