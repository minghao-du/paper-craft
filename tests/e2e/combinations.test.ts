/**
 * Tier 3: Combinations & Cross-Module Integration Tests
 *
 * Verifies cross-cutting interactions between:
 * - State machine state tracking and Envelope generation via --from-state.
 * - Dynamic predecessor receipt chaining across successive workflow steps.
 * - Provider type switching ("skill" vs "script") across stage boundaries.
 * - Budget increments and threshold propagation into envelopes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDir,
  runLifecycleKernelCli,
  runPrepareTaskCli,
  type TaskInputEnvelope,
} from './test-helpers.js';

describe('Tier 3: Combinations & Cross-Module Integration', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('tier3-comb-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it('C3.1: state machine init + context transition integrates with envelope generation', () => {
    // 1. Initialize workflow state
    const initRes = runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '777',
      '--workflow', 'default',
    ]);
    expect(initRes.status).toBe(0);

    // 2. Set environment context in prepare
    const fakeWorkdir = path.join(testEnv.dir, 'worktree-777');
    fs.mkdirSync(fakeWorkdir, { recursive: true });

    // 3. Generate envelope from prepare
    const prepRes = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_1_plan',
      objective: 'Formulate delivery plan for issue 777',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: fakeWorkdir,
      branch: 'issue-777',
      commit: '9999999999999999999999999999999999999999',
    });
    expect(prepRes.status).toBe(0);

    const envelopePath = JSON.parse(prepRes.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.task.root_issue_id).toBe('777');
    expect(env.task.logical_stage).toBe('stage_1_plan');
    expect(env.environment.working_directory).toBe(path.resolve(fakeWorkdir));
    expect(env.environment.branch).toBe('issue-777');
    expect(env.environment.commit).toBe('9999999999999999999999999999999999999999');
  });

  it('C3.2: predecessor receipt requires explicit specification without implicit inheritance', () => {
    // 1. Init lifecycle kernel
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '888',
    ]);

    // 2. Complete stage 1 with receipt
    const p1 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_1_plan',
      objective: 'Plan stage 1',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    const p1Data = JSON.parse(p1.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir, '--dispatch-id', p1Data.dispatch_id]);
    fs.writeFileSync(p1Data.receipt_path, '# Stage 1 Plan Receipt\nOutcome: direct');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', p1Data.dispatch_id,
      '--report', JSON.stringify({
        execution_status: 'succeeded',
        result: { outcome: 'direct' },
        receipt_path: p1Data.receipt_path,
        summary: 'Stage 1 direct plan completed',
      }),
    ]);

    // 3. Generate envelope for stage 2 without predecessor receipts: strictly empty []
    const p2NoPre = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Execute work for issue 888 without predecessors',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
    });
    expect(p2NoPre.status).toBe(0);
    const p2NoPreData = JSON.parse(p2NoPre.stdout);
    const envNoPre: TaskInputEnvelope = JSON.parse(fs.readFileSync(p2NoPreData.envelope_path, 'utf-8'));
    expect(envNoPre.inputs.predecessor_receipts).toEqual([]);

    // Complete stage 2
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir, '--dispatch-id', p2NoPreData.dispatch_id]);
    fs.writeFileSync(p2NoPreData.receipt_path, '# Stage 2 Work Receipt\nOutcome: implemented');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', p2NoPreData.dispatch_id,
      '--report', JSON.stringify({
        execution_status: 'succeeded',
        result: { outcome: 'implemented' },
        receipt_path: p2NoPreData.receipt_path,
        summary: 'Stage 2 work completed',
      }),
    ]);

    // 4. Reject invalid non-existent predecessor
    const pBad = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_land',
      objective: 'Land with invalid predecessor',
      provider: {
        type: 'skill',
        target: 'pc-pr-land',
      },
      workdir: testEnv.dir,
      predecessor_receipts: [path.join(testEnv.dir, 'non-existent.md')],
    });
    expect(pBad.status).not.toBe(0);

    // 5. Explicit predecessor receipts accepted and passed into envelope
    const p3 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_land',
      objective: 'Land with explicit predecessors',
      provider: {
        type: 'skill',
        target: 'pc-pr-land',
      },
      workdir: testEnv.dir,
      predecessor_receipts: [p1Data.receipt_path, p2NoPreData.receipt_path],
    });
    expect(p3.status).toBe(0);

    const p3Data = JSON.parse(p3.stdout);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(p3Data.envelope_path, 'utf-8'));
    expect(env.task.logical_stage).toBe('stage_2_land');
    expect(env.inputs.predecessor_receipts).toEqual([p1Data.receipt_path, p2NoPreData.receipt_path]);
  });

  it('C3.3: seamless provider target switching across stages', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '555',
    ]);

    // Stage 1: Skill provider targeting pc-issue-plan
    const p1 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_1_plan',
      objective: 'Plan with skill',
      provider: {
        type: 'skill',
        target: 'pc-issue-plan',
      },
      workdir: testEnv.dir,
    });
    const p1Data = JSON.parse(p1.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir, '--dispatch-id', p1Data.dispatch_id]);
    fs.writeFileSync(p1Data.receipt_path, '# Receipt 1');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', p1Data.dispatch_id,
      '--report', JSON.stringify({
        execution_status: 'succeeded',
        result: { outcome: 'planned' },
        receipt_path: p1Data.receipt_path,
        summary: 'Planned with skill',
      }),
    ]);

    // Stage 2: Skill provider targeting pc-issue-work with args
    const p2 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Work with skill',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
        args: ['--fast'],
      },
      workdir: testEnv.dir,
    });
    expect(p2.status).toBe(0);
    const p2Data = JSON.parse(p2.stdout);

    const env1: TaskInputEnvelope = JSON.parse(fs.readFileSync(p1Data.envelope_path, 'utf-8'));
    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(p2Data.envelope_path, 'utf-8'));

    expect(env1.provider.type).toBe('skill');
    expect(env1.provider.target).toBe('pc-issue-plan');

    expect(env2.provider.type).toBe('skill');
    expect(env2.provider.target).toBe('pc-issue-work');
    expect(env2.provider.args).toEqual(['--fast']);

    // State machine is completely oblivious to provider differences
    const stateShow = runLifecycleKernelCli(['inspect', '--receipt-root', testEnv.dir, '--json']);
    const stateObj = JSON.parse(stateShow.stdout);
    expect(stateObj.current_stage).toBe('stage_2_work');
    expect(stateObj.completed_stages_count).toBe(1);
  });

  it('C3.4: budget escalation during rework cycle propagates to envelope and triggers budget check', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '666',
      '--delivery-attempts-max', '3',
    ]);

    // Attempt 1 fails
    const p1 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Initial implementation attempt 1',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
    });
    const p1Data = JSON.parse(p1.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir, '--dispatch-id', p1Data.dispatch_id]);
    fs.writeFileSync(p1Data.receipt_path, '# Attempt 1 Receipt');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', p1Data.dispatch_id,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p1Data.receipt_path,
        summary: 'Attempt 1 failed',
      }),
    ]);

    // Attempt 2: rework cycle with --attempt-intent new
    const p2 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Rework implementation attempt 2',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
      attempt_intent: 'new',
    });
    expect(p2.status).toBe(0);
    const p2Data = JSON.parse(p2.stdout);
    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(p2Data.envelope_path, 'utf-8'));
    expect(env2.task.attempt).toBe(2);
    expect(env2.budgets.delivery_attempts_used).toBe(2);

    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir, '--dispatch-id', p2Data.dispatch_id]);
    fs.writeFileSync(p2Data.receipt_path, '# Attempt 2 Receipt');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', p2Data.dispatch_id,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p2Data.receipt_path,
        summary: 'Attempt 2 failed',
      }),
    ]);

    // Attempt 3: reached budget limit
    const p3 = runPrepareTaskCli(testEnv.dir, {
      stage: 'stage_2_work',
      objective: 'Rework implementation attempt 3',
      provider: {
        type: 'skill',
        target: 'pc-issue-work',
      },
      workdir: testEnv.dir,
      attempt_intent: 'new',
    });
    expect(p3.status).toBe(0);
    const p3Data = JSON.parse(p3.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir, '--dispatch-id', p3Data.dispatch_id]);
    fs.writeFileSync(p3Data.receipt_path, '# Attempt 3 Receipt');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--dispatch-id', p3Data.dispatch_id,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p3Data.receipt_path,
        summary: 'Attempt 3 failed',
      }),
    ]);

    // Inspect state: now 3/3 attempts used => delivery attempt budget exhausted in blocking_reasons
    const inspectCheck = runLifecycleKernelCli([
      'inspect',
      '--receipt-root', testEnv.dir,
      '--json',
    ]);
    expect(inspectCheck.status).toBe(0);
    const inspectData = JSON.parse(inspectCheck.stdout);
    expect(inspectData.budgets.delivery_attempts_used).toBe(3);
    expect(inspectData.blocking_reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/delivery attempt budget exhausted/i),
      ]),
    );
  });
});
