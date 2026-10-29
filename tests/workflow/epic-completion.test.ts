import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeEpic } from '../../packages/core/src/workflow/epic-completion.js';
test('goal evidence and explicit target human confirmation gate EPIC closure; repeats do not close twice', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-epic-close-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let satisfied = false,
    closed = 0,
    landed = 0;
  const runner = {
    name: 'test',
    async preflight() {},
    async start(a: { id: string }) {
      return { conversation: a.id, address: 'tmux:test', evidence: 'receipt' };
    },
    async collect(a: { role: string }) {
      return a.role === 'epic'
        ? JSON.stringify({
            satisfied,
            criteria: ['objective demonstrated'],
            blockers: satisfied ? [] : ['missing evidence'],
          })
        : 'Completion evidence received; confirm EPIC closure.';
    },
  };
  const epic = {
    repository: 'o/r',
    epic: 1,
    goal: 'Original goal',
    constraints: [],
    tasks: [
      {
        number: 2,
        title: 'child',
        body: 'scope',
        brief: 'work',
        blockedBy: [],
        ready: true,
        result: 'delivered',
        checkout: project,
      },
    ],
    turns: [],
    status: 'delivered' as const,
  };
  const provider = {
    async deliver() {
      landed++;
      return 'merged, recorded and archived';
    },
    async close() {
      closed++;
    },
  };
  try {
    expect((await completeEpic(config, runner, provider, epic)).status).toBe('blocked');
    expect(closed).toBe(0);
    satisfied = true;
    expect((await completeEpic(config, runner, provider, epic)).status).toBe(
      'awaiting_confirmation',
    );
    expect(
      (
        await completeEpic(config, runner, provider, epic, {
          epic: 1,
          confirmed: false,
          source: 'human',
          evidence: 'No',
        })
      ).status,
    ).toBe('awaiting_confirmation');
    expect(closed).toBe(0);
    expect(
      (
        await completeEpic(config, runner, provider, epic, {
          epic: 1,
          confirmed: true,
          source: 'human',
          evidence: 'Close EPIC 1',
        })
      ).status,
    ).toBe('closed');
    await completeEpic(config, runner, provider, epic);
    expect(closed).toBe(1);
    expect(landed).toBe(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
