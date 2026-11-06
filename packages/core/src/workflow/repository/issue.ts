/**
 * @fileoverview Internal issue inspection submodule for RepositoryManager.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IssueCheckResult } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Inspects a GitHub issue using the GitHub CLI (`gh`).
 * Internal to RepositoryManager.
 *
 * @param repository The repository in owner/repo format.
 * @param issue The issue number.
 */
export async function inspectGitHubIssue(
  repository: string,
  issue: number,
): Promise<IssueCheckResult> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue',
      'view',
      String(issue),
      '--repo',
      repository,
      '--json',
      'number,title,state',
    ]);
    const data = JSON.parse(String(stdout));
    return {
      exists: true,
      open: data.state === 'OPEN',
      title: data.title,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (
      message.includes('Could not resolve to an issue') ||
      message.includes('not found') ||
      message.includes('404')
    ) {
      return {
        exists: false,
        error: `Issue #${issue} not found in repository "${repository}".`,
      };
    }
    return {
      exists: false,
      error: `Failed to inspect Issue #${issue} in repository "${repository}": ${message}`,
    };
  }
}
