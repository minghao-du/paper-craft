import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';

test('protected cached overview preserves registered workflow evidence after failed reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-'));
  let dashboard;
  try {
    mkdirSync(join(root, 'pool'));
    mkdirSync(join(root, 'pool', 'worker'));
    const config = join(root, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    const status = join(root, 'pool', 'worker', '.epic-status.json');
    const original = JSON.stringify({
      issue: 42,
      phase: 'implementing',
      summary: 'Build overview',
      blockers: ['decision'],
    });
    writeFileSync(status, original);
    dashboard = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'test-secret',
      host: '127.0.0.1:7777',
      intervalMs: 60000,
    });
    const request = (path: string, headers: Record<string, string> = {}) =>
      dashboard!.app.request('http://127.0.0.1:7777' + path, {
        headers: { host: '127.0.0.1:7777', ...headers },
      });
    expect((await request('/api/snapshot')).status).toBe(401);
    expect(
      (
        await request('/api/snapshot', {
          authorization: 'Bearer test-secret',
          origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
    const headers = { authorization: 'Bearer test-secret' };
    const snapshot = await (await request('/api/snapshot', headers)).json();
    expect(snapshot.fleets[0].tasks[1]).toMatchObject({
      phase: 'implementing',
      summary: 'Build overview',
      runtime: 'unknown',
      executionIdentity: 'unknown',
    });
    expect(await (await request('/api/snapshot', headers)).json()).toEqual(snapshot);
    writeFileSync(status, '{broken');
    await dashboard.refresh(true);
    const failed = await (await request('/api/snapshot', headers)).json();
    expect(failed.fleets[0].tasks[1]).toMatchObject({ summary: 'Build overview', stale: true });
    expect(failed.fleets[0].tasks[1].error).toBeTruthy();
    expect(
      (
        await dashboard.app.request('http://127.0.0.1:7777/api/dispatch', {
          method: 'POST',
          headers: { host: '127.0.0.1:7777', ...headers },
        })
      ).status,
    ).toBe(405);
    writeFileSync(status, original);
    expect(readFileSync(status, 'utf8')).toBe(original);
  } finally {
    dashboard?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
