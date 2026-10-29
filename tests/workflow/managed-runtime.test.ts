import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startConductor,
  inspectConductor,
  type RunnerAdapter,
} from '../../packages/core/src/workflow/runtime.js';

test('startup requires runner evidence and isolates fleets, retaining a failed brief', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-runtime-')));
  const config = (name: string) => {
    const project = join(root, name);
    mkdirSync(project);
    return {
      file: join(project, '.epic-config.json'),
      project,
      root,
      slots: [],
      worktrees: false,
      base: 'main',
    };
  };
  const a = config('a');
  const b = config('b');
  const runner: RunnerAdapter = {
    name: 'controlled',
    async preflight() {},
    async start(attempt) {
      return { conversation: attempt.id, address: 'tmux:test', evidence: 'runner received brief' };
    },
  };
  try {
    const first = await startConductor(a, runner, 'read AGENTS.md');
    expect(first.status).toBe('running');
    expect(inspectConductor(a)?.conversation).toBe(first.id);
    await expect(startConductor(a, runner, 'duplicate')).rejects.toThrow(/occupied/);
    const failed = await startConductor(
      b,
      {
        ...runner,
        async start() {
          throw new Error('no runner acknowledgement');
        },
      },
      'keep this brief',
    );
    expect(failed.status).toBe('unknown');
    expect(inspectConductor(b)).toMatchObject({
      brief: 'keep this brief',
      error: 'no runner acknowledgement',
    });
    expect(failed.fleet).not.toBe(first.fleet);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('missing capabilities refuse launch; an empty receipt cannot report successful startup', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-capability-')));
  const config = {
    file: join(root, '.epic-config.json'),
    project: root,
    root,
    slots: [],
    worktrees: false,
    base: 'main',
  };
  const runner: RunnerAdapter = {
    name: 'controlled',
    async preflight() {
      throw new Error('missing input capability');
    },
    async start() {
      throw new Error('must not launch');
    },
  };
  try {
    await expect(startConductor(config, runner, 'brief')).rejects.toThrow(
      'missing input capability',
    );
    expect(inspectConductor(config)).toBeUndefined();
    const result = await startConductor(
      config,
      {
        ...runner,
        async preflight() {},
        async start() {
          return { conversation: '', address: 'tmux:only', evidence: '' };
        },
      },
      'retained',
    );
    expect(result).toMatchObject({ status: 'unknown', brief: 'retained' });
    expect(result.error).toContain('startup evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('core waits and cancellation preserve occupied identity until verified termination', async () => {
  const { waitAttempt, cancelAttempt, inspectAttemptControl, reconcileAttempt } =
    await import('../../packages/core/src/workflow/runtime.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-core-control-')));
  try {
    const attempt = {
      id: 'attempt',
      fleet: 'fleet',
      role: 'worker' as const,
      runner: 'controlled',
      brief: 'work',
      status: 'running' as const,
      created: 'now',
      directory: root,
      checkout: root,
    };
    let finish!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    expect(await waitAttempt(attempt, { collect: () => pending }, 1)).toEqual({ timedOut: true });
    expect(attempt.status).toBe('running');
    expect((await cancelAttempt(attempt, {})).cancellation?.outcome).toBe('unsupported');
    expect(
      (
        await cancelAttempt(attempt, {
          cancellation: true,
          async cancel() {
            throw new Error('refused');
          },
        })
      ).cancellation?.outcome,
    ).toBe('failed');
    expect((await reconcileAttempt(attempt, {})).execution?.status).toBe('unknown');
    finish('late result');
    expect(await waitAttempt(attempt, { collect: () => pending }, 100)).toEqual({
      timedOut: false,
      result: 'late result',
    });
    expect(
      (
        await cancelAttempt(attempt, {
          cancellation: true,
          async cancel() {
            return { evidence: 'verified process exit' };
          },
        })
      ).execution?.status,
    ).toBe('terminated');
    expect(inspectAttemptControl(attempt).cancellation?.evidence).toBe('verified process exit');
    expect(attempt.status).toBe('running'); // checkout and role ownership unchanged
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
