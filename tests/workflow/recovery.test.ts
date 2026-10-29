import { createHash } from 'node:crypto';
import { stateDirectory } from '../../packages/core/src/workflow/handoff.js';
import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeEpic } from '../../packages/core/src/workflow/epic-completion.js';
test('collection failure resumes the original acceptance attempt and preserves explicit closure across failed close', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-recovery-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let starts = 0,
    fail = true,
    closes = 0;
  const runner = {
    name: 'controlled',
    async preflight() {},
    async start() {
      starts++;
      return { conversation: 'same', address: 'tmux:test', evidence: 'receipt' };
    },
    async collect(a: { role: string; brief: string }) {
      if (fail) {
        fail = false;
        throw Error('collection unavailable');
      }
      if (a.brief.includes('Confirm applicability'))
        return JSON.stringify({
          pipeline: { run: false, reason: 'No workflow impact' },
          research: { run: false, reason: 'No research changes' },
        });
      return a.role === 'epic'
        ? JSON.stringify({ satisfied: true, criteria: ['verified goal'], blockers: [] })
        : 'Confirm closure';
    },
  };
  const epic = {
    repository: 'o/r',
    epic: 1,
    goal: 'goal',
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
    async finalizationContext() {
      return {
        head: 'a'.repeat(40),
        checkout: project,
        terminalSession: 'fleet',
        changes: 'verified PR files',
      };
    },
    async deliver() {
      return 'archived';
    },
    async close() {
      closes++;
      if (closes === 1) throw Error('network');
    },
  };
  try {
    const key = createHash('sha256').update(`${config.file}:o/r:1`).digest('hex');
    const stale = join(stateDirectory(config, '.runtime', 'epic-completion', key), 'driver.lock');
    mkdirSync(stale);
    writeFileSync(join(stale, 'pid'), '2147483647');
    await expect(completeEpic(config, runner, provider, epic)).rejects.toThrow('collection');
    await expect(
      completeEpic(config, runner, provider, epic, {
        epic: 1,
        confirmed: true,
        source: 'human',
        evidence: 'yes',
      }),
    ).rejects.toThrow('network');
    expect(starts).toBe(4);
    expect((await completeEpic(config, runner, provider, epic)).status).toBe('closed');
    expect(starts).toBe(4);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

import { recoverFleet } from '../../packages/core/src/workflow/recovery.js';
import { writeFileSync, readFileSync } from 'node:fs';
test('lost startup notification recovers attributed receipt and result without relaunch or resource release', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-receipt-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, 'config'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  const dir = join(config.root, '.runtime', 'tasks', 'task', 'attempt');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'attempt.json');
  writeFileSync(
    file,
    JSON.stringify({
      id: 'attempt',
      fleet: 'fleet',
      directory: dir,
      role: 'worker',
      status: 'starting',
      brief: 'work',
      checkout: project,
      runner: 'controlled',
      created: 'now',
    }),
  );
  writeFileSync(
    join(dir, 'events.jsonl'),
    '{}\n{"type":"thread.started","thread_id":"original-thread"}\n{"type":"turn.started"}\n',
  );
  const taskFile = join(dir, 'task.json');
  writeFileSync(
    taskFile,
    JSON.stringify({ repository: 'owner/repo', issue: 12, status: 'blocked', turns: [] }),
  );
  let continued = 0;
  let collected = 0;
  const runner = {
    name: 'controlled',
    async recoverReceipt() {
      return {
        conversation: 'original-thread',
        address: 'controlled:receipt',
        evidence: 'received',
      };
    },
    async preflight() {},
    async start() {
      throw Error('must not relaunch');
    },
    async collect(a: { conversation?: string }) {
      expect(a.conversation).toBe('original-thread');
      collected++;
      return 'original result';
    },
  };
  try {
    const recovered = await recoverFleet(config, runner, undefined, async (work) => {
      expect(work).toEqual({ repository: 'owner/repo', number: 12, epic: false });
      expect(JSON.parse(readFileSync(file, 'utf8')).result).toBe('original result');
      continued++;
      return { status: 'done' };
    });
    expect(recovered.ownership).toBe('retained');
    expect(recovered.continuations).toEqual([
      { repository: 'owner/repo', number: 12, epic: false, result: { status: 'done' } },
    ]);
    expect(continued).toBe(1);
    await recoverFleet(config, runner);
    expect(collected).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).result).toBe('original result');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
