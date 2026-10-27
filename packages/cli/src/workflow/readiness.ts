import { fileURLToPath } from 'node:url';
import { checkWorktreeReadiness, type ReadinessResult } from '@paper-craft/core/workflow/readiness';

/**
 * Runs the worktree readiness check and logs the result to console.
 *
 * @param cwd - Repository working directory.
 * @returns Readiness check outcome.
 */
export function runReadinessCheck(cwd?: string): ReadinessResult {
  const result = checkWorktreeReadiness({ cwd });
  if (result.hasCruft) {
    console.error(result.message);
  } else if (!result.clean) {
    console.warn(result.message);
  } else {
    console.log(result.message);
  }
  return result;
}

// CLI entrypoint execution when run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runReadinessCheck();
  process.exit(result.exitCode);
}
