import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createTestDir, runLifecycleKernelCli, runPrepareTaskCli } from './test-helpers.js';

// A crash between envelope and state writes must not allocate or authorize work twice.
test('prepared dispatch recovers without duplicate steps, budget consumption or handoff', () => {
  const env = createTestDir('pc-recovery-');
  try {
    const initialized = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '79']);
    expect(initialized.status, initialized.stderr).toBe(0);
    const statePath = path.join(env.dir, 'state.json');
    const initialState = fs.readFileSync(statePath, 'utf8');
    const request = {
      stage: 'stage_1_plan', objective: 'Plan issue 79',
      provider: { type: 'skill', target: 'pc-issue-plan' }, workdir: env.dir,
    };
    const prepared = runPrepareTaskCli(env.dir, request);
    expect(prepared.status, prepared.stderr).toBe(0);
    const dispatch = JSON.parse(prepared.stdout);
    const preparedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const repeated = runPrepareTaskCli(env.dir, request);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout).dispatch_id).toBe(dispatch.dispatch_id);

    // Recreate the interrupted write boundary while keeping the durable envelope.
    fs.writeFileSync(statePath, initialState);
    const recovered = runPrepareTaskCli(env.dir, request);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).dispatch_id).toBe(dispatch.dispatch_id);
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(recoveredState.next_step_index).toBe(preparedState.next_step_index);
    expect(recoveredState.budgets.delivery_attempts_used).toBe(preparedState.budgets.delivery_attempts_used);

    const handoff = runLifecycleKernelCli(['handoff', '--receipt-root', env.dir]);
    expect(handoff.status, handoff.stderr).toBe(0);
    expect(JSON.parse(handoff.stdout).authorized).toBe(true);
    const duplicateHandoff = runLifecycleKernelCli(['handoff', '--receipt-root', env.dir]);
    expect(duplicateHandoff.status, duplicateHandoff.stderr).toBe(0);
    expect(JSON.parse(duplicateHandoff.stdout).authorized).toBe(false);
  } finally {
    env.cleanup();
  }
}, 20000);
