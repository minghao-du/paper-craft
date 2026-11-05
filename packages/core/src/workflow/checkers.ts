/**
 * @fileoverview Default implementations for external service and provider capability checkers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IssueChecker, ProviderChecker } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Standard IssueChecker using GitHub CLI (`gh`).
 */
export class DefaultIssueChecker implements IssueChecker {
  async checkIssue(repository: string, issue: number): Promise<{
    exists: boolean;
    open?: boolean;
    title?: string;
    error?: string;
  }> {
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
      const data = JSON.parse(stdout);
      return {
        exists: true,
        open: data.state === 'OPEN',
        title: data.title,
      };
    } catch (err) {
      const message = (err as Error).message || String(err);
      if (message.includes('Could not resolve to an issue') || message.includes('not found') || message.includes('404')) {
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
}

/**
 * Standard ProviderChecker verifying local binary availability and health.
 */
export class DefaultProviderChecker implements ProviderChecker {
  async check(provider: string): Promise<{ available: boolean; error?: string }> {
    if (provider !== 'agy') {
      return {
        available: false,
        error: `Provider "${provider}" is unsupported. Only "agy" is currently supported.`,
      };
    }

    try {
      await execFileAsync('which', ['agy']);
      return { available: true };
    } catch {
      return {
        available: false,
        error:
          'agy executable not found in PATH. Ensure Google Antigravity (agy) is installed and available in environment.',
      };
    }
  }
}
