/** Batch recovery delegates authority and evidence reconciliation to each Run. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from './handoff.js';
import type { FleetConfig } from './fleet-config.js';
import type { RunnerAdapter } from './runtime.js';
import { inspectRuns, recoverRun } from './run-driver.js';

/** Reconcile all incomplete Runs independently; never adopt unowned legacy work. */
export async function recoverAllRuns(
  config: FleetConfig,
  runnerFor: (provider: string) => RunnerAdapter,
) {
  const outcomes: {
    run: string;
    blockers?: string[];
    pendingDispatches?: string[];
    error?: string;
  }[] = [];
  const legacy: { file: string; status: 'blocked'; error: string }[] = [];
  const runs = inspectRuns(config).runs;
  const owned = new Set(runs.map((run) => run.id));
  for (const run of runs.filter((r) => r.lifecycle !== 'completed')) {
    try {
      const runner = runnerFor(run.provider);
      outcomes.push({ run: run.id, ...(await recoverRun(config, runner, run.id)) });
    } catch (error) {
      outcomes.push({ run: run.id, error: String(error) });
    }
  }
  // Only identify orphaned business records. Global attempts are never read or adopted.
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Recovery refuses symlink state');
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (['task.json', 'epic.json', 'pr.json', 'completion.json'].includes(entry.name)) {
        const record = JSON.parse(readFileSync(file, 'utf8'));
        const owners = [
          record.run,
          record.runId,
          ...(record.turns ?? []).map((a: { run?: string }) => a.run),
        ];
        if (!owners.some((owner) => owned.has(owner)))
          legacy.push({
            file,
            status: 'blocked',
            error: 'Work has no Run ownership; complete or archive it explicitly',
          });
      }
    }
  }
  visit(stateDirectory(config, '.runtime'));
  return {
    status:
      outcomes.some((o) => o.error || o.blockers?.length) || legacy.length
        ? 'unknown'
        : 'reconciled',
    outcomes,
    legacy,
  };
}
