import { readDashboardFleet } from '../../packages/core/src/workflow/dashboard.js';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startRun,
  inspectRuns,
  dispatchStage,
  publishStageReceipt,
  acceptStageReceipt,
  retryStage,
  recoverRun,
  setRemediationLimit,
  updateRunRegistry,
} from '../../packages/core/src/workflow/run-driver.js';

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
    const other = await startRun(config, runner, { ...subject, number: 8 }, 'codex');
    expect(other.orchestratorId).not.toBe(first.orchestratorId);
    expect(launches).toBe(2);
    const snapshot = await readDashboardFleet({ id: 'fleet', config: config.file });
    expect(snapshot.tasks.find((task) => task.runId === first.id)?.orchestratorId).toBe(
      first.orchestratorId,
    );
    expect(inspectRuns(config).runs).toHaveLength(2);
    const request = {
      runId: first.id,
      authority: first.orchestratorId,
      subject: 'owner/repo#7',
      role: 'worker' as const,
      stage: 'implementation',
      inputRevision: 'head-a',
      brief: 'Implement task',
      prerequisites: [],
    };
    const stage = await dispatchStage(config, runner, request);
    expect((await dispatchStage(config, runner, request)).id).toBe(stage.id);
    await expect(
      retryStage(config, runner, stage.id, first.orchestratorId, async () => false),
    ).rejects.toThrow(/occupancy/);
    const retried = await retryStage(
      config,
      runner,
      stage.id,
      first.orchestratorId,
      async () => true,
    );
    expect(retried.attempts).toHaveLength(2);
    const dependent = {
      ...request,
      stage: 'merge',
      role: 'landing' as const,
      prerequisites: [stage.id],
    };
    await expect(dispatchStage(config, runner, dependent)).rejects.toThrow(/prerequisite/);
    const receipt = publishStageReceipt(config, {
      dispatchId: stage.id,
      attemptId: retried.attempts[1].id,
      runId: first.id,
      subject: request.subject,
      role: request.role,
      stage: request.stage,
      provider: 'codex',
      inputRevision: 'head-a',
      outcome: 'completed',
      evidence: [first.brief],
    });
    await expect(
      acceptStageReceipt(config, first.orchestratorId, receipt.id, async () => ({
        currentRevision: 'head-b',
        ownership: true,
        evidence: 'checked',
      })),
    ).rejects.toThrow(/stale/);
    const corrected = publishStageReceipt(config, { ...receipt, corrects: receipt.id });
    await acceptStageReceipt(config, first.orchestratorId, corrected.id, async () => ({
      currentRevision: 'head-a',
      ownership: true,
      evidence: 'checked current facts',
    }));
    expect((await dispatchStage(config, runner, dependent)).stage).toBe('merge');
    expect(inspectRuns(config).receipts).toHaveLength(2);
    // Crash after publication but before the registry/event update: recover immutable files.
    updateRunRegistry(config, (state) => {
      state.receipts = [];
      state.stageEvents = [];
    });
    const recovered = await recoverRun(config, runner, first.id);
    expect(recovered.pendingDispatches).toContain(stage.id);
    expect(inspectRuns(config).receipts).toHaveLength(2);
    await recoverRun(config, runner, first.id);
    expect(inspectRuns(config).stageEvents).toHaveLength(2);
    expect(launches).toBe(5);
    const mergeStage = inspectRuns(config).dispatches!.find((d) => d.stage === 'merge')!;
    setRemediationLimit(config, first.id, first.orchestratorId, mergeStage.id, 1);
    const failed = publishStageReceipt(config, {
      ...receipt,
      dispatchId: mergeStage.id,
      attemptId: mergeStage.attempts[0].id,
      role: 'landing',
      stage: 'merge',
      outcome: 'changes_needed',
    });
    await expect(
      acceptStageReceipt(config, first.orchestratorId, failed.id, async () => ({
        currentRevision: 'head-a',
        ownership: true,
        evidence: 'Checks still failing',
      })),
    ).rejects.toThrow(/Rejected/);
    await recoverRun(config, runner, first.id);
    await expect(
      retryStage(config, runner, mergeStage.id, first.orchestratorId, async () => true),
    ).rejects.toThrow(/exhausted/);
    const oldAuthority = first.orchestratorId;
    await recoverRun(config, runner, first.id, {
      stopped: async () => true,
      replaceOrchestrator: true,
    });
    await expect(
      dispatchStage(config, runner, { ...request, authority: oldAuthority, stage: 'stale' }),
    ).rejects.toThrow(/authority/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
