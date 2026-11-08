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
  runStateMachineCli,
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
    const prepRes = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_1_plan',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', fakeWorkdir,
      '--branch', 'issue-777',
      '--commit', '9999999999999999999999999999999999999999',
      '--objective', 'Formulate delivery plan for issue 777',
    ]);
    expect(prepRes.status).toBe(0);

    const envelopePath = JSON.parse(prepRes.stdout).envelope_path;
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.task.root_issue_id).toBe('777');
    expect(env.task.logical_stage).toBe('stage_1_plan');
    expect(env.environment.working_directory).toBe(path.resolve(fakeWorkdir));
    expect(env.environment.branch).toBe('issue-777');
    expect(env.environment.commit).toBe('9999999999999999999999999999999999999999');
  });

  it('C3.2: predecessor receipt automatically chains from completed stage into successor envelope', () => {
    // 1. Init lifecycle kernel
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '888',
    ]);

    // 2. Complete stage 1 with receipt
    const p1 = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_1_plan',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Plan stage 1',
    ]);
    const p1Data = JSON.parse(p1.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p1Data.receipt_path, '# Stage 1 Plan Receipt\nOutcome: direct');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'succeeded',
        result: { outcome: 'direct' },
        receipt_path: p1Data.receipt_path,
        summary: 'Stage 1 direct plan completed',
      }),
    ]);

    // 3. Generate envelope for stage 2
    const p2 = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--provider-type', 'script',
      '--provider-target', 'skills/pc-workspace/scripts/prepare-worktree.py',
      '--workdir', testEnv.dir,
      '--objective', 'Execute work for issue 888',
    ]);
    expect(p2.status).toBe(0);

    const p2Data = JSON.parse(p2.stdout);
    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(p2Data.envelope_path, 'utf-8'));
    expect(env.task.logical_stage).toBe('stage_2_work');
    // Predecessor receipt automatically extracted from latest completed stage
    expect(env.inputs.predecessor_receipts).toContain(p1Data.receipt_path);
  });

  it('C3.3: seamless provider type switching ("skill" -> "script") across stages', () => {
    runLifecycleKernelCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '555',
    ]);

    // Stage 1: Skill provider
    const p1 = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_1_plan',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Plan with skill',
    ]);
    const p1Data = JSON.parse(p1.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p1Data.receipt_path, '# Receipt 1');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'succeeded',
        result: { outcome: 'planned' },
        receipt_path: p1Data.receipt_path,
        summary: 'Planned with skill',
      }),
    ]);

    // Stage 2: Script provider (zero perception by state machine)
    const p2 = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--provider-type', 'script',
      '--provider-target', 'scripts/automated_worker.py',
      '--provider-arg=--fast',
      '--workdir', testEnv.dir,
      '--objective', 'Work with script',
    ]);
    expect(p2.status).toBe(0);
    const p2Data = JSON.parse(p2.stdout);

    const env1: TaskInputEnvelope = JSON.parse(fs.readFileSync(p1Data.envelope_path, 'utf-8'));
    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(p2Data.envelope_path, 'utf-8'));

    expect(env1.provider.type).toBe('skill');
    expect(env1.provider.target).toBe('pc-issue-plan');

    expect(env2.provider.type).toBe('script');
    expect(env2.provider.target).toBe('scripts/automated_worker.py');
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
    const p1 = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--workdir', testEnv.dir,
      '--objective', 'Initial implementation attempt 1',
    ]);
    const p1Data = JSON.parse(p1.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p1Data.receipt_path, '# Attempt 1 Receipt');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p1Data.receipt_path,
        summary: 'Attempt 1 failed',
      }),
    ]);

    // Attempt 2: rework cycle with --attempt-intent new
    const p2 = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--workdir', testEnv.dir,
      '--objective', 'Rework implementation attempt 2',
      '--attempt-intent', 'new',
    ]);
    expect(p2.status).toBe(0);
    const p2Data = JSON.parse(p2.stdout);
    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(p2Data.envelope_path, 'utf-8'));
    expect(env2.task.attempt).toBe(2);
    expect(env2.budgets.delivery_attempts_used).toBe(2);

    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p2Data.receipt_path, '# Attempt 2 Receipt');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p2Data.receipt_path,
        summary: 'Attempt 2 failed',
      }),
    ]);

    // Attempt 3: reached budget limit
    const p3 = runLifecycleKernelCli([
      'prepare',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--workdir', testEnv.dir,
      '--objective', 'Rework implementation attempt 3',
      '--attempt-intent', 'new',
    ]);
    expect(p3.status).toBe(0);
    const p3Data = JSON.parse(p3.stdout);
    runLifecycleKernelCli(['handoff', '--receipt-root', testEnv.dir]);
    fs.writeFileSync(p3Data.receipt_path, '# Attempt 3 Receipt');
    runLifecycleKernelCli([
      'complete',
      '--receipt-root', testEnv.dir,
      '--report', JSON.stringify({
        execution_status: 'failed',
        result: {},
        receipt_path: p3Data.receipt_path,
        summary: 'Attempt 3 failed',
      }),
    ]);

    // Check budget with max 3: now 3/3 => budget exceeded
    const budgetCheck = runStateMachineCli([
      'check-budget',
      '--receipt-root', testEnv.dir,
      '--type', 'delivery',
      '--limit', '3',
    ]);
    expect(budgetCheck.status).toBe(1);
    expect(budgetCheck.stderr).toContain('Budget exceeded: delivery_attempts_used is 3, limit is 3');
  });
});
