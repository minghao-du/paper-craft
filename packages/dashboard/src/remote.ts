/** Read-only Slurm observations for explicitly configured host/task associations. */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import type { FleetRegistration } from '@paper-craft/core/workflow/dashboard';
/** Remote state is evidence only, never local occupancy or execution identity. */
export interface RemoteEvidence {
  fleetId: string;
  slot: string;
  host: string;
  jobId: string;
  source: string;
  observedAt: string;
  lastSuccessAt?: string;
  state?: string;
  stale: boolean;
  error?: string;
}
function probe(host: string, job: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'ConnectionAttempts=1',
        '-o',
        'ServerAliveInterval=3',
        '-o',
        'ServerAliveCountMax=1',
        '--',
        host,
        'squeue',
        '--noheader',
        '--jobs',
        job,
        '--format=%i\\|%T',
      ],
      {
        timeout: 10000,
        maxBuffer: 16384,
        encoding: 'utf8',
        env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              'SSH observation failed or timed out; verify host authentication and scheduler access from a terminal.',
            ),
          );
          return;
        }
        const rows = stdout.trim().split('\n').filter(Boolean);
        const row = rows.find((r) => r.split('|')[0].trim() === job);
        if (!rows.length) {
          resolve('not present in squeue (completion unknown)');
          return;
        }
        if (!row || !/^\d+\|[A-Za-z_ +()-]+$/.test(row.trim())) {
          reject(new Error('Unsupported scheduler response; task state remains unknown'));
          return;
        }
        resolve(row.split('|')[1].trim());
      },
    );
  });
}
/** Shared bounded collection, with independent task backoff and no host discovery. */
export function collectRemote(registrations: FleetRegistration[], intervalMs = 300000) {
  const interval = Math.max(100, intervalMs);
  const values = new Map<string, RemoteEvidence>();
  const due = new Map<string, number>();
  const failures = new Map<string, number>();
  let active: Promise<void> | undefined;
  const refresh = (force = false): Promise<void> => {
    if (active) return force ? active.then(() => refresh(true)) : active;
    active = (async () => {
      const retained = new Set<string>();
      await Promise.all(
        registrations.map(async (registration) => {
          try {
            const config = loadFleetConfig(registration.config);
            if ((await stat(config.file)).size > 262144) throw new Error('Config exceeds 256 KiB');
            const raw = JSON.parse(await readFile(config.file, 'utf8')) as {
              remote_hosts?: unknown;
              remote_tasks?: unknown;
            };
            if (raw.remote_tasks === undefined) return;
            if (!Array.isArray(raw.remote_tasks) || raw.remote_tasks.length > 64)
              throw new Error('Expected at most 64 remote_tasks');
            await Promise.all(
              raw.remote_tasks.map(async (entry: unknown, index: number) => {
                const key = registration.id + ':' + index;
                retained.add(key);
                if (!force && Date.now() < (due.get(key) ?? 0)) return;
                const record =
                  entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
                const host = typeof record.host === 'string' ? record.host : '';
                const jobId = typeof record.job_id === 'string' ? record.job_id : '';
                const slot = typeof record.slot === 'string' ? record.slot : '';
                const old = values.get(key);
                const base = {
                  fleetId: registration.id,
                  slot,
                  host,
                  jobId,
                  source: config.file,
                  observedAt: new Date().toISOString(),
                  stale: false,
                };
                try {
                  if (
                    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(host) ||
                    !/^\d{1,18}$/.test(jobId) ||
                    !config.slots.includes(slot) ||
                    !Array.isArray(raw.remote_hosts) ||
                    !raw.remote_hosts.includes(host)
                  )
                    throw new Error(
                      'Unsupported association: require registered slot, allowlisted remote_hosts entry and numeric Slurm job_id',
                    );
                  const state = await probe(host, jobId);
                  values.set(key, { ...base, state, lastSuccessAt: base.observedAt });
                  failures.set(key, 0);
                } catch (error) {
                  const same = old?.host === host && old?.jobId === jobId && old?.slot === slot;
                  values.set(key, {
                    ...(same ? old : {}),
                    ...base,
                    stale: !!(same && old?.state),
                    error: error instanceof Error ? error.message : 'Remote collection failed',
                  });
                  failures.set(key, Math.min((failures.get(key) ?? 0) + 1, 5));
                }
                due.set(key, Date.now() + interval * 2 ** (failures.get(key) ?? 0));
              }),
            );
          } catch {
            for (const [oldKey, old] of values) {
              if (old.fleetId !== registration.id) continue;
              retained.add(oldKey);
              values.set(oldKey, {
                ...old,
                stale: true,
                error:
                  'Remote association configuration unavailable; retained previous observation',
              });
            }
            const key = registration.id + ':config';
            retained.add(key);
            values.set(key, {
              fleetId: registration.id,
              slot: 'unknown',
              host: 'unknown',
              jobId: 'unknown',
              source: registration.config,
              observedAt: new Date().toISOString(),
              stale: false,
              error: 'Cannot read remote associations; check authoritative configuration',
            });
          }
        }),
      );
      for (const key of values.keys()) if (!retained.has(key)) values.delete(key);
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
  const timer = setInterval(
    () => {
      void refresh().catch(() => {});
    },
    Math.min(interval, 1000),
  );
  timer.unref();
  return { refresh, read: () => [...values.values()], stop: () => clearInterval(timer) };
}
