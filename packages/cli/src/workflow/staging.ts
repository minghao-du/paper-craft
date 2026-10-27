import { fileURLToPath } from 'node:url';
import { auditStagedDiff, type StagedDiffAuditResult } from '@paper-craft/core/workflow/staging';

/**
 * Runs the staged diff audit from the CLI and prints findings.
 *
 * @param cwd - Repository working directory.
 * @returns Staged diff audit result.
 */
export function runStagedDiffAudit(cwd?: string): StagedDiffAuditResult {
  const result = auditStagedDiff({ cwd });
  if (result.hasCruft) {
    console.error(result.message);
  } else {
    console.log(result.message);
  }
  return result;
}

// CLI entrypoint execution when run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runStagedDiffAudit();
  process.exit(result.clean ? 0 : 1);
}
