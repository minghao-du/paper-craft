/**
 * @fileoverview Encapsulates single task execution inspection, handle tracking,
 * and execution lifecycle management for Run.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionStatus,
  ExecutionStopResult,
} from './types.js';

/**
 * Observation returned by Execution.inspect.
 */
export interface ExecutionObservation {
  /** Stable task identifier. */
  taskId: string;
  /** Current process or session execution status from provider. */
  status: ExecutionStatus;
  /** Associated execution handle if known. */
  handle?: ExecutionHandle;
  /** Exit code if process has terminated. */
  exitCode?: number;
  /** Diagnostic error or failure message if uncertain or errored. */
  error?: string;
  /** Whether the process execution status is uncertain/unconfirmed. */
  isUncertain?: boolean;
  /** Raw submitted receipt / result parsed from working directory if present. */
  rawReceipt?: unknown;
}

/**
 * Execution submodule for Run.
 * Wraps the low-level AgentExecutor seam, launches fresh agent conversations
 * per task without cross-task session reuse, handles unknown states conservatively,
 * inspects for raw receipt files (e.g. result.json), and executes verified process stopping.
 */
export class Execution {
  private readonly executor: AgentExecutor;
  private readonly handles = new Map<string, ExecutionHandle>();
  private readonly workingDirectories = new Map<string, string>();

  /**
   * Initializes a new Execution instance wrapping an AgentExecutor.
   *
   * @param executor Low-level AgentExecutor instance.
   */
  constructor(executor: AgentExecutor) {
    this.executor = executor;
  }

  /**
   * Starts an agent task in the target working directory with the given prompt.
   * Ensures provider readiness and spawns a fresh conversation.
   *
   * @param taskId Stable unique task identifier.
   * @param workingDirectory Working directory where task executes.
   * @param prompt Composed task prompt.
   * @returns Confirmed execution handle.
   */
  async start(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle> {
    const checkResult = await this.executor.check();
    if (!checkResult.available) {
      throw new Error(`Execution provider check failed: ${checkResult.error ?? 'Unknown error'}`);
    }

    const handle = await this.executor.launch(taskId, workingDirectory, prompt);
    this.handles.set(taskId, handle);
    this.workingDirectories.set(taskId, workingDirectory);
    return handle;
  }

  /**
   * Inspects the execution status and checks for raw completion receipts in the task's working directory.
   * Conservatively classifies failures or unconfirmed states as uncertain.
   *
   * @param taskId Stable task identifier.
   * @param workingDirectory Optional working directory path override to check for raw receipts.
   * @returns Detailed execution observation including process status and raw receipt if present.
   */
  async inspect(taskId: string, workingDirectory?: string): Promise<ExecutionObservation> {
    const targetDir = workingDirectory ?? this.workingDirectories.get(taskId);
    let rawReceipt: unknown = undefined;

    if (targetDir) {
      const receiptPath = path.join(targetDir, 'result.json');
      try {
        const rawContent = await fs.readFile(receiptPath, 'utf8');
        rawReceipt = JSON.parse(rawContent);
      } catch {
        // Receipt file not present or unparseable yet
      }
    }

    try {
      const inspection = await this.executor.inspect(taskId);
      const isUncertain = inspection.status === 'uncertain';
      return {
        taskId,
        status: inspection.status,
        handle: inspection.handle ?? this.handles.get(taskId),
        exitCode: inspection.exitCode,
        error: inspection.error,
        isUncertain,
        rawReceipt,
      };
    } catch (err) {
      return {
        taskId,
        status: 'uncertain',
        handle: this.handles.get(taskId),
        error: (err as Error).message,
        isUncertain: true,
        rawReceipt,
      };
    }
  }

  /**
   * Stops an active execution handle and verifies termination.
   *
   * @param handle Execution handle to terminate.
   * @returns Teardown result confirming termination.
   */
  async stop(handle: ExecutionHandle): Promise<ExecutionStopResult> {
    return await this.executor.stop(handle);
  }
}
