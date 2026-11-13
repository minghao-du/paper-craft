import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  inspectRunStorage,
  replaceRun,
  StorageError,
} from '../src/run-store/index.js';
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

    // Recovered init run must actually be able to dispatch.
    const postRecoveryDispatch = runDispatchTaskCli(env.dir, {
      request_id: 'plan-80-after-force',
      stage: 'stage_1_plan',
      objective: 'Plan issue 80',
      provider: { type: 'skill', target: 'pc-issue-plan' },
      workdir: env.dir,
    });
    expect(postRecoveryDispatch.status, postRecoveryDispatch.stderr).toBe(0);
    expect(JSON.parse(postRecoveryDispatch.stdout).launch_granted).toBe(true);
  } finally {
    env.cleanup();
  }
}, 20000);

// F12: A predictable envelope conflict must fail before writing pending-commit.json and keep the run inspectable.
test('dispatch rejects pre-existing conflicting envelope without leaving pending-commit.json', () => {
  const env = createTestDir('pc-envelope-conflict-');
  try {
    const initialized = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '81']);
    expect(initialized.status, initialized.stderr).toBe(0);

    const conflictingEnvelopePath = path.join(env.dir, '01-input.json');
    const conflictingContent = JSON.stringify({ stale: true });
    fs.writeFileSync(conflictingEnvelopePath, conflictingContent);

    const rejected = runDispatchTaskCli(env.dir, {
      request_id: 'plan-81-conflict',
      stage: 'stage_1_plan',
      objective: 'Plan issue 81',
      provider: { type: 'skill', target: 'pc-issue-plan' },
      workdir: env.dir,
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('Envelope file exists with conflicting content');
    expect(fs.existsSync(path.join(env.dir, 'pending-commit.json'))).toBe(false);
    expect(fs.readFileSync(conflictingEnvelopePath, 'utf8')).toBe(conflictingContent);

    const inspected = runLifecycleKernelCli(['inspect', '--receipt-root', env.dir]);
    expect(inspected.status, inspected.stderr).toBe(0);
    const summary = JSON.parse(inspected.stdout);
    expect(summary.active_dispatch).toBeNull();
    expect(summary.budgets.delivery_attempts_used).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(env.dir, 'state.json'), 'utf8')).next_step_index).toBe(1);
  } finally {
    env.cleanup();
  }
}, 20000);

// F05 storage guard: inspectRunStorage stays observational and replaceRun refuses dirs with dispatch artifacts.
test('inspectRunStorage recognizes dispatch artifacts without recovery and replaceRun preserves them on conflict', () => {
  const env = createTestDir('pc-storage-inspect-');
  try {
    fs.writeFileSync(path.join(env.dir, 'state.json'), '{not json');
    fs.writeFileSync(path.join(env.dir, 'pending-commit.json'), JSON.stringify({
      version: '1.0',
      expected_previous_state: null,
      target_state: { next_step_index: 2 },
      envelope: null,
    }));
    fs.writeFileSync(path.join(env.dir, '01-input.json'), '{}');
    fs.writeFileSync(path.join(env.dir, '01-stage_1_plan.md'), '# receipt');
    fs.writeFileSync(path.join(env.dir, 'state.json.corrupt-123'), '{}');

    const inspection = inspectRunStorage<{ next_step_index: number }>(env.dir);
    expect(inspection.exists).toBe(true);
    expect(inspection.stateExists).toBe(true);
    expect(inspection.stateCorrupt).toBe(true);
    expect(inspection.state).toBeNull();
    expect(inspection.pendingExists).toBe(true);
    expect(inspection.pendingCorrupt).toBe(false);
    expect(inspection.pending?.target_state).toEqual({ next_step_index: 2 });
    expect(inspection.dispatchArtifacts).toEqual(['01-input.json', '01-stage_1_plan.md']);
    expect(fs.existsSync(path.join(env.dir, 'pending-commit.json'))).toBe(true);

    let caught: unknown;
    try {
      replaceRun(env.dir, { next_step_index: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StorageError);
    expect((caught as StorageError).code).toBe('STORAGE_REPLACE_REJECTED');
    expect(fs.readFileSync(path.join(env.dir, 'state.json'), 'utf8')).toBe('{not json');
    expect(fs.existsSync(path.join(env.dir, 'pending-commit.json'))).toBe(true);
  } finally {
    env.cleanup();
  }
}, 20000);

// F05 lifecycle policy: init --force rejects once work has been dispatched; a fresh root starts a new run.
test('init --force rejects once work has been dispatched and allows a fresh receipt root', () => {
  const env = createTestDir('pc-force-dispatched-');
  const freshEnv = createTestDir('pc-force-fresh-');
  try {
    const initialized = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '82']);
    expect(initialized.status, initialized.stderr).toBe(0);

    const dispatched = runDispatchTaskCli(env.dir, {
      request_id: 'plan-82',
      stage: 'stage_1_plan',
      objective: 'Plan issue 82',
      provider: { type: 'skill', target: 'pc-issue-plan' },
      workdir: env.dir,
    });
    expect(dispatched.status, dispatched.stderr).toBe(0);

    const statePath = path.join(env.dir, 'state.json');
    const beforeState = fs.readFileSync(statePath, 'utf8');
    const envelopePath = JSON.parse(dispatched.stdout).envelope_path;
    const beforeEnvelope = fs.readFileSync(envelopePath, 'utf8');

    const rejected = runLifecycleKernelCli(['init', '--receipt-root', env.dir, '--root-issue', '82', '--force']);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('new receipt root');
    expect(fs.readFileSync(statePath, 'utf8')).toBe(beforeState);
    expect(fs.readFileSync(envelopePath, 'utf8')).toBe(beforeEnvelope);

    const freshInit = runLifecycleKernelCli(['init', '--receipt-root', freshEnv.dir, '--root-issue', '82']);
    expect(freshInit.status, freshInit.stderr).toBe(0);
  } finally {
    env.cleanup();
    freshEnv.cleanup();
  }
}, 20000);
