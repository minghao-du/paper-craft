/**
 * Lifecycle Kernel CLI Verification Suite.
 * Validates command-line interface behavior, parameter parsing, and error reporting.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dispatchTask,
  initWorkflow,
  inspectState,
  type InitOptions,
} from '../src/lifecycle/index.js';
import {
  createTestDir,
  runDispatchTaskCli,
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

  // F01: Task JSON cannot specify receipt_root (equal or different) to redirect a dispatch.
  it('F01: CLI dispatch rejects receipt_root in task JSON without modifying either root', () => {
    const rootA = createTestDir('pc-f01-root-a-');
    const rootB = createTestDir('pc-f01-root-b-');
    try {
      initWorkflow({ receipt_root: rootA.dir, root_issue: '301' });
      initWorkflow({ receipt_root: rootB.dir, root_issue: '302' });
      const beforeA = fs.readFileSync(path.join(rootA.dir, 'state.json'), 'utf8');
      const beforeB = fs.readFileSync(path.join(rootB.dir, 'state.json'), 'utf8');

      const redirectDifferent = runDispatchTaskCli(rootA.dir, {
        receipt_root: rootB.dir,
        request_id: 'f01-diff',
        stage: 'stage_1_plan',
        objective: 'Attempt redirect',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: rootA.dir,
      });
      expect(redirectDifferent.status).not.toBe(0);
      expect(redirectDifferent.stderr).toContain('receipt_root');
      expect(fs.readFileSync(path.join(rootA.dir, 'state.json'), 'utf8')).toBe(beforeA);
      expect(fs.readFileSync(path.join(rootB.dir, 'state.json'), 'utf8')).toBe(beforeB);

      const redirectSame = runDispatchTaskCli(rootA.dir, {
        receipt_root: rootA.dir,
        request_id: 'f01-same',
        stage: 'stage_1_plan',
        objective: 'Attempt redundant root',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: rootA.dir,
      });
      expect(redirectSame.status).not.toBe(0);
      expect(redirectSame.stderr).toContain('receipt_root');
      expect(fs.readFileSync(path.join(rootA.dir, 'state.json'), 'utf8')).toBe(beforeA);
    } finally {
      rootA.cleanup();
      rootB.cleanup();
    }
  }, 20000);

  // F08: CLI passes raw report text so active malformed reports record protocol_error while missing files / inactive reports do not.
  it('F08: CLI complete records protocol_error for active malformed file/inline reports without contaminating active state on missing/inactive reports', () => {
    const env = createTestDir('pc-f08-cli-complete-');
    try {
      initWorkflow({ receipt_root: env.dir, root_issue: '303' });
      const active = dispatchTask({
        receipt_root: env.dir,
        request_id: 'f08-plan',
        stage: 'stage_1_plan',
        objective: 'Plan issue 303',
        provider: { type: 'skill', target: 'pc-issue-plan' },
        workdir: env.dir,
      });

      const missingFileRes = runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', active.dispatch_id,
        '--report', path.join(env.dir, 'does-not-exist.json'),
      ]);
      expect(missingFileRes.status).not.toBe(0);
      expect(missingFileRes.stderr).toContain('Report file not found');
      expect(inspectState({ receipt_root: env.dir }).protocol_error).toBeNull();

      const badReportFile = path.join(env.dir, 'bad-report.json');
      fs.writeFileSync(badReportFile, '{malformed json');

      const otherDispatchRes = runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', 'other-dispatch-id',
        '--report', badReportFile,
      ]);
      expect(otherDispatchRes.status).not.toBe(0);
      expect(inspectState({ receipt_root: env.dir }).protocol_error).toBeNull();

      const activeBadFileRes = runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', active.dispatch_id,
        '--report', badReportFile,
      ]);
      expect(activeBadFileRes.status).not.toBe(0);
      const afterFileErr = inspectState({ receipt_root: env.dir });
      expect(afterFileErr.protocol_error?.dispatch_id).toBe(active.dispatch_id);
      expect(afterFileErr.protocol_error?.error_type).toBeTruthy();

      const activeBadInlineRes = runLifecycleKernelCli([
        'complete',
        '--receipt-root', env.dir,
        '--dispatch-id', active.dispatch_id,
        '--report', '{not json',
      ]);
      expect(activeBadInlineRes.status).not.toBe(0);
      expect(inspectState({ receipt_root: env.dir }).protocol_error?.dispatch_id).toBe(active.dispatch_id);
    } finally {
      env.cleanup();
    }
  }, 20000);

  // F04 & F11: Explicit-root restore uses saved snapshot without workspace config/source file and validates locator & non-identity overrides.
  it('F04 & F11: explicit-root restore succeeds after workflow source removal and outside config, rejecting conflicting locator or overrides', () => {
    const repo = createTestDir('pc-f04-repo-');
    const root = createTestDir('pc-f04-root-');
    const badCwd = createTestDir('pc-f04-badcwd-');
    const prevCwd = process.cwd();
    try {
      execFileSync('git', ['init'], { cwd: repo.dir });
      const wfPath = path.join(repo.dir, 'custom-workflow.json');
      fs.writeFileSync(
        wfPath,
        JSON.stringify({
          name: 'custom-dev',
          completion_policy: 'basic',
          initial_stage: 'plan',
          stages: [
            { id: 'plan', logical_task: 'issue_plan', provider: { type: 'skill', target: 'pc-issue-plan' } },
            { id: 'work', logical_task: 'issue_work', provider: { type: 'skill', target: 'pc-issue-work' } },
          ],
        }),
      );

      const created = initWorkflow({
        receipt_root: root.dir,
        root_issue: '304',
        repo_dir: repo.dir,
        workflow: wfPath,
        base_remote: 'origin',
        push_remote: 'origin',
        delivery_target: 'owner/repo',
        base_branch: 'main',
      });
      expect(created.workflow).toBe('custom-dev');

      // Delete source workflow file and make both repo and cwd workspace configs unreadable.
      fs.rmSync(wfPath);
      fs.mkdirSync(path.join(repo.dir, '.paper-craft'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, '.paper-craft', 'workspace-config.json'), '{broken');
      fs.mkdirSync(path.join(badCwd.dir, '.paper-craft'), { recursive: true });
      fs.writeFileSync(path.join(badCwd.dir, '.paper-craft', 'workspace-config.json'), '{broken');

      process.chdir(badCwd.dir);

      // Explicit-root resume succeeds from saved snapshot even with deleted workflow file, broken config, and omitted repo_dir.
      const resumed = initWorkflow({
        receipt_root: root.dir,
        root_issue: '304',
        workflow: wfPath,
        base_branch: 'main',
      });
      expect(resumed).toEqual(created);

      // Explicit narrow repo_dir match still succeeds without invoking broken workspace config.
      const resumedWithRepo = initWorkflow({
        receipt_root: root.dir,
        root_issue: '304',
        repo_dir: repo.dir,
        require_config: true,
      });
      expect(resumedWithRepo).toEqual(created);

      // Display name is not interchangeable with locator; conflicting locator/override rejected.
      expect(() =>
        initWorkflow({
          receipt_root: root.dir,
          root_issue: '304',
          workflow: 'custom-dev',
        }),
      ).toThrow(/Run identity conflict/);

      expect(() =>
        initWorkflow({
          receipt_root: root.dir,
          root_issue: '304',
          base_branch: 'develop',
        }),
      ).toThrow(/Cannot override 'base_branch'/);
    } finally {
      process.chdir(prevCwd);
      repo.cleanup();
      root.cleanup();
      badCwd.cleanup();
    }
  });
});
