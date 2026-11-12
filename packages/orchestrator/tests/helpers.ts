import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENVELOPE_SCRIPT,
  LIFECYCLE_KERNEL_SCRIPT,
  type ProcessResult,
  runTypeScript,
} from '../../../tests/support/index.js';

export * from '../../../tests/support/index.js';

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

/**
 * Write a dispatch request fixture, execute the real CLI, and remove the fixture.
 */
export function runDispatchTaskCli(
  receiptRoot: string,
  request: Record<string, unknown>,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  const requestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dispatch-request-'));
  try {
    const requestPath = path.join(requestDir, 'request.json');
    fs.writeFileSync(requestPath, JSON.stringify({ request_id: randomUUID(), ...request }));
    return runLifecycleKernelCli([
      'dispatch', '--receipt-root', receiptRoot, '--request', requestPath,
    ], options);
  } finally {
    fs.rmSync(requestDir, { recursive: true, force: true });
  }
}
