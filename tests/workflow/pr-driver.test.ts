import {
  startRun,
  inspectRuns,
  startBusinessTurn,
  collectBusinessTurn,
} from '../../packages/core/src/workflow/run-driver.js';
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
      return 'passed' as const;
    },
    async merge(_p: number, sha: string) {
      if (sha === 'a') throw new Error('Worker must update stale base before merge');
      expect(sha).toBe('b');
      merged++;
    },
  };
  const runner = {
    name: 'controlled',
    async stopped() {
      return true;
    },
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
    expect(roles).toEqual(['landing', 'worker', 'landing']);
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
    async stopped() {
      return true;
    },
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

test('uncertain merge is reconciled once and retains merged version', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-pr-uncertain-')));
  mkdirSync(join(project, 'pool'));
  let merged = false,
    calls = 0;
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'HEAD',
  };
  const github = {
    async ensure() {
      return 2;
    },
    async read() {
      return {
        head: 'evaluated',
        state: merged ? 'MERGED' : 'OPEN',
        conflict: false,
        mergeCommit: merged ? 'merged-sha' : undefined,
        repository: 'o/r',
        issues: [3],
      };
    },
    async checks() {
      return 'passed' as const;
    },
    async merge() {
      calls++;
      merged = true;
      throw new Error('connection lost');
    },
  };
  const runner = {
    name: 'codex',
    async stopped() {
      return true;
    },
    async preflight() {},
    async start() {
      return { conversation: 'c', address: 'tmux:test', evidence: 'ack' };
    },
    async collect() {
      return JSON.stringify({ passed: true, head: 'evaluated', evidence: 'verified checks' });
    },
  };
  try {
    const managed = await startRun(
      config,
      runner,
      { repository: 'o/r', number: 3, title: 'deliver', body: 'bounded task', kind: 'issue' },
      'codex',
    );
    const implementation = await startBusinessTurn(
      config,
      runner,
      { ...managed.orchestrator!, role: 'worker', brief: 'Implement bounded Issue' },
      'o/r',
      3,
    );
    await collectBusinessTurn(config, runner, implementation);
    const result = await drivePullRequest(config, runner, github, {
      repository: 'o/r',
      issue: 3,
      checkout: project,
    });
    expect(result.mergeCommit).toBe('merged-sha');
    expect(result.checkedHead).toBe('evaluated');
    expect(calls).toBe(1);
    const graph = inspectRuns(config);
    expect(graph.pullRequests?.[0]).toMatchObject({
      runId: managed.id,
      status: 'merged',
      mergeCommit: 'merged-sha',
    });
    expect(graph.dispatches?.[0].lifecycle).toBe('accepted');
    expect(graph.runs[0].lifecycle).toBe('running');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
