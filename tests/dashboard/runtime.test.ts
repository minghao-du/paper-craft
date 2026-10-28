import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboard } from '../../packages/dashboard/src/server.js';

test('runtime HTTP evidence attributes panes by physical directory, keeps shell occupancy unknown and retains stale successes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-'));
  let service;
  try {
    mkdirSync(join(root, 'pool', 'worker'), { recursive: true });
    const config = join(root, '.epic-config.json');
    writeFileSync(config, JSON.stringify({ clone_root: 'pool', clone_names: ['worker'] }));
    const status = join(root, 'pool', 'worker', '.epic-status.json');
    writeFileSync(status, JSON.stringify({ phase: 'coding', summary: 'Working' }));
    const oldTime = new Date(Date.now() - 60 * 60000);
    utimesSync(status, oldTime, oldTime);
    let failed = false;
    let calls = 0;
    service = await createDashboard({
      dataDir: join(root, 'data'),
      configs: [config],
      token: 'test',
      host: 'local',
      runtimeIntervalMs: 60000,
      executeRuntime: async (program: string) => {
        calls++;
        if (failed) throw new Error('missing executable');
        return program === 'tmux'
          ? `%1\t${root}/pool/worker\t123\t0\tzsh\n%2\t/unrelated\t456\t0\tclaude`
          : 'zsh';
      },
    });
    const read = () =>
      service!.app.request('http://local/api/snapshot', {
        headers: { host: 'local', authorization: 'Bearer test' },
      });
    const first = await (await read()).json();
    expect(first.fleets[0].tasks[1].runtimeEvidence).toMatchObject({
      occupancy: 'unknown',
      tmux: { state: 'observed', panes: [{ id: '%1', command: 'zsh' }] },
      runner: { state: 'unknown' },
    });
    expect(first.fleets[0].tasks[1].interventions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining('Possibly stalled') }),
      ]),
    );
    const count = calls;
    await read();
    await read();
    expect(calls).toBe(count);
    failed = true;
    await service.refreshRuntime(true);
    const stale = await (await read()).json();
    expect(stale.fleets[0].tasks[1].runtimeEvidence).toMatchObject({
      stale: true,
      tmux: { panes: [{ id: '%1' }] },
      error: expect.any(String),
    });
    expect(stale.fleets[0].tasks[1].runtime).toBe('unknown');
  } finally {
    service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
