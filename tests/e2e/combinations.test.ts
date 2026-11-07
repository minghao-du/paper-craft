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
  runEnvelopeCli,
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

  it('C3.1: state machine init + context transition integrates with envelope --from-state', () => {
    // 1. Initialize workflow state
    const initRes = runStateMachineCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '777',
      '--workflow', 'default',
      '--initial-stage', 'stage_1_plan',
    ]);
    expect(initRes.status).toBe(0);

    // 2. Set environment context in state machine
    const fakeWorkdir = path.join(testEnv.dir, 'worktree-777');
    fs.mkdirSync(fakeWorkdir, { recursive: true });

    const transRes = runStateMachineCli([
      'transition',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_1_plan',
      '--status', 'in_progress',
      '--set', `worktree=${fakeWorkdir}`,
      '--set', 'branch=issue-777',
      '--set', 'commit=9999999999999999999999999999999999999999',
    ]);
    expect(transRes.status).toBe(0);

    // 3. Generate envelope from state
    const envelopePath = path.join(testEnv.dir, 'stage-1-envelope.json');
    const receiptPath = path.join(testEnv.dir, 'stage-1-receipt.md');
    const stateFile = path.join(testEnv.dir, 'state.json');

    const envRes = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', envelopePath,
      '--step', '1',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--objective', 'Formulate delivery plan for issue 777',
      '--receipt-path', receiptPath,
    ]);
    expect(envRes.status).toBe(0);

    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(env.task.root_issue_id).toBe('777');
    expect(env.task.logical_stage).toBe('stage_1_plan');
    expect(env.environment.working_directory).toBe(path.resolve(fakeWorkdir));
    expect(env.environment.branch).toBe('issue-777');
    expect(env.environment.commit).toBe('9999999999999999999999999999999999999999');
  });

  it('C3.2: predecessor receipt automatically chains from completed stage into successor envelope', () => {
    // 1. Init state machine
    runStateMachineCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '888',
      '--initial-stage', 'stage_1_plan',
    ]);

    // 2. Complete stage 1 with receipt
    const stage1Receipt = path.join(testEnv.dir, 'stage-1-plan-receipt.md');
    fs.writeFileSync(stage1Receipt, '# Stage 1 Plan Receipt\nOutcome: direct');

    runStateMachineCli([
      'transition',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--status', 'succeeded',
      '--outcome', 'direct',
      '--receipt', stage1Receipt,
      '--set', `worktree=${testEnv.dir}`,
      '--set', 'branch=issue-888',
    ]);

    // 3. Generate envelope for stage 2 from state
    const stage2EnvelopePath = path.join(testEnv.dir, 'stage-2-work-envelope.json');
    const stage2ReceiptPath = path.join(testEnv.dir, 'stage-2-work-receipt.md');
    const stateFile = path.join(testEnv.dir, 'state.json');

    const envRes = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', stage2EnvelopePath,
      '--step', '2',
      '--provider-type', 'script',
      '--provider-target', 'skills/pc-workspace/scripts/prepare-worktree.py',
      '--objective', 'Execute work for issue 888',
      '--receipt-path', stage2ReceiptPath,
    ]);
    expect(envRes.status).toBe(0);

    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(stage2EnvelopePath, 'utf-8'));
    expect(env.task.logical_stage).toBe('stage_2_work');
    // Predecessor receipt automatically extracted from latest completed stage
    expect(env.inputs.predecessor_receipts).toContain(stage1Receipt);
  });

  it('C3.3: seamless provider type switching ("skill" -> "script") across stages', () => {
    runStateMachineCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '555',
      '--initial-stage', 'stage_1_plan',
    ]);

    const stateFile = path.join(testEnv.dir, 'state.json');

    // Stage 1: Skill provider
    const env1Path = path.join(testEnv.dir, 'step1-skill.json');
    runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', env1Path,
      '--step', '1',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-plan',
      '--workdir', testEnv.dir,
      '--objective', 'Plan with skill',
      '--receipt-path', path.join(testEnv.dir, 'receipt1.md'),
    ]);

    // Transition state
    runStateMachineCli([
      'transition',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--status', 'succeeded',
      '--receipt', path.join(testEnv.dir, 'receipt1.md'),
      '--set', `worktree=${testEnv.dir}`,
    ]);

    // Stage 2: Script provider (zero perception by state machine)
    const env2Path = path.join(testEnv.dir, 'step2-script.json');
    runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', env2Path,
      '--step', '2',
      '--provider-type', 'script',
      '--provider-target', 'scripts/automated_worker.py',
      '--provider-arg=--fast',
      '--objective', 'Work with script',
      '--receipt-path', path.join(testEnv.dir, 'receipt2.md'),
    ]);

    const env1: TaskInputEnvelope = JSON.parse(fs.readFileSync(env1Path, 'utf-8'));
    const env2: TaskInputEnvelope = JSON.parse(fs.readFileSync(env2Path, 'utf-8'));

    expect(env1.provider.type).toBe('skill');
    expect(env1.provider.target).toBe('pc-issue-plan');

    expect(env2.provider.type).toBe('script');
    expect(env2.provider.target).toBe('scripts/automated_worker.py');
    expect(env2.provider.args).toEqual(['--fast']);

    // State machine is completely oblivious to provider differences
    const stateShow = runStateMachineCli(['show', '--receipt-root', testEnv.dir, '--json']);
    const stateObj = JSON.parse(stateShow.stdout);
    expect(stateObj.current_stage).toBe('stage_2_work');
    expect(stateObj.completed_stages.length).toBe(1);
  });

  it('C3.4: budget escalation during rework cycle propagates to envelope and triggers budget check', () => {
    runStateMachineCli([
      'init',
      '--receipt-root', testEnv.dir,
      '--root-issue', '666',
      '--initial-stage', 'stage_2_work',
    ]);

    const stateFile = path.join(testEnv.dir, 'state.json');

    // Simulate first attempt rework needed -> increment budget
    runStateMachineCli([
      'transition',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--status', 'failed',
      '--outcome', 'rework_needed',
      '--incr-budget', 'delivery_attempts_used',
      '--set', `worktree=${testEnv.dir}`,
    ]);

    // Next attempt envelope generated from state
    const attempt2Envelope = path.join(testEnv.dir, 'attempt2-input.json');
    const envRes = runEnvelopeCli([
      'create',
      '--from-state', stateFile,
      '--output', attempt2Envelope,
      '--step', '2',
      '--attempt', '2',
      '--provider-type', 'skill',
      '--provider-target', 'pc-issue-work',
      '--objective', 'Rework implementation attempt 2',
      '--receipt-path', path.join(testEnv.dir, 'attempt2-receipt.md'),
    ]);
    expect(envRes.stderr).toBe('');
    expect(envRes.status).toBe(0);

    const env: TaskInputEnvelope = JSON.parse(fs.readFileSync(attempt2Envelope, 'utf-8'));
    expect(env.task.attempt).toBe(2);
    // Envelope reflects 1 attempt used
    expect(env.budgets.delivery_attempts_used).toBe(1);

    // Increment budget again (rework attempt 2 failed)
    runStateMachineCli([
      'transition',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--status', 'failed',
      '--outcome', 'rework_needed',
      '--incr-budget', 'delivery_attempts_used',
    ]);

    // Increment budget 3rd time (max allowed 3)
    runStateMachineCli([
      'transition',
      '--receipt-root', testEnv.dir,
      '--stage', 'stage_2_work',
      '--status', 'failed',
      '--outcome', 'rework_needed',
      '--incr-budget', 'delivery_attempts_used',
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
