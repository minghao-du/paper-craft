/**
 * @fileoverview Default implementations for external service and provider capability checkers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderChecker } from './types.js';

const execFileAsync = promisify(execFile);

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

