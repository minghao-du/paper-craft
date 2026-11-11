/**
 * Lifecycle Kernel CLI Verification Suite.
 * Validates command-line interface behavior, parameter parsing, and error reporting.
 */
import { describe, expect, it } from 'vitest';
import {
  createTestDir,
  runLifecycleKernelCli,
} from './helpers.js';

describe('Lifecycle Kernel CLI Verification', () => {
  it('T6-CLI: CLI rejects arbitrary stage name as --decision', () => {
    const env = createTestDir('pc-t6-cli-');
    try {
      runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '107']);
      const res = runLifecycleKernelCli([
        'resolve',
        '--receipt-root',
        env.dir,
        '--decision',
        'stage_2_work',
        '--reason',
        'Invalid usage',
      ]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("Invalid decision 'stage_2_work'");
    } finally {
      env.cleanup();
    }
  }, 20000);
});
