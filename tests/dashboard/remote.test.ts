import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';
// SSH boundary fixtures catch accidental host scanning and loss of stale job evidence.
test('remote tasks require explicit host/slot associations and retain successes after SSH failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-remote-'));
  const prior = process.env.PATH;
  let dashboard;
  try {
    mkdirSync(join(root, 'pool'));
    mkdirSync(join(root, 'pool', 'worker'));
    mkdirSync(join(root, 'bin'));
    const calls = join(root, 'calls');
    const fail = join(root, 'fail');
    writeFileSync(
      join(root, 'bin', 'ssh'),
      `#!/bin/sh\necho "$@" >> '${calls}'\nif [ -f '${fail}.timeout' ]; then exec sleep 30; fi\nif [ -f '${fail}' ]; then echo 'Permission denied' >&2; exit 255; fi\nprintf '42|RUNNING\\n'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = join(root, 'bin') + ':' + prior;
    const config = join(root, '.epic-config.json');
    const base = { clone_root: 'pool', clone_names: ['worker'], remote_hosts: ['cluster'] };
    writeFileSync(config, JSON.stringify(base));
    dashboard = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'test',
      remoteIntervalMs: 100,
    });
    const get = async () =>
      (
        await dashboard!.app.request('http://127.0.0.1:4317/api/remote', {
          headers: { host: '127.0.0.1:4317', authorization: 'Bearer test' },
        })
      ).json();
    expect(await get()).toEqual([]);
    writeFileSync(
      config,
      JSON.stringify({
        ...base,
        remote_tasks: [
          { slot: 'worker', host: 'cluster', job_id: '42' },
          { slot: 'worker', host: 'evil;uname', job_id: '43' },
        ],
      }),
    );
    await dashboard.refresh(true);
    const values = await get();
    expect(values.find((v: { host: string }) => v.host === 'cluster')).toMatchObject({
      host: 'cluster',
      jobId: '42',
      state: 'RUNNING',
      stale: false,
    });
    expect(values.find((v: { host: string }) => v.host === 'evil;uname').error).toMatch(
      /association/i,
    );
    const invoked = readFileSync(calls, 'utf8');
    expect(invoked).toContain('BatchMode=yes');
    expect(invoked).not.toContain('evil');
    writeFileSync(fail, '');
    await dashboard.refresh(true);
    const failed = await get();
    expect(failed.find((v: { host: string }) => v.host === 'cluster')).toMatchObject({
      state: 'RUNNING',
      stale: true,
    });
    expect(failed.find((v: { host: string }) => v.host === 'cluster').error).toMatch(
      /SSH|authentication/i,
    );
    writeFileSync(fail + '.timeout', '');
    await dashboard.refresh(true);
    expect((await get()).find((v: { host: string }) => v.host === 'cluster').error).toMatch(
      /timed out/,
    );
    expect(JSON.parse(readFileSync(config, 'utf8')).remote_tasks).toHaveLength(2);
  } finally {
    dashboard?.stop();
    process.env.PATH = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
