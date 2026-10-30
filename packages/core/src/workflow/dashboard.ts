import { inspectRuns, type WorkflowRun, type RunRegistry } from './run-driver.js';
/** File-backed evidence shared by Dashboard and JSON CLI; never scheduling authority. */
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFleetConfig, workflowSource, within } from './fleet-config.js';

/** Registered monitoring source; project is an optional research association. */
export interface FleetRegistration {
  id: string;
  config: string;
  project?: string;
}
/** Attributed task evidence; runtime and execution attempts remain unknown. */
export interface DashboardTask {
  id: string;
  slot: string;
  path: string;
  role: string;
  source: string;
  phase: string;
  summary: string;
  blockers: string[];
  waiting?: 'planned' | 'overdue' | 'unknown';
  modifiedAt?: string;
  interventions?: { reason: string; source: string }[];
  issue?: number;
  pr?: string;
  runtime: 'unknown';
  /** Verified registry ownership, absent on legacy file-only tasks. */
  runId?: string;
  orchestratorId?: string;
  executionIdentity: 'unknown';
  observedAt: string;
  stale: boolean;
  error?: string;
}
/** One registered Fleet, including failures instead of disappearing registrations. */
export interface DashboardFleet {
  id: string;
  config: string;
  project?: string;
  observedAt: string;
  tasks: DashboardTask[];
  /** Run ownership is projected without mutating runtime state. */
  runs?: WorkflowRun[];
  /** Distinct reported, acknowledged and accepted milestones; no control authority. */
  execution?: Omit<RunRegistry, 'runs'>;
  error?: string;
  stale: boolean;
}
/** Read only bounded, physically contained JSON evidence. */
export async function readDashboardFleet(registration: FleetRegistration): Promise<DashboardFleet> {
  const observedAt = new Date().toISOString();
  const fleet: DashboardFleet = { ...registration, observedAt, tasks: [], stale: false };
  try {
    const config = loadFleetConfig(registration.config);
    const { runs, ...execution } = inspectRuns(config);
    fleet.runs = runs;
    fleet.execution = execution;
    for (const run of fleet.runs) {
      fleet.tasks.push({
        id: `${registration.id}:run:${run.id}`,
        slot: `run-${run.id}`,
        path: config.project,
        role: 'Orchestrator',
        source: run.brief.path,
        phase: run.lifecycle,
        summary: `${run.subject.repository}#${run.subject.number} (${run.provider})${run.subject.parent ? `; child of #${run.subject.parent}` : ''}`,
        issue: run.subject.number,
        blockers: [
          ...(run.subject.blockedBy ?? []).map((n) => `Dependency #${n} remains open`),
          ...(run.orchestrator?.error ? [run.orchestrator.error] : []),
          ...(run.reconciliation?.blockers ?? []),
        ],
        runId: run.id,
        orchestratorId: run.orchestratorId,
        runtime: 'unknown',
        executionIdentity: 'unknown',
        observedAt,
        stale: false,
      });
    }
    const names = config.worktrees
      ? (await readdir(config.root)).filter((n) => /^issue-\d+$/.test(n))
      : config.slots;
    const locations = [
      { slot: 'conductor', path: config.project },
      ...names.map((slot) => ({ slot, path: join(config.root, slot) })),
    ];
    for (const location of locations) {
      const task: DashboardTask = {
        ...location,
        id: `${registration.id}:${location.slot}`,
        role: location.slot === 'conductor' ? 'Conductor / configured EPIC' : 'Worker',
        source: join(location.path, '.epic-status.json'),
        phase: 'unknown',
        summary: '',
        blockers: [],
        runtime: 'unknown',
        executionIdentity: 'unknown',
        observedAt,
        stale: false,
      };
      try {
        workflowSource(config, location.path);
        const physical = await realpath(task.source);
        if (!within(location.path, physical))
          throw new Error('Status source escapes registered directory');
        if ((await stat(physical)).size > 256 * 1024)
          throw new Error('Status exceeds 256 KiB limit');
        const value: unknown = JSON.parse(await readFile(physical, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Expected status object');
        const record = value as Record<string, unknown>;
        task.phase = typeof record.phase === 'string' ? record.phase : 'unknown';
        task.summary = typeof record.summary === 'string' ? record.summary : '';
        task.blockers = Array.isArray(record.blockers)
          ? record.blockers.filter((v): v is string => typeof v === 'string')
          : [];
        task.interventions = task.blockers.map((reason) => ({ reason, source: task.source }));
        if (['needs-human', 'blocked'].includes(task.phase) && !task.blockers.length)
          task.interventions.push({
            reason: 'Recorded phase requests human intervention',
            source: task.source,
          });
        for (const field of ['stop_reason', 'lead_guidance']) {
          if (typeof record[field] === 'string' && record[field])
            task.interventions.push({ reason: record[field], source: `${task.source}#${field}` });
        }
        const awaiting =
          record.awaiting && typeof record.awaiting === 'object'
            ? (record.awaiting as Record<string, unknown>)
            : undefined;
        const appointment =
          typeof awaiting?.next_check_at === 'string' ? Date.parse(awaiting.next_check_at) : NaN;
        const statusTime = (await stat(physical)).mtimeMs;
        let worklogTime = 0;
        try {
          const worklog = await realpath(join(location.path, '.epic-worklog.md'));
          if (within(location.path, worklog)) worklogTime = (await stat(worklog)).mtimeMs;
        } catch {
          /* Missing worklog does not invalidate status evidence. */
        }
        task.modifiedAt = new Date(Math.max(statusTime, worklogTime)).toISOString();
        if (task.phase === 'awaiting-results') {
          task.waiting = Number.isFinite(appointment)
            ? appointment > Date.now()
              ? 'planned'
              : 'overdue'
            : 'unknown';
          if (task.waiting === 'overdue')
            task.interventions.push({
              reason: 'Saved next check is overdue; investigate',
              source: task.source,
            });
        }
        // Without verified terminal evidence, old files alone cannot establish stalled work.
        if (typeof record.issue === 'number') task.issue = record.issue;
        if (typeof record.pr === 'string') task.pr = record.pr;
      } catch (error) {
        task.error = error instanceof Error ? error.message : 'Cannot read status';
      }
      fleet.tasks.push(task);
    }
  } catch (error) {
    fleet.error = error instanceof Error ? error.message : 'Cannot load Fleet configuration';
  }
  return fleet;
}
