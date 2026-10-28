import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';

test('authenticated logs are bounded, segmented and restricted to verified registered sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'logs-'));
  let service;
  let moved = false;
  let captures = 0;
  try {
    mkdirSync(join(root, 'pool', 'worker'), { recursive: true });
    const config = join(root, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    writeFileSync(join(root, 'pool', 'worker', '.epic-status.json'), '{"phase":"coding"}');
    const log = join(root, 'pool', 'worker', '.epic-worklog.md');
    const original = 'Progress\n'.repeat(10000) + 'Authorization: Bearer private-secret\n';
    writeFileSync(log, original);
    service = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'test',
      host: 'local',
      executeRuntime: async (program, args) => {
        if (args[0] === 'capture-pane') {
          captures++;
          moved = true;
          return 'private result';
        }
        if (program === 'tmux')
          return `%1\t${moved ? '/elsewhere' : join(root, 'pool', 'worker')}\t123\t0\tzsh`;
        return 'zsh';
      },
    });
    const get = (url: string, auth = true) =>
      service!.app.request('http://local' + url, {
        headers: { host: 'local', ...(auth ? { authorization: 'Bearer test' } : {}) },
      });
    const snapshot = await (await get('/api/snapshot')).json();
    const id = encodeURIComponent(snapshot.fleets[0].tasks[1].id);
    const url = `/api/tasks/${id}/logs`;
    expect((await get(url, false)).status).toBe(401);
    const first = await (await get(url)).json();
    expect(first).toMatchObject({ kind: 'worklog', state: 'read', offset: 0, nextOffset: 16384 });
    expect(first.text.length).toBeLessThanOrEqual(16384);
    const last = await (await get(url + '?offset=79990')).json();
    expect(last.text).not.toContain('private-secret');
    expect((await get(url + '?path=/etc/passwd')).status).toBe(400);
    expect((await get(url + '?source=runner')).status).toBe(200);
    expect(await (await get(url + '?source=runner')).json()).toMatchObject({ state: 'unknown' });
    rmSync(log);
    symlinkSync('/etc/passwd', log);
    expect(await (await get(url)).json()).toMatchObject({ state: 'error' });
    expect((await get('/api/tasks/unknown/logs')).status).toBe(404);
    const terminal = await (await get(url + '?source=terminal')).json();
    expect(terminal).toMatchObject({
      state: 'unknown',
      error: 'Terminal identity changed during read',
    });
    expect(terminal.text).toBeUndefined();
    expect(captures).toBe(1);
  } finally {
    service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
