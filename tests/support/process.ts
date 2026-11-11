import { spawnSync } from 'node:child_process';
import { REPO_ROOT, TSX_LOADER_PATH } from './paths.js';

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
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): ProcessResult {
  const result = spawnSync('python3', [scriptPath, ...args], {
    cwd: options?.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options?.env },
    encoding: 'utf-8',
    timeout: options?.timeout ?? 10000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Execute a TypeScript script with the repository's TypeScript loader.
 */
export function runTypeScript(
  scriptPath: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): ProcessResult {
  const result = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER_PATH, scriptPath, ...args],
    {
      cwd: options?.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options?.env },
      encoding: 'utf-8',
      timeout: options?.timeout ?? 10000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
