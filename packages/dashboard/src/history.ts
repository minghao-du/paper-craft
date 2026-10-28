/** Dashboard-owned observations, never an execution audit or transcript archive. */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Metadata about a meaningful observed change; values and private text are excluded. */
export interface ObservedChange {
  observedAt: string;
  kind: 'change' | 'monitoring-gap';
  fleetId: string;
  subject: string;
  source: string;
  fingerprint: string;
  executionIdentity: 'unknown';
  gapFrom?: string;
}
const volatile = new Set(['observedAt', 'lastSuccessAt', 'generatedAt', 'version', 'modifiedAt']);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !volatile.has(key))
        .map(([key, v]) => [key, stable(v)]),
    );
  return value;
}
/** Persist only change metadata and hashes; maintain an explicit service heartbeat. */
export async function observationHistory(dataDir: string, now = Date.now) {
  const file = join(dataDir, 'observations.jsonl');
  const checkpoint = join(dataDir, 'observation-checkpoint.json');
  let events: ObservedChange[] = [];
  let last: string | undefined;
  try {
    events = (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw new Error('Cannot read Dashboard observation history', { cause: error });
  }
  try {
    last = JSON.parse(await readFile(checkpoint, 'utf8')).observedAt;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw new Error('Cannot read Dashboard observation checkpoint', { cause: error });
  }
  const fingerprints = new Map<string, string>();
  for (const event of events)
    if (event.kind === 'change')
      fingerprints.set(`${event.fleetId}:${event.subject}:${event.source}`, event.fingerprint);
  if (last)
    events.push({
      observedAt: new Date(now()).toISOString(),
      kind: 'monitoring-gap',
      fleetId: '',
      subject: 'service',
      source: 'monitoring',
      fingerprint: '',
      executionIdentity: 'unknown',
      gapFrom: last,
    });
  let pending = Promise.resolve();
  const persist = async () => {
    events = events.filter((e) => Date.parse(e.observedAt) >= now() - 30 * 86400000);
    await writeFile(file + '.tmp', events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
      mode: 0o600,
    });
    await rename(file + '.tmp', file);
    await writeFile(checkpoint, JSON.stringify({ observedAt: new Date(now()).toISOString() }), {
      mode: 0o600,
    });
  };
  await persist();
  return {
    read: () => ({
      events: [...events].reverse(),
      coverage:
        'Observed changes only; unseen intermediate events and execution attempts are unknown.',
    }),
    observe(rows: { fleetId: string; subject: string; source: string; value: unknown }[]) {
      pending = pending.then(async () => {
        for (const row of rows) {
          const fingerprint = createHash('sha256')
            .update(JSON.stringify(stable(row.value ?? null)))
            .digest('hex');
          const key = `${row.fleetId}:${row.subject}:${row.source}`;
          if (fingerprints.get(key) === fingerprint) continue;
          fingerprints.set(key, fingerprint);
          events.push({
            observedAt: new Date(now()).toISOString(),
            kind: 'change',
            fleetId: row.fleetId,
            subject: row.subject,
            source: row.source,
            fingerprint,
            executionIdentity: 'unknown',
          });
        }
        await persist();
      });
      return pending;
    },
  };
}
