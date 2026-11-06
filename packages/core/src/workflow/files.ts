/**
 * @fileoverview Unified storage layout and files management for workflow runs,
 * events persistence, requirement snapshots, and task initialization files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RunContext, RunEvent } from './types.js';
import {
  WorkflowOwnershipError,
  WorkflowCleanupError,
  type ReleaseWorktreeResult,
  type WorktreeOwnerMarker,
} from './repository.js';

export {
  WorkflowOwnershipError,
  WorkflowCleanupError,
  type ReleaseWorktreeResult,
  type WorktreeOwnerMarker,
};

/**
 * Options for configuring WorkflowFiles storage.
 */
export interface WorkflowFilesOptions {
  /** Storage root directory for durable state and event logs. */
  storageRoot: string;
}

/**
 * Manages run documents, requirement snapshots, event persistence, and task initialization files.
 * Files does not evaluate business progression or execution rules, and does not operate Git worktrees.
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
   * - Creates the run directory
   * - Persists the initial run_created event snapshot into events.jsonl
   *
   * @param context The RunContext to record.
   */
  async createRun(context: RunContext): Promise<void> {
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
   * Prepares task-specific files in the worktree:
   * Writes initialization context (initialization.json).
   *
   * @param worktreePath Path to the worktree directory.
   * @param initDataOrMarker Task initialization data or legacy marker parameter.
   * @param maybeInitData Task initialization data when called with legacy 3-parameter form.
   */
  async prepareTaskFiles(
    worktreePath: string,
    initDataOrMarker: Record<string, unknown>,
    maybeInitData?: Record<string, unknown>,
  ): Promise<void> {
    const initData = maybeInitData ?? initDataOrMarker;
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
