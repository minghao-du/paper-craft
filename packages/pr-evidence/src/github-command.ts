import { spawnSync } from 'node:child_process';

export function runGitHub(cwd: string, ...args: string[]): string {
  const result = spawnSync('gh', args, {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
    throw new Error(`GitHub command failed (${args.slice(0, 2).join(' ')}): ${detail}`);
  }
  return result.stdout;
}
