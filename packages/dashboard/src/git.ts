/** Independently scheduled, read-only cached Git observations. */
import { Worker } from 'node:worker_threads';
import type { FleetRegistration } from '@paper-craft/core/workflow/dashboard';
import type { FleetReport } from '@paper-craft/core/workflow/fleet';

/** An observation is evidence, never permission to reclaim a slot. */
export interface GitEvidence {
  fleetId: string;
  source: string;
  observedAt: string;
  lastSuccessAt?: string;
  stale: boolean;
  value?: FleetReport;
  error?: string;
}
function probe(config: string): Promise<FleetReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const {parentPort,workerData}=require('node:worker_threads');
      Promise.all([import('@paper-craft/core/workflow/fleet-config'),import('@paper-craft/core/workflow/fleet')])
        .then(([c,f])=>parentPort.postMessage(f.checkFleet(c.loadFleetConfig(workerData),'collisions',false)));
    `,
      { eval: true, workerData: config },
    );
    let settled = false;
    const finish = (error?: Error, value?: FleetReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new Error('Git collection exceeded 10 second bound')),
      10000,
    );
    worker.once('message', (value: FleetReport) => finish(undefined, value));
    worker.once('error', (error: Error) => finish(error));
    worker.once('exit', () => finish(new Error('Git collector exited before returning evidence')));
  });
}
/** Start one shared collection cache; requests never launch Git processes. */
export function collectGit(registrations: FleetRegistration[], intervalMs = 60000) {
  const interval = Math.max(100, intervalMs);
  const values = new Map<string, GitEvidence>();
  const due = new Map<string, number>();
  const failures = new Map<string, number>();
  let active: Promise<void> | undefined;
  const refresh = (force = false): Promise<void> => {
    if (active) return active;
    active = Promise.all(
      registrations.map(async (registration) => {
        if (!force && Date.now() < (due.get(registration.id) ?? 0)) return;
        const old = values.get(registration.id);
        const observedAt = new Date().toISOString();
        try {
          const value = await probe(registration.config);
          if (value.unknown.length && !value.slots.length)
            throw new Error(value.unknown.map((f) => `${f.slot}: ${f.detail}`).join('; '));
          // Keep useful slot values when a sibling checkout becomes unreadable.
          if (old?.value && value.unknown.length) {
            for (const finding of value.unknown) {
              const previous = old.value.slots.find((slot) => slot.name === finding.slot);
              if (previous && !value.slots.some((slot) => slot.name === previous.name))
                value.slots.push(previous);
            }
          }
          values.set(registration.id, {
            fleetId: registration.id,
            source: registration.config,
            observedAt,
            lastSuccessAt: value.unknown.length ? old?.lastSuccessAt : observedAt,
            stale: value.unknown.length > 0,
            error: value.unknown.length
              ? value.unknown.map((f) => `${f.slot}: ${f.detail}`).join('; ')
              : undefined,
            value,
          });
          failures.set(
            registration.id,
            value.unknown.length ? Math.min((failures.get(registration.id) ?? 0) + 1, 5) : 0,
          );
        } catch (error) {
          values.set(registration.id, {
            ...old,
            fleetId: registration.id,
            source: registration.config,
            observedAt,
            stale: !!old?.value,
            error: error instanceof Error ? error.message : 'Git collection failed',
          });
          failures.set(registration.id, Math.min((failures.get(registration.id) ?? 0) + 1, 5));
        }
        due.set(registration.id, Date.now() + interval * 2 ** (failures.get(registration.id) ?? 0));
      }),
    )
      .then(() => {})
      .finally(() => {
        active = undefined;
      });
    return active;
  };
  const timer = setInterval(
    () => {
      void refresh();
    },
    Math.min(interval, 1000),
  );
  timer.unref();
  return { refresh, read: () => [...values.values()], stop: () => clearInterval(timer) };
}
