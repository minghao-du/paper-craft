/**
 * @fileoverview Agent Executor contract and AgyExecutor implementation.
 * Isolates provider process mechanics from Workflow Engine business rules.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn as defaultSpawn, execFile as defaultExecFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentExecutor,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionStatus,
} from './types.js';

/**
 * Configuration options for initializing an AgyExecutor instance.
 */
export interface AgyExecutorOptions {
  /** Executable name or absolute path. Defaults to 'agy'. */
  command?: string;
  /** Custom spawn implementation for testing / isolation. */
  spawn?: typeof defaultSpawn;
  /** Custom execFile implementation for availability checks. */
  execFile?: typeof defaultExecFile;
  /** Additional command-line flags to pass to agy (e.g. ['--dangerously-skip-permissions']). */
  extraArgs?: string[];
  /** Grace period in milliseconds before SIGKILL when stopping a process. Defaults to 500ms. */
  stopGracePeriodMs?: number;
  /** Directory for persisting task execution markers for cross-process recovery. */
  tasksDir?: string;
}

interface TrackedTask {
  handle: ExecutionHandle;
  child: ChildProcess;
  status: ExecutionStatus;
  exitCode?: number;
  error?: string;
  stopped: boolean;
}

/**
 * Concrete AgentExecutor implementation for Google Antigravity (agy).
 * Isolates all provider process spawning, stdio communication, inspection,
 * and verified termination from Engine state transitions.
 */
export class AgyExecutor implements AgentExecutor {
  public readonly command: string;
  public readonly extraArgs: string[];
  public readonly stopGracePeriodMs: number;
  public readonly tasksDir: string;
  private readonly spawnFn: typeof defaultSpawn;
  private readonly execFileFn: typeof defaultExecFile;
  private readonly tasks = new Map<string, TrackedTask>();

  constructor(options?: AgyExecutorOptions) {
    this.command = options?.command ?? 'agy';
    this.extraArgs = options?.extraArgs ?? [];
    this.stopGracePeriodMs = options?.stopGracePeriodMs ?? 500;
    this.tasksDir = options?.tasksDir ?? path.join(os.tmpdir(), 'pc-agent-tasks');
    this.spawnFn = options?.spawn ?? defaultSpawn;
    this.execFileFn = options?.execFile ?? defaultExecFile;
  }

  /**
   * Verifies that the agy executable is installed, reachable, and responsive.
   */
  async check(): Promise<{ available: boolean; error?: string }> {
    try {
      const execAsync = promisify(this.execFileFn);
      await execAsync(this.command, ['--help']);
      return { available: true };
    } catch (err) {
      const msg = (err as Error).message || String(err);
      return {
        available: false,
        error: `agy execution check failed: ${msg}`,
      };
    }
  }

  /**
   * Launches an agy agent task bound to a stable taskId.
   * Spawns non-interactively with the given prompt in the assigned workingDirectory.
   */
  async launch(taskId: string, workingDirectory: string, prompt: string): Promise<ExecutionHandle> {
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('Launch requires a non-empty taskId string.');
    }
    if (!workingDirectory || typeof workingDirectory !== 'string') {
      throw new Error('Launch requires a valid workingDirectory string.');
    }

    const existing = this.tasks.get(taskId);
    if (existing && existing.status === 'running') {
      throw new Error(`Task "${taskId}" is already running with handle "${existing.handle.id}".`);
    }

    const handle: ExecutionHandle = {
      id: `agy-${taskId}-${Date.now()}`,
      taskId,
    };

    const args = [...this.extraArgs, '--print', prompt];

    const child = this.spawnFn(this.command, args, {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const record: TrackedTask = {
      handle,
      child,
      status: 'running',
      stopped: false,
    };

    this.tasks.set(taskId, record);

    child.on('exit', (code, signal) => {
      record.status = 'exited';
      record.exitCode = code ?? undefined;
      if (signal && !record.stopped) {
        record.error = `Process terminated with signal ${signal}`;
      }
    });

    child.on('error', (err) => {
      record.status = 'uncertain';
      record.error = err.message;
    });

    // Brief tick to catch immediate spawn errors (e.g. ENOENT)
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (record.status === 'uncertain') {
      throw new Error(`Failed to launch agy process for task "${taskId}": ${record.error}`);
    }

    // Persist execution marker file for cross-process inspection and reconciliation
    try {
      await fs.mkdir(this.tasksDir, { recursive: true });
      const markerPath = path.join(this.tasksDir, `${taskId}.json`);
      await fs.writeFile(
        markerPath,
        JSON.stringify({
          taskId,
          handle,
          pid: child.pid,
          workingDirectory,
          command: this.command,
          launchedAt: new Date().toISOString(),
        }),
        'utf8',
      );
    } catch {
      // Non-fatal if marker directory write fails
    }

    return handle;
  }

  /**
   * Inspects execution status by stable taskId.
   */
  async inspect(taskId: string): Promise<ExecutionInspection> {
    const record = this.tasks.get(taskId);
    if (!record) {
      // Check persistent task marker for cross-process recovery
      const markerPath = path.join(this.tasksDir, `${taskId}.json`);
      try {
        const markerRaw = await fs.readFile(markerPath, 'utf8');
        const marker = JSON.parse(markerRaw);
        if (marker && marker.pid) {
          let isRunning = false;
          try {
            process.kill(marker.pid, 0);
            isRunning = true;
          } catch {
            isRunning = false;
          }

          if (isRunning) {
            return {
              status: 'running',
              handle: marker.handle ?? { id: `agy-${taskId}-recovered`, taskId },
            };
          }

          return {
            status: 'exited',
            handle: marker.handle ?? { id: `agy-${taskId}-recovered`, taskId },
            exitCode: 0,
          };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return {
            status: 'uncertain',
            error: `Failed to inspect task marker for "${taskId}": ${(err as Error).message}`,
          };
        }
      }

      return { status: 'not_started' };
    }

    if (record.status === 'running') {
      if (record.child.exitCode !== null && record.child.exitCode !== undefined) {
        record.status = 'exited';
        record.exitCode = record.child.exitCode;
        return {
          status: 'exited',
          handle: record.handle,
          exitCode: record.exitCode,
        };
      }
      if (record.child.pid) {
        try {
          process.kill(record.child.pid, 0);
        } catch {
          record.status = 'exited';
          return {
            status: 'exited',
            handle: record.handle,
            exitCode: record.exitCode ?? 0,
          };
        }
      }
      return {
        status: 'running',
        handle: record.handle,
      };
    }

    return {
      status: record.status,
      handle: record.handle,
      exitCode: record.exitCode,
      error: record.error,
    };
  }

  /**
   * Sends a follow-up message into the process stdin if running.
   */
  async send(handle: ExecutionHandle, message: string): Promise<void> {
    const record = this.tasks.get(handle.taskId);
    if (!record || record.status !== 'running' || !record.child.stdin || record.child.stdin.destroyed) {
      throw new Error(`Cannot send message to task "${handle.taskId}": execution is not running or stdin is closed.`);
    }

    return new Promise((resolve, reject) => {
      record.child.stdin!.write(`${message}\n`, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Stops a running execution and verifies termination.
   */
  async stop(handle: ExecutionHandle): Promise<{ stopped: boolean; uncertain?: boolean; error?: string }> {
    const record = this.tasks.get(handle.taskId);
    if (!record) {
      // Check persistent task marker for cross-process termination
      const markerPath = path.join(this.tasksDir, `${handle.taskId}.json`);
      try {
        const raw = await fs.readFile(markerPath, 'utf8');
        const marker = JSON.parse(raw);
        if (marker && marker.pid) {
          try {
            process.kill(marker.pid, 0);
          } catch {
            return { stopped: true };
          }

          try {
            process.kill(marker.pid, 'SIGTERM');
          } catch (err) {
            return {
              stopped: false,
              uncertain: true,
              error: `Failed to signal process: ${(err as Error).message}`,
            };
          }

          const startWait = Date.now();
          while (Date.now() - startWait < this.stopGracePeriodMs) {
            try {
              process.kill(marker.pid, 0);
            } catch {
              return { stopped: true };
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          try {
            process.kill(marker.pid, 'SIGKILL');
          } catch {
            // Ignore
          }

          const killWait = Date.now();
          while (Date.now() - killWait < 300) {
            try {
              process.kill(marker.pid, 0);
            } catch {
              return { stopped: true };
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          try {
            process.kill(marker.pid, 0);
            return {
              stopped: false,
              uncertain: true,
              error: `Process for task "${handle.taskId}" did not terminate within expected grace period.`,
            };
          } catch {
            return { stopped: true };
          }
        }
      } catch {
        return { stopped: true };
      }
      return { stopped: true };
    }

    if (record.status === 'exited' || record.stopped) {
      return { stopped: true };
    }

    record.stopped = true;

    try {
      record.child.kill('SIGTERM');
    } catch (err) {
      return {
        stopped: false,
        uncertain: true,
        error: `Failed to signal process: ${(err as Error).message}`,
      };
    }

    const isExited = (): boolean =>
      (record.status as ExecutionStatus) === 'exited' || record.child.exitCode !== null;

    // Await process exit up to grace period
    const startWait = Date.now();
    while (Date.now() - startWait < this.stopGracePeriodMs) {
      if (isExited()) {
        record.status = 'exited';
        return { stopped: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // If still running after grace period, issue SIGKILL
    try {
      record.child.kill('SIGKILL');
    } catch {
      // Ignore if already dead
    }

    // Await exit after SIGKILL
    const killWait = Date.now();
    while (Date.now() - killWait < 300) {
      if (isExited()) {
        record.status = 'exited';
        return { stopped: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // If process exited
    if (isExited()) {
      record.status = 'exited';
      return { stopped: true };
    }

    return {
      stopped: false,
      uncertain: true,
      error: `Process for task "${handle.taskId}" did not terminate within expected grace period.`,
    };
  }
}

/**
 * Factory for creating an AgentExecutor based on provider name.
 * Currently supports 'agy'. Throws an error for unknown or unsupported providers.
 *
 * @param provider Provider identifier (e.g. 'agy').
 * @param options Optional configuration options for the AgyExecutor.
 * @returns Configured AgentExecutor instance.
 */
export function createAgentExecutor(
  provider: string,
  options?: AgyExecutorOptions,
): AgentExecutor {
  if (provider === 'agy') {
    return new AgyExecutor(options);
  }
  throw new Error(`Unsupported provider: "${provider}". Only "agy" is currently supported.`);
}

