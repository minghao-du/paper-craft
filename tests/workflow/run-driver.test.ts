import { readDashboardFleet } from '../../packages/core/src/workflow/dashboard.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startRun, inspectRuns } from '../../packages/core/src/workflow/run-driver.js';

test('intake reconnects an acknowledged Run and rejects conflicting ownership without launching', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'pc-run-')));
  mkdirSync(join(project, 'pool'));
  const config = {
    file: join(project, '.epic-config.json'),
    project,
    root: join(project, 'pool'),
    slots: [],
    worktrees: true,
    base: 'main',
  };
  let launches = 0;
  const runner = {
    name: 'codex',
    async preflight() {},
    async start() {
      launches++;
      return { conversation: 'session', address: 'tmux:verified', evidence: 'ack' };
    },
  };
  const subject = {
    repository: 'owner/repo',
    number: 7,
    kind: 'issue' as const,
    title: 'task',
    body: 'deliver',
  };
  try {
    writeFileSync(config.file, JSON.stringify({ clone_root: 'pool', local_worktrees: true }));
    const first = await startRun(config, runner, subject, 'codex');
    expect(first.orchestrator?.status).toBe('running');
    expect((await startRun(config, runner, subject, 'codex')).id).toBe(first.id);
    await expect(startRun(config, runner, { ...subject, number: 8 }, 'codex')).rejects.toThrow(
      /occupied/,
    );
    expect(launches).toBe(1);
    const snapshot = await readDashboardFleet({ id: 'fleet', config: config.file });
    expect(snapshot.tasks.find((task) => task.runId === first.id)?.orchestratorId).toBe(
      first.orchestratorId,
    );
    expect(inspectRuns(config).runs).toHaveLength(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
