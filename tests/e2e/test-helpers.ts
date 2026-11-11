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
 * Absolute path to envelope CLI script (envelope-cli.ts).
 */
export const ENVELOPE_SCRIPT = path.join(
  REPO_ROOT,
  'packages/orchestrator/src/envelope-cli.ts',
);

/**
 * Absolute path to dispatch lifecycle kernel CLI script (cli.ts).
 */
export const LIFECYCLE_KERNEL_SCRIPT = path.join(
  REPO_ROOT,
  'packages/orchestrator/src/cli.ts',
);

/**
 * Absolute path to the workspace configuration CLI script (pc-workspace-config).
 */
export const WORKSPACE_CONFIG_SCRIPT = path.join(
  REPO_ROOT,
  'packages/workspace-config/src/cli.ts',
);

/**
 * Absolute path to the workspace CLI script (pc-workspace).
 */
export const PREPARE_WORKTREE_SCRIPT = path.join(
  REPO_ROOT,
  'packages/workspace/src/cli.ts',
);

/**
 * TaskInputEnvelope contract definition matching envelope-cli.ts schema.
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
    type: 'skill';
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
    replans_used: number;
    replans_max: number;
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

/** Execute an installed skill helper with the repository's TypeScript loader. */
export function runTypeScript(
  scriptPath: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  const result = spawnSync(process.execPath, [
    '--import', path.join(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs'), scriptPath, ...args,
  ], {
    cwd: options?.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options?.env },
    encoding: 'utf-8',
    timeout: 10000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Execute envelope-cli.ts CLI subcommand.
 */
export function runEnvelopeCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runTypeScript(ENVELOPE_SCRIPT, args, options);
}

/**
 * Execute cli.ts CLI subcommand.
 */
export function runLifecycleKernelCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runTypeScript(LIFECYCLE_KERNEL_SCRIPT, args, options);
}

/** Write a preparation request fixture, execute the real CLI, and remove the fixture. */
export function runPrepareTaskCli(
  receiptRoot: string,
  request: Record<string, unknown>,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  const requestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-prepare-request-'));
  try {
    const requestPath = path.join(requestDir, 'request.json');
    fs.writeFileSync(requestPath, JSON.stringify(request));
    return runLifecycleKernelCli([
      'prepare', '--receipt-root', receiptRoot, '--request', requestPath,
    ], options);
  } finally {
    fs.rmSync(requestDir, { recursive: true, force: true });
  }
}

/**
 * Execute packages/workspace-config/src/cli.ts CLI subcommand.
 */
export function runWorkspaceConfigCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runTypeScript(WORKSPACE_CONFIG_SCRIPT, args, options);
}

/**
 * Execute packages/workspace/src/cli.ts CLI subcommand.
 */
export function runPrepareWorktreeCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runTypeScript(PREPARE_WORKTREE_SCRIPT, args, options);
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
