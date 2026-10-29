import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drivePullRequest } from '../../packages/core/src/workflow/pr-driver.js';
test('landing repairs failed checks and rechecks changed heads without human approval', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-pr-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'HEAD',
  };
  let head = 'a',
    checks = 0,
    merged = 0;
  const roles: string[] = [];
  const github = {
    async ensure() {
      return 4;
    },
    async read() {
      return { head, state: merged ? 'MERGED' : 'OPEN', conflict: false };
    },
    async checks() {
      checks++;
      return checks === 1 ? ('failed' as const) : ('passed' as const);
    },
    async merge(_p: number, sha: string) {
      expect(sha).toBe('b');
      merged++;
    },
  };
  const runner = {
    name: 'controlled',
    async preflight() {},
    async start(a: any) {
      roles.push(a.role);
      return { conversation: a.id, address: 'tmux:test', evidence: 'receipt' };
    },
    async collect(a: any) {
      if (a.role === 'worker') head = 'b';
      return JSON.stringify({ passed: true, head, evidence: 'quality gates passed' });
    },
  };
  try {
    const result = await drivePullRequest(config, runner, github, {
      repository: 'o/r',
      issue: 3,
      checkout: project,
    });
    expect(result.status).toBe('merged');
    expect(roles).toEqual(['worker', 'landing']);
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(merged).toBe(1);
    await drivePullRequest(config, runner, github, {
      repository: 'o/r',
      issue: 3,
      checkout: project,
    });
    expect(merged).toBe(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('moved heads repeat Landing gates and EPIC confirmation is required before execution', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-pr-gates-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'HEAD',
  };
  let head = 'first',
    merged = false,
    landings = 0;
  const github = {
    async ensure() {
      return 8;
    },
    async read() {
      return { head, state: merged ? 'MERGED' : 'OPEN', conflict: false };
    },
    async checks() {
      return 'passed' as const;
    },
    async merge(_p: number, sha: string) {
      expect(sha).toBe('second');
      merged = true;
    },
  };
  const runner = {
    name: 'controlled',
    async preflight() {},
    async start(a: import('../../packages/core/src/workflow/runtime.js').ManagedAttempt) {
      return { conversation: a.id, address: 'tmux:test', evidence: 'receipt' };
    },
    async collect() {
      landings++;
      const evaluated = head;
      head = 'second';
      return JSON.stringify({ passed: true, head: evaluated, evidence: 'checks complete' });
    },
  };
  try {
    await expect(
      drivePullRequest(config, runner, github, {
        repository: 'o/r',
        issue: 9,
        checkout: project,
        epic: 20,
      }),
    ).rejects.toThrow('EPIC professional confirmation');
    expect(landings).toBe(0);
    const result = await drivePullRequest(config, runner, github, {
      repository: 'o/r',
      issue: 10,
      checkout: project,
    });
    expect(result.checkedHead).toBe('second');
    expect(landings).toBe(2);
    expect(merged).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
