import { createHash } from 'node:crypto';
import { Subagents, type ShortRunner } from './subagents.js';
/** Recover only attributed receipts/results; never infer checkout availability from process loss. */
import {
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDirectory } from './handoff.js';
import type { FleetConfig } from './fleet-config.js';
import type { IssueTurn, RoundRunner } from './issue-driver.js';
/** Inspect configured durable records and retry collection of the original attempts only. */
export async function recoverFleet(
  config: FleetConfig,
  runner: RoundRunner & { collectable?(attempt: IssueTurn): boolean },
  shortRunner?: ShortRunner,
  resume?: (work: { repository: string; number: number; epic: boolean }) => Promise<unknown>,
) {
  const root = stateDirectory(config, '.runtime');
  const outcomes: { file: string; attempt: string; status: string; error?: string }[] = [];
  const workflows = new Map<string, { repository: string; number: number; epic: boolean }>();
  async function visit(directory: string): Promise<void> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Recovery refuses symlink state');
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      if (
        ![
          'task.json',
          'epic.json',
          'completion.json',
          'pr.json',
          'conductor.json',
          'attempt.json',
        ].includes(entry.name)
      )
        continue;
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (record.repository && (entry.name === 'task.json' || entry.name === 'epic.json')) {
        const work = {
          repository: record.repository as string,
          number: Number(record.issue ?? record.epic),
          epic: entry.name === 'epic.json',
        };
        workflows.set(`${work.repository}:${work.number}:${work.epic}`, work);
      }
      const attempts: IssueTurn[] = Array.isArray(record.turns)
        ? record.turns
        : record.id && record.directory
          ? [record]
          : [];
      let changed = false;
      for (const a of attempts) {
        if (
          !a.directory ||
          !realpathSync(a.directory).startsWith(root + '/') ||
          realpathSync(a.directory) !== a.directory
        )
          throw new Error('Attempt outside configured state');
        if (a.result !== undefined || a.retired) continue;
        // Startup evidence may have arrived after the launching driver was interrupted.
        if (!a.conversation && runner.recoverReceipt) {
          const receipt = await runner.recoverReceipt(a);
          if (receipt) {
            Object.assign(a, receipt, { status: 'running' });
            changed = true;
          }
        }
        if (!a.conversation || a.status !== 'running') {
          outcomes.push({ file, attempt: a.id, status: 'unknown' });
          continue;
        }
        if (runner.collectable && !runner.collectable(a)) {
          outcomes.push({ file, attempt: a.id, status: 'unknown' });
          continue;
        }
        try {
          a.result = await runner.collect(a);
          changed = true;
          outcomes.push({ file, attempt: a.id, status: 'collected' });
        } catch (error) {
          outcomes.push({ file, attempt: a.id, status: 'retained', error: String(error) });
        }
      }
      if (changed) {
        const temp = file + randomUUID();
        writeFileSync(temp, JSON.stringify(record, null, 2));
        renameSync(temp, file);
      }
    }
  }
  if (shortRunner) {
    const policy = join(
      root,
      'subagents',
      createHash('sha256').update(config.file).digest('hex'),
      'limits.json',
    );
    const queue = new Subagents(
      config,
      existsSync(policy) ? JSON.parse(readFileSync(policy, 'utf8')) : undefined,
    );
    for (const task of queue.list()) await queue.reconcile(task.id, shortRunner);
  }
  await visit(root);
  const continuations = [];
  if (resume && !outcomes.some((o) => o.status === 'unknown' || o.status === 'retained')) {
    for (const work of workflows.values()) {
      try {
        continuations.push({ ...work, result: await resume(work) });
      } catch (error) {
        continuations.push({ ...work, error: String(error) });
      }
    }
  }
  return {
    continuations,
    outcomes,
    ownership: 'retained',
    next: resume
      ? 'Original workflows continued; inspect continuation results'
      : 'Reconciliation only; supply a workflow continuation handler',
  };
}
