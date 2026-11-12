import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createTestDir, runLifecycleKernelCli, runDispatchTaskCli } from './helpers.js';

// A crash between envelope and state writes must preserve the launch decision and allocation.
test('dispatch recovery retains the original authorization, step and budget', () => {
  const env = createTestDir('pc-recovery-');
  try {
    const initialized = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '79']);
    expect(initialized.status, initialized.stderr).toBe(0);
    const statePath = path.join(env.dir, 'state.json');
    const pendingPath = path.join(env.dir, 'pending-commit.json');
    const initialState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const request = {
      request_id: 'plan-79',
      stage: 'stage_1_plan', objective: 'Plan issue 79',
      provider: { type: 'skill', target: 'pc-issue-plan' }, workdir: env.dir,
    };
    const first = runDispatchTaskCli(env.dir, request);
    expect(first.status, first.stderr).toBe(0);
    const dispatched = JSON.parse(first.stdout);
    expect(dispatched.launch_granted).toBe(true);
    const dispatchedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const envelope = fs.readFileSync(dispatched.envelope_path, 'utf8');

    // Leave the envelope and pending commit on disk as the writer would after interruption.
    fs.writeFileSync(statePath, JSON.stringify(initialState));
    fs.writeFileSync(pendingPath, JSON.stringify({
      version: '1.0',
      expected_previous_state: initialState,
      target_state: dispatchedState,
      envelope: {
        filename: path.basename(dispatched.envelope_path),
        content: JSON.parse(envelope),
      },
    }));

    const replay = { ...dispatched, launch_granted: false };
    const recovered = runDispatchTaskCli(env.dir, request);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toEqual(replay);
    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(fs.readFileSync(dispatched.envelope_path, 'utf8')).toBe(envelope);
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(recoveredState.next_step_index).toBe(initialState.next_step_index + 1);
    expect(recoveredState.budgets.delivery_attempts_used).toBe(1);

    const repeated = runDispatchTaskCli(env.dir, request);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual(replay);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual(recoveredState);
  } finally {
    env.cleanup();
  }
}, 20000);

// Forced init over a corrupt state must preserve evidence and still start a fresh run.
test('init --force replaces corrupt state and keeps it as evidence', () => {
  const env = createTestDir('pc-force-corrupt-');
  try {
    const first = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '80']);
    expect(first.status, first.stderr).toBe(0);
    const statePath = path.join(env.dir, 'state.json');
    fs.writeFileSync(statePath, '{not json');
    const plain = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '80']);
    expect(plain.status).not.toBe(0);
    const forced = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '80', '--force']);
    expect(forced.status, forced.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).root_issue_id).toBe('80');
    expect(fs.readdirSync(env.dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  } finally {
    env.cleanup();
  }
}, 20000);
