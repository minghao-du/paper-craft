/**
 * @fileoverview Internal pull request inspection submodule for RepositoryManager.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MergeStatusResult } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Inspects pull request merge status using GitHub CLI (`gh`) with git fallback.
 * Internal to RepositoryManager.
 *
 * @param repository The repository in owner/repo format.
 * @param prOrIssue The pull request number, issue number, or branch name.
 * @param worktreePath Optional local git worktree path.
 */
export async function inspectGitHubPR(
  repository: string,
  prOrIssue: number | string,
  worktreePath?: string,
): Promise<MergeStatusResult> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        String(prOrIssue),
        '--repo',
        repository,
        '--json',
        'headRefOid,state,mergedAt,mergeCommit',
      ],
      worktreePath ? { cwd: worktreePath } : undefined,
    );
    const data = JSON.parse(String(stdout));
    const isMerged = data.state === 'MERGED';
    const mergeCommitSha =
      typeof data.mergeCommit === 'string'
        ? data.mergeCommit
        : data.mergeCommit?.oid ?? undefined;

    return {
      exists: true,
      headSha: data.headRefOid ?? undefined,
      state: data.state as 'OPEN' | 'MERGED' | 'CLOSED',
      merged: isMerged,
      mergeCommitSha,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);

    if (
      message.includes('Could not resolve to a PullRequest') ||
      message.includes('not found') ||
      message.includes('404')
    ) {
      if (worktreePath) {
        try {
          const { stdout: headSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: worktreePath,
          });
          return {
            exists: true,
            headSha: headSha.trim(),
            state: 'OPEN',
            merged: false,
          };
        } catch {
          // fallback failed, continue to standard not found error
        }
      }
      return {
        exists: false,
        error: `Pull request "${prOrIssue}" not found in repository "${repository}".`,
      };
    }

    return {
      exists: false,
      error: `Failed to inspect merge status for PR "${prOrIssue}" in repository "${repository}": ${message}`,
    };
  }
}
