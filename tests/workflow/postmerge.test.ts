import type { IssueTurn } from '../../packages/core/src/workflow/issue-driver.js';
import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { finishDelivery } from '../../packages/core/src/workflow/postmerge.js';
test('merged delivery records and archives before releasing a real worktree; unknown occupancy retains it', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-finish-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(project, 'README'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  mkdirSync(join(project, 'pool'));
  const checkout = join(project, 'pool', 'issue-7');
  git('worktree', 'add', '-b', 'task', checkout);
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'HEAD',
  };
  let stopped = false,
    closed = 0,
    interrupted = false;
  const roles: string[] = [];
  const runner = {
    name: 'controlled',
    async preflight() {},
    async start(a: IssueTurn) {
      roles.push(a.role);
      return { conversation: a.id, address: 'tmux:test', evidence: 'started' };
    },
    async collect(a: IssueTurn) {
      if (a.role === 'conductor' && !interrupted) {
        interrupted = true;
        throw Error('notification lost after cleanup');
      }
      return a.role === 'worker'
        ? JSON.stringify({
            complete: true,
            assessment: 'delivered',
            worklog: 'Verified merged delivery',
          })
        : 'Conductor received completion';
    },
    async stopped() {
      return stopped;
    },
  };
  const provider = {
    async merged() {
      return true;
    },
    async close() {
      closed++;
    },
  };
  try {
    await expect(
      finishDelivery(config, runner, provider, { repository: 'o/r', issue: 7, checkout }, 4, []),
    ).rejects.toThrow(/occupancy/);
    expect(existsSync(checkout)).toBe(true);
    expect(closed).toBe(1);
    stopped = true;
    await expect(
      finishDelivery(config, runner, provider, { repository: 'o/r', issue: 7, checkout }, 4, []),
    ).rejects.toThrow('notification lost');
    expect(existsSync(checkout)).toBe(false);
    const done = await finishDelivery(
      config,
      runner,
      provider,
      { repository: 'o/r', issue: 7, checkout },
      4,
      [],
    );
    expect(done.status).toBe('done');
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(join(done.archive!, '.epic-worklog.md'))).toBe(true);
    expect(closed).toBe(1);
    expect(roles).toEqual(['worker', 'landing', 'conductor']);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
