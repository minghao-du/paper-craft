import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';

test('Git evidence uses cached refs and retains attributed stale values after failure without changing checkouts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-git-'));
  let dashboard;
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    const origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-b', 'main');
    git(origin, 'config', 'user.email', 'fixture@example.test');
    git(origin, 'config', 'user.name', 'Fixture');
    writeFileSync(join(origin, 'file.txt'), 'base');
    git(origin, 'add', '.');
    git(origin, 'commit', '-m', 'base');
    const project = join(root, 'project');
    execFileSync('git', ['clone', '-q', origin, project]);
    const pool = join(project, 'pool');
    mkdirSync(pool);
    const worker = join(pool, 'worker');
    execFileSync('git', ['clone', '-q', origin, worker]);
    git(worker, 'checkout', '-b', 'work');
    writeFileSync(join(worker, 'file.txt'), 'edited');
    const config = join(project, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    const before = git(worker, 'status', '--porcelain');
    dashboard = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'secret',
      host: '127.0.0.1:7777',
    });
    const read = async () =>
      (
        await dashboard!.app.request('http://127.0.0.1:7777/api/git', {
          headers: { host: '127.0.0.1:7777', authorization: 'Bearer secret' },
        })
      ).json();
    let evidence = (await read())[0];
    expect(evidence.value.slots[0]).toMatchObject({
      name: 'worker',
      branch: 'work',
      dirty: true,
      relation: 'current',
      touched: ['file.txt'],
    });
    expect(evidence.value.occupancy).toBe('unknown');
    expect(evidence.value.scope.remote).toBe('cached');
    expect(await read()).toEqual([evidence]);
    expect(git(worker, 'status', '--porcelain')).toBe(before);
    expect(readFileSync(join(worker, 'file.txt'), 'utf8')).toBe('edited');
    rmSync(config);
    await dashboard.refresh(true);
    evidence = (await read())[0];
    expect(evidence).toMatchObject({ stale: true, value: { slots: [{ branch: 'work' }] } });
    expect(evidence.error).toBeTruthy();
    expect(evidence.lastSuccessAt).toBeTruthy();
  } finally {
    dashboard?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
