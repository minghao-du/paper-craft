/** Managed role startup and durable runner evidence, independent of the model host. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stateDirectory } from './handoff.js';
import type { FleetConfig } from './fleet-config.js';

/** One execution attempt; unknown retains occupancy until independently verified. */
export interface ManagedAttempt {
  id: string;
  fleet: string;
  role: 'conductor' | 'worker' | 'epic' | 'landing';
  runner: string;
  brief: string;
  status: 'starting' | 'running' | 'unknown';
  created: string;
  directory: string;
  checkout: string;
  conversation?: string;
  address?: string;
  evidence?: string;
  error?: string;
}
/** Adapter owns capability checks and evidence; a terminal alone is insufficient. */
export interface RunnerAdapter {
  name: string;
  /** Recover normalized startup evidence from this Runner only. */
  recoverReceipt?(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string } | undefined>;
  cancellation?: boolean;
  cancel?(attempt: ManagedAttempt): Promise<{ evidence: string }>;
  preflight(): Promise<void>;
  start(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string }>;
}
function home(config: FleetConfig): string {
  return stateDirectory(config, '.runtime', createHash('sha256').update(config.file).digest('hex'));
}
function save(path: string, attempt: ManagedAttempt): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(attempt, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}
/** Read durable occupancy, without treating missing runtime evidence as release. */
export function inspectConductor(config: FleetConfig): ManagedAttempt | undefined {
  const path = join(home(config), 'conductor.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ManagedAttempt) : undefined;
}
/** Exclusively claim the Fleet conductor, preserving failed/unknown launches for recovery. */
export async function startConductor(
  config: FleetConfig,
  runner: RunnerAdapter,
  brief: string,
): Promise<ManagedAttempt> {
  if (!brief.trim()) throw new Error('Expected a non-empty Conductor brief');
  await runner.preflight();
  mkdirSync(home(config), { recursive: true });
  try {
    mkdirSync(join(home(config), 'conductor.lock'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Conductor occupied; inspect persisted attempt before recovery', {
        cause: error,
      });
    throw error;
  }
  const id = randomUUID();
  const directory = join(home(config), id);
  mkdirSync(directory);
  const attempt: ManagedAttempt = {
    id,
    fleet: createHash('sha256').update(config.file).digest('hex'),
    role: 'conductor',
    runner: runner.name,
    brief,
    status: 'starting',
    created: new Date().toISOString(),
    directory,
    checkout: config.project,
  };
  const path = join(home(config), 'conductor.json');
  save(path, attempt);
  writeFileSync(join(directory, 'brief.md'), brief, { mode: 0o600 });
  try {
    const receipt = await runner.start(attempt);
    if (!receipt.conversation || !receipt.address || !receipt.evidence)
      throw new Error('Expected Runner conversation, runtime address and startup evidence');
    Object.assign(attempt, receipt, { status: 'running' });
  } catch (error) {
    attempt.status = 'unknown';
    attempt.error = error instanceof Error ? error.message : String(error);
  }
  save(path, attempt);
  save(join(directory, 'attempt.json'), attempt);
  return attempt;
}
function shell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
/** Codex JSONL is the receipt/result channel; resume supplies subsequent input.
 * The workflow driver polls the durable log to wake and dispatch the next turn.
 */
export class CodexRunner implements RunnerAdapter {
  readonly name = 'codex';
  readonly cancellation = false;
  /** Verified process exit releases execution capacity, never checkout ownership. */
  async termination(attempt: ManagedAttempt): Promise<boolean> {
    const file = join(attempt.directory, 'exit-code');
    return existsSync(file) && /^-?\d+$/.test(readFileSync(file, 'utf8').trim());
  }
  /** Probe installed CLI capabilities instead of inferring support from its name. */
  async preflight(): Promise<void> {
    execFileSync('tmux', ['-V'], { timeout: 5000 });
    const help = execFileSync('codex', ['exec', '--help'], { encoding: 'utf8', timeout: 5000 });
    const resume = execFileSync('codex', ['exec', 'resume', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (
      !help.includes('--json') ||
      !help.includes('--output-last-message') ||
      !resume.includes('--json')
    )
      throw new Error(
        'Codex must support JSON event/result output and resume input for automatic round trips',
      );
  }
  /** Exit receipt plus absent runtime session verifies this managed process stopped. */
  async stopped(attempt: ManagedAttempt): Promise<boolean> {
    if (!existsSync(join(attempt.directory, 'exit-code')) || !attempt.address?.startsWith('tmux:'))
      return false;
    try {
      execFileSync('tmux', ['has-session', '-t', attempt.address.slice(5)], { stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  }
  /** Collect a completed turn from durable Runner output, never from pane disappearance. */
  /** Recovery never blocks on an execution whose exit is not yet observed. */
  /** Read this adapter's durable startup protocol after a lost notification. */
  async recoverReceipt(attempt: ManagedAttempt) {
    const events = join(attempt.directory, 'events.jsonl');
    if (!existsSync(events)) return undefined;
    const lines = readFileSync(events, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const thread = lines.find((e) => e.type === 'thread.started' && e.thread_id);
    if (!thread || !lines.some((e) => e.type === 'turn.started')) return undefined;
    return {
      conversation: thread.thread_id as string,
      address: attempt.address ?? `tmux:pc-${attempt.fleet.slice(0, 12)}-${attempt.id}`,
      evidence: 'Recovered thread.started and turn.started from durable Runner events',
    };
  }
  collectable(attempt: ManagedAttempt): boolean {
    return existsSync(join(attempt.directory, 'exit-code'));
  }
  async collect(attempt: ManagedAttempt): Promise<string> {
    const exit = join(attempt.directory, 'exit-code');
    while (!existsSync(exit)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (readFileSync(exit, 'utf8').trim() !== '0')
      throw new Error(`Runner failed; inspect ${attempt.directory}`);
    const events = readFileSync(join(attempt.directory, 'events.jsonl'), 'utf8');
    if (
      !events.split('\n').some((line) => {
        try {
          return JSON.parse(line).type === 'turn.completed';
        } catch {
          return false;
        }
      })
    )
      throw new Error('Expected completed turn evidence');
    return readFileSync(join(attempt.directory, 'result.md'), 'utf8');
  }
  /** Start in tmux and wait for the Runner-generated conversation acknowledgement. */
  async start(
    attempt: ManagedAttempt,
  ): Promise<{ conversation: string; address: string; evidence: string }> {
    const session = `pc-${attempt.fleet.slice(0, 12)}-${attempt.id}`;
    const events = join(attempt.directory, 'events.jsonl');
    const result = join(attempt.directory, 'result.md');
    const script = join(attempt.directory, 'launch.sh');
    writeFileSync(
      script,
      `#!/bin/sh\ncodex exec ${attempt.conversation ? `resume ${shell(attempt.conversation)} ` : ''}-c sandbox_mode='"workspace-write"' -c approval_policy='"never"' --json --output-last-message ${shell(result)} - < ${shell(join(attempt.directory, 'brief.md'))} > ${shell(events)} 2> ${shell(join(attempt.directory, 'stderr.log'))}\nprintf '%s' "$?" > ${shell(join(attempt.directory, 'exit-code'))}\n`,
      { mode: 0o700 },
    );
    execFileSync(
      'tmux',
      ['new-session', '-d', '-s', session, '-c', attempt.checkout, 'sh', script],
      { timeout: 5000 },
    );
    const deadline = Date.now() + 15000;
    let conversation: string | undefined;
    let receipt: string | undefined;
    while (Date.now() < deadline) {
      if (existsSync(events)) {
        for (const line of readFileSync(events, 'utf8').split('\n')) {
          try {
            const event = JSON.parse(line) as { type: string; thread_id?: string };
            if (event.type === 'thread.started' && event.thread_id) {
              conversation = event.thread_id;
              receipt = line;
            }
            if (event.type === 'turn.started' && conversation && receipt)
              return { conversation, address: `tmux:${session}`, evidence: receipt + '\n' + line };
          } catch {
            /* Incomplete final JSONL line is retried. */
          }
        }
      }
      if (existsSync(join(attempt.directory, 'exit-code')))
        throw new Error(`Runner exited without acknowledgement; inspect ${attempt.directory}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `No Runner acknowledgement within 15s; preserve occupancy and inspect ${attempt.directory}`,
    );
  }
}

/** Control observations do not overwrite the persisted execution identity or ownership. */
export interface AttemptControl {
  execution?: { status: 'running' | 'unknown' | 'terminated'; evidence?: string };
  wait?: { timedOut: boolean; at: string };
  cancellation?: {
    requested: string;
    outcome: 'unsupported' | 'failed' | 'confirmed';
    evidence?: string;
    error?: string;
  };
}
/** Read durable wait/cancellation observations, independently of execution status. */
export function inspectAttemptControl(attempt: ManagedAttempt): AttemptControl {
  const file = join(attempt.directory, 'control.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}
/** A bounded wait leaves the original collection running and permits later collection. */
export async function waitAttempt(
  attempt: ManagedAttempt,
  runner: { collect(attempt: ManagedAttempt): Promise<string> },
  timeoutMs: number,
): Promise<{ timedOut: boolean; result?: string }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Expected nonnegative timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runner.collect(attempt).then((result) => ({ timedOut: false, result })),
      new Promise<{ timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    const control = inspectAttemptControl(attempt);
    control.wait = { timedOut: result.timedOut, at: new Date().toISOString() };
    writeFileSync(join(attempt.directory, 'control.json'), JSON.stringify(control));
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** Cancellation is unsupported unless the adapter explicitly supplies a terminal receipt. */
export async function cancelAttempt(
  attempt: ManagedAttempt,
  runner: {
    cancellation?: boolean;
    cancel?(attempt: ManagedAttempt): Promise<{ evidence: string }>;
  },
): Promise<AttemptControl> {
  const control = inspectAttemptControl(attempt);
  control.cancellation = { requested: new Date().toISOString(), outcome: 'failed' };
  const file = join(attempt.directory, 'control.json');
  writeFileSync(file, JSON.stringify(control));
  try {
    if (!runner.cancellation || !runner.cancel) control.cancellation.outcome = 'unsupported';
    else {
      const receipt = await runner.cancel(attempt);
      if (!receipt.evidence) throw new Error('Expected verified termination receipt');
      Object.assign(control.cancellation, { outcome: 'confirmed', evidence: receipt.evidence });
      control.execution = { status: 'terminated', evidence: receipt.evidence };
    }
  } catch (error) {
    control.cancellation.error = String(error);
  }
  writeFileSync(file, JSON.stringify(control));
  return control;
}

/** Reconcile execution without changing logical role or checkout ownership. */
export async function reconcileAttempt(
  attempt: ManagedAttempt,
  runner: { termination?(attempt: ManagedAttempt): Promise<boolean> },
): Promise<AttemptControl> {
  const control = inspectAttemptControl(attempt);
  if (control.execution?.status === 'terminated') return control;
  const terminated = runner.termination ? await runner.termination(attempt) : false;
  control.execution = terminated
    ? { status: 'terminated', evidence: 'Adapter verified execution exit' }
    : { status: 'unknown' };
  writeFileSync(join(attempt.directory, 'control.json'), JSON.stringify(control));
  return control;
}
