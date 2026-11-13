/**
 * Lifecycle Kernel CLI Verification Suite.
 * Validates command-line interface behavior, parameter parsing, and error reporting.
 */
import { describe, expect, it } from 'vitest';
import { initWorkflow, type InitOptions } from '../src/lifecycle/index.js';
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

  it('init: rejects deprecated plan and shortcut options programmatically', () => {
    const env = createTestDir('pc-init-deprecated-prog-');
    try {
      expect(() =>
        initWorkflow({
          receipt_root: env.dir,
          root_issue: '201',
          plan: { tasks: [{ number: 202 }] },
        } as unknown as InitOptions),
      ).toThrow(/Init option 'plan' has been removed and is no longer supported/);

      expect(() =>
        initWorkflow({
          receipt_root: env.dir,
          root_issue: '201',
          child_issues: ['202'],
        } as unknown as InitOptions),
      ).toThrow(/Init option 'child_issues' has been removed and is no longer supported/);

      expect(() =>
        initWorkflow({
          receipt_root: env.dir,
          root_issue: '201',
          current_issue: '202',
        } as unknown as InitOptions),
      ).toThrow(/Init option 'current_issue' has been removed and is no longer supported/);

      expect(() =>
        initWorkflow({
          receipt_root: env.dir,
          root_issue: '201',
          initial_stage: 'stage_2_work',
        } as unknown as InitOptions),
      ).toThrow(/Init option 'initial_stage' has been removed and is no longer supported/);
    } finally {
      env.cleanup();
    }
  });

  it('init: CLI strictly rejects deprecated flags with non-zero exit', () => {
    const env = createTestDir('pc-init-deprecated-cli-');
    try {
      const planRes = runLifecycleKernelCli([
        'init',
        '--receipt-root', env.dir,
        '--root-issue', '201',
        '--plan', 'tasks.json',
      ]);
      expect(planRes.status).not.toBe(0);
      expect(planRes.stderr).toContain("Unknown option '--plan'");

      const childRes = runLifecycleKernelCli([
        'init',
        '--receipt-root', env.dir,
        '--root-issue', '201',
        '--child-issue', '202',
      ]);
      expect(childRes.status).not.toBe(0);
      expect(childRes.stderr).toContain("Unknown option '--child-issue'");

      const curRes = runLifecycleKernelCli([
        'init',
        '--receipt-root', env.dir,
        '--root-issue', '201',
        '--current-issue', '202',
      ]);
      expect(curRes.status).not.toBe(0);
      expect(curRes.stderr).toContain("Unknown option '--current-issue'");

      const stageRes = runLifecycleKernelCli([
        'init',
        '--receipt-root', env.dir,
        '--root-issue', '201',
        '--initial-stage', 'stage_2_work',
      ]);
      expect(stageRes.status).not.toBe(0);
      expect(stageRes.stderr).toContain("Unknown option '--initial-stage'");
    } finally {
      env.cleanup();
    }
  }, 20000);

  it('init: creates clean initial state without delivery sequence and respects idempotence', () => {
    const env = createTestDir('pc-init-clean-state-');
    try {
      const state = initWorkflow({
        receipt_root: env.dir,
        root_issue: '205',
      });
      expect(state.root_issue_id).toBe('205');
      expect(state.current_issue_id).toBe('205');
      expect(state.current_stage).toBe('stage_1_plan');
      expect(state.stage_status).toBe('pending');
      expect(state.active_dispatch).toBeNull();
      expect(state.delivery_sequence).toBeUndefined();

      // Repeated init returns existing state without resetting it
      const repeated = initWorkflow({
        receipt_root: env.dir,
        root_issue: '205',
      });
      expect(repeated).toEqual(state);
    } finally {
      env.cleanup();
    }
  });
});
