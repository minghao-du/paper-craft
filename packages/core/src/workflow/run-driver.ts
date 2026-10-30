/** Run intake and authoritative Fleet relationships; legacy Conductor records remain readable. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from './handoff.js';
import type { FleetConfig } from './fleet-config.js';
import {
  inspectConductor,
  startConductor,
  type ManagedAttempt,
  type RunnerAdapter,
} from './runtime.js';
import type { IssueInput } from './issue-driver.js';

/** Verified tracker subject, with explicit scope rather than title heuristics. */
export interface RunSubject extends IssueInput {
  kind: 'issue' | 'epic';
}
/** One requested workflow with a fixed provider and dedicated execution identity. */
export interface WorkflowRun {
  id: string;
  subject: RunSubject;
  provider: string;
  policy: { name: string; revision: number };
  lifecycle: 'reserved' | 'running' | 'blocked' | 'completed';
  orchestratorId: string;
  orchestrator?: ManagedAttempt;
  brief: { path: string; hash: string };
}
/** Atomic Fleet relationship snapshot. */
export interface RunRegistry {
  revision: number;
  runs: WorkflowRun[];
}
function home(config: FleetConfig): string {
  return stateDirectory(config, '.runtime', createHash('sha256').update(config.file).digest('hex'));
}
/** Read only; absent legacy Run identities are never fabricated. */
export function inspectRuns(config: FleetConfig): RunRegistry {
  const file = join(home(config), 'registry.json');
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as RunRegistry)
    : { revision: 0, runs: [] };
}
function save(config: FleetConfig, registry: RunRegistry): void {
  const file = join(home(config), 'registry.json');
  const temp = file + '.' + randomUUID();
  registry.revision++;
  writeFileSync(temp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
/** Reserve before managed launch; initial bounded path preserves Fleet-wide exclusion. */
export async function startRun(
  config: FleetConfig,
  runner: RunnerAdapter,
  subject: RunSubject,
  provider: string,
): Promise<WorkflowRun> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(subject.repository) ||
    !Number.isSafeInteger(subject.number) ||
    subject.number < 1
  )
    throw new Error(
      'Resolve an accessible repository owner/name and positive Issue number before launch',
    );
  if (provider !== 'codex' || runner.name !== provider)
    throw new Error('Initial Run intake requires the codex managed provider');
  await runner.preflight();
  mkdirSync(home(config), { recursive: true });
  const lock = join(home(config), 'registry.lock');
  try {
    mkdirSync(lock);
  } catch {
    throw new Error('Registry occupied; inspect before retry');
  }
  try {
    const registry = inspectRuns(config);
    const existing = registry.runs.find(
      (r) =>
        r.subject.repository === subject.repository &&
        r.subject.number === subject.number &&
        r.lifecycle !== 'completed',
    );
    if (existing) {
      if (existing.provider !== provider || existing.subject.kind !== subject.kind)
        throw new Error('Existing Run provider or scope conflict');
      return existing;
    }
    if (registry.runs.some((r) => r.lifecycle !== 'completed') || inspectConductor(config))
      throw new Error('Fleet occupied; inspect existing Run or legacy Conductor before intake');
    const id = randomUUID();
    const directory = join(home(config), 'runs', id);
    mkdirSync(directory, { recursive: true });
    const brief = `Manage only ${subject.kind} ${subject.repository}#${subject.number}. Run ${id}. Provider ${provider}.\n${subject.parent ? `Parent context #${subject.parent}; no sibling or parent closure authorization.\n` : ''}${subject.title}\n${subject.body}`;
    const path = join(directory, 'brief.md');
    writeFileSync(path, brief, { mode: 0o400, flag: 'wx' });
    const run: WorkflowRun = {
      id,
      subject,
      provider,
      policy: { name: 'managed-run', revision: 1 },
      lifecycle: 'reserved',
      orchestratorId: id,
      brief: { path, hash: createHash('sha256').update(brief).digest('hex') },
    };
    registry.runs.push(run);
    save(config, registry);
    // The durable reservation survives a crash or failed launch and blocks replacement.
    try {
      run.orchestrator = await startConductor(config, runner, brief, id);
      run.lifecycle = run.orchestrator.status === 'running' ? 'running' : 'blocked';
    } catch (error) {
      run.lifecycle = 'blocked';
      save(config, registry);
      throw error;
    }
    save(config, registry);
    return run;
  } finally {
    rmSync(lock, { recursive: true });
  }
}
