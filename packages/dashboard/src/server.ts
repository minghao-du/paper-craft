import { loadFleetConfig, workflowSource } from '@paper-craft/core/workflow/fleet-config';
/** Protected local HTTP adapter over shared file evidence. */
import {
  observeRuntime,
  executeRuntime,
  type RuntimeExecutor,
  type RuntimeEvidence,
} from './runtime.js';
import { Hono } from 'hono';
import { Worker } from 'node:worker_threads';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FleetRegistration, type DashboardFleet } from '@paper-craft/core/workflow/dashboard';

/** Local setup and collection options; no workflow writers are exposed. */
export interface DashboardOptions {
  dataDir: string;
  configs?: string[];
  token?: string;
  host?: string;
  intervalMs?: number;
  runtimeIntervalMs?: number;
  executeRuntime?: RuntimeExecutor;
}
/** Assemble shared collection and authenticated HTTP reads. */
function collectFleet(registration: FleetRegistration): Promise<DashboardFleet> {
  return new Promise((resolve) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads'); import('@paper-craft/core/workflow/dashboard').then(m => m.readDashboardFleet(workerData)).then(value => parentPort.postMessage(value)).catch(error => { throw error; });`,
      { eval: true, workerData: registration },
    );
    const failed = (message: string): DashboardFleet => ({
      ...registration,
      observedAt: new Date().toISOString(),
      tasks: [],
      stale: false,
      error: message,
    });
    const finish = (value: DashboardFleet) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(failed('Local collection exceeded 5 second timeout')),
      5000,
    );
    worker.once('message', finish);
    worker.once('error', (error) =>
      finish(failed(error instanceof Error ? error.message : 'Collection failed')),
    );
    worker.once('exit', (code) => {
      if (code !== 0) finish(failed('Local collection worker exited'));
    });
  });
}

/** Assemble cached collection and the authenticated read-only HTTP interface. */
export async function createDashboard(options: DashboardOptions) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const host = options.host ?? '127.0.0.1:4317';
  const interval = Math.max(100, options.intervalMs ?? 15000);
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const registry = join(options.dataDir, 'fleets.jsonl');
  let registrations: FleetRegistration[] = [];
  try {
    registrations = (await readFile(registry, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FleetRegistration);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw new Error('Cannot read Dashboard registrations', { cause: error });
  }
  for (const config of options.configs ?? [])
    if (!registrations.some((r) => r.config === config))
      registrations.push({
        id: createHash('sha256').update(config).digest('hex').slice(0, 16),
        config,
      });
  await writeFile(registry, registrations.map((r) => JSON.stringify(r)).join('\n') + '\n', {
    mode: 0o600,
  });
  let fleets: DashboardFleet[] = [];
  let snapshot = { version: 0, generatedAt: new Date().toISOString(), fleets };
  let collecting: Promise<void> | undefined;
  let next = 0;
  const failures = new Map<string, number>();
  const due = new Map<string, number>();
  const refresh = async (force = false): Promise<void> => {
    if (collecting) return collecting;
    if (!force && Date.now() < next) return;
    collecting = (async () => {
      const results = await Promise.all(
        registrations.map(async (registration) => {
          const previousDue = due.get(registration.id) ?? 0;
          const cached = fleets.find((f) => f.id === registration.id);
          if (!force && cached && Date.now() < previousDue) return cached;
          const fresh = await collectFleet(registration);
          const count = fresh.error ? Math.min((failures.get(registration.id) ?? 0) + 1, 5) : 0;
          failures.set(registration.id, count);
          due.set(registration.id, Date.now() + interval * 2 ** count);
          const previous = fleets.find((f) => f.id === fresh.id);
          if (fresh.error && previous) return { ...previous, error: fresh.error, stale: true };
          fresh.tasks = fresh.tasks.map((task) => {
            const old = previous?.tasks.find((t) => t.id === task.id);
            return task.error && old && !old.error
              ? { ...old, error: task.error, stale: true }
              : task.error && old?.stale
                ? { ...old, error: task.error, stale: true }
                : task;
          });
          return fresh;
        }),
      );
      fleets = results;
      snapshot = { version: snapshot.version + 1, generatedAt: new Date().toISOString(), fleets };
      next = Math.min(...due.values(), Date.now() + interval);
    })().finally(() => {
      collecting = undefined;
    });
    return collecting;
  };
  const runtimeCache = new Map<string, RuntimeEvidence>();
  let runtimeCollecting: Promise<void> | undefined;
  let runtimeNext = 0;
  const runtimeFailures = new Map<string, number>();
  const runtimeDue = new Map<string, number>();
  const runtimeInterval = Math.max(100, options.runtimeIntervalMs ?? 15000);
  const refreshRuntime = async (force = false): Promise<void> => {
    if (runtimeCollecting) return runtimeCollecting;
    if (!force && Date.now() < runtimeNext) return;
    runtimeCollecting = (async () => {
      for (const task of fleets.flatMap((f) => f.tasks)) {
        if (!force && Date.now() < (runtimeDue.get(task.id) ?? 0)) continue;
        const fleet = fleets.find((f) => f.tasks.some((t) => t.id === task.id));
        try {
          workflowSource(loadFleetConfig(fleet!.config), task.path);
        } catch {
          runtimeCache.delete(task.id);
          continue;
        }
        const observed = await observeRuntime(task.path, options.executeRuntime ?? executeRuntime);
        const failures = observed.error ? Math.min(5, (runtimeFailures.get(task.id) ?? 0) + 1) : 0;
        runtimeFailures.set(task.id, failures);
        runtimeDue.set(task.id, Date.now() + runtimeInterval * 2 ** failures);
        const old = runtimeCache.get(task.id);
        runtimeCache.set(
          task.id,
          observed.error && old?.lastSuccessAt
            ? { ...old, stale: true, error: observed.error, observedAt: observed.observedAt }
            : observed,
        );
      }
      runtimeNext = Math.min(...runtimeDue.values(), Date.now() + runtimeInterval);
      snapshot = {
        ...snapshot,
        version: snapshot.version + 1,
        generatedAt: new Date().toISOString(),
      };
    })().finally(() => {
      runtimeCollecting = undefined;
    });
    return runtimeCollecting;
  };
  const runtimeSnapshot = () => ({
    ...snapshot,
    fleets: fleets.map((f) => ({
      ...f,
      tasks: f.tasks.map((t) => ({ ...t, runtimeEvidence: runtimeCache.get(t.id) })),
    })),
  });
  await refresh();
  await refreshRuntime();
  const runtimeTimer = setInterval(
    () => {
      void refreshRuntime().catch(() => {
        runtimeNext = Date.now() + runtimeInterval;
      });
    },
    Math.min(runtimeInterval, 1000),
  );
  runtimeTimer.unref();
  const timer = setInterval(
    () => {
      void refresh().catch(() => {
        next = Date.now() + interval;
      });
    },
    Math.min(interval, 1000),
  );
  timer.unref();
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (c.req.header('host') !== host) return c.json({ error: 'Disallowed Host' }, 403);
    const origin = c.req.header('origin');
    if (origin && origin !== `http://${host}`) return c.json({ error: 'Disallowed Origin' }, 403);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.path.startsWith('/api/')) {
      const supplied = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
      if (
        Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return c.json({ error: 'Access token required' }, 401);
      if (c.req.method !== 'GET') return c.json({ error: 'Read-only service' }, 405);
    }
    await next();
  });
  app.get('/api/snapshot', (c) => c.json(runtimeSnapshot()));
  app.get('/api/health', (c) =>
    c.json({
      generatedAt: snapshot.generatedAt,
      collecting: !!collecting,
      nextObservationAt: new Date(next).toISOString(),
    }),
  );
  app.get('/api/refresh', async (c) => {
    await Promise.all([refresh(), refreshRuntime()]);
    return c.json(runtimeSnapshot());
  });
  app.get('/api/tasks/:id', (c) => {
    const task = fleets.flatMap((f) => f.tasks).find((t) => t.id === c.req.param('id'));
    return task
      ? c.json({ ...task, runtimeEvidence: runtimeCache.get(task.id) })
      : c.json({ error: 'Unknown task' }, 404);
  });
  app.get('*', async (c) => {
    const name = c.req.path === '/' ? 'index.html' : c.req.path.slice(1);
    if (!/^(index\.html|assets\/[A-Za-z0-9_.-]+\.(js|css))$/.test(name)) return c.notFound();
    try {
      const body = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../web', name));
      c.header(
        'Content-Type',
        name.endsWith('.js')
          ? 'application/javascript'
          : name.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      );
      return c.body(body);
    } catch {
      return c.text('Build Dashboard assets with pnpm run build', 503);
    }
  });
  return {
    app,
    token,
    refresh,
    refreshRuntime,
    stop: () => {
      clearInterval(timer);
      clearInterval(runtimeTimer);
    },
  };
}
