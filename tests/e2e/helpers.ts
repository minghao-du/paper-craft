import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PREPARE_WORKTREE_SCRIPT,
  ProcessResult,
  runTypeScript,
  WORKSPACE_CONFIG_SCRIPT,
} from '../support/index.js';

export * from '../support/index.js';

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
 * Execute lifecycle kernel CLI (packages/orchestrator/src/cli.ts).
 */
export function runLifecycleKernelCli(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  const LIFECYCLE_KERNEL_SCRIPT = path.join(
    options?.cwd ? path.resolve(options.cwd) : process.cwd(),
    'packages/orchestrator/src/cli.ts',
  );
  return runTypeScript(LIFECYCLE_KERNEL_SCRIPT, args, options);
}

/**
 * Write a preparation request fixture, execute the real CLI, and remove the fixture.
 */
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
