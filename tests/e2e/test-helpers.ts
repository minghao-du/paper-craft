/**
 * Shared test helpers, execution wrappers, fixtures, and contract interfaces for E2E tests.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Absolute root path of the repository.
 */
export const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Absolute path to envelope CLI script (envelope.py).
 */
export const ENVELOPE_SCRIPT = path.join(
  REPO_ROOT,
  'skills/pc-orchestrator/scripts/envelope.py',
);

/**
 * Absolute path to deterministic state machine script (state_machine.py).
 */
export const STATE_MACHINE_SCRIPT = path.join(
  REPO_ROOT,
  'skills/pc-orchestrator/scripts/state_machine.py',
);

/**
 * Absolute path to dispatch lifecycle kernel CLI script (lifecycle_kernel.py).
 */
export const LIFECYCLE_KERNEL_SCRIPT = path.join(
  REPO_ROOT,
  'skills/pc-orchestrator/scripts/lifecycle_kernel.py',
);

/**
 * Absolute path to the workspace configuration CLI script (pc-workspace-config).
 */
export const WORKSPACE_CONFIG_SCRIPT = path.join(
  REPO_ROOT,
  'skills/pc-workspace-config/scripts/config.py',
);

/**
 * Absolute path to the worktree preparation CLI script (pc-workspace).
 */
export const PREPARE_WORKTREE_SCRIPT = path.join(
  REPO_ROOT,
  'skills/pc-workspace/scripts/prepare-worktree.py',
);

/**
 * TaskInputEnvelope contract definition matching envelope.py schema.
 */
export interface TaskInputEnvelope {
  schema_version: string;
  task: {
    logical_stage: string;
    step_index: number;
    attempt: number;
    root_issue_id: string;
    current_issue_id: string;
  };
  provider: {
    type: 'skill' | 'script';
    target: string;
    args: string[];
  };
  environment: {
    working_directory: string;
    repository: string;
    base_branch: string;
    branch?: string | null;
    commit?: string | null;
  };
  inputs: {
    objective: string;
    scope?: string;
    acceptance_criteria: string[];
    predecessor_receipts: string[];
    parameters?: Record<string, unknown>;
  };
  contract: {
    receipt_path: string;
    receipt_template: string;
  };
  budgets: {
    delivery_attempts_used: number;
    delivery_attempts_max: number;
    delivery_attempts_limit?: number;
    replans_used: number;
    replans_max: number;
    replans_limit?: number;
  };
}

/**
 * Unified Compact Receipt Report contract definition.
 */
export interface CompactReceiptReport {
  execution_status: 'succeeded' | 'blocked' | 'failed';
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
}

/**
 * Result of a CLI execution.
 */
export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute python script with given arguments synchronously.
 */
export function runPython(
  scriptPath: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  const result = spawnSync('python3', [scriptPath, ...args], {
    cwd: options?.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options?.env },
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Execute envelope.py CLI subcommand.
 */
export function runEnvelopeCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runPython(ENVELOPE_SCRIPT, args, options);
}

/**
 * Execute state_machine.py CLI subcommand.
 */
export function runStateMachineCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runPython(STATE_MACHINE_SCRIPT, args, options);
}

/**
 * Execute lifecycle_kernel.py CLI subcommand.
 */
export function runLifecycleKernelCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runPython(LIFECYCLE_KERNEL_SCRIPT, args, options);
}

/**
 * Execute pc-workspace-config/scripts/config.py CLI subcommand.
 */
export function runWorkspaceConfigCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runPython(WORKSPACE_CONFIG_SCRIPT, args, options);
}

/**
 * Execute pc-workspace/scripts/prepare-worktree.py CLI subcommand.
 */
export function runPrepareWorktreeCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runPython(PREPARE_WORKTREE_SCRIPT, args, options);
}

/**
 * Creates an isolated temporary directory for test fixtures.
 */
export function createTestDir(prefix = 'pc-e2e-'): {
  dir: string;
  cleanup: () => void;
} {
  const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tempDir = fs.realpathSync(rawTempDir);
  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignored during cleanup
    }
  };
  return { dir: tempDir, cleanup };
}
