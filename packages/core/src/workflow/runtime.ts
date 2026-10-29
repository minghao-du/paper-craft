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
  /** Collect a completed turn from durable Runner output, never from pane disappearance. */
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
      `#!/bin/sh\ncodex exec ${attempt.conversation ? `resume ${shell(attempt.conversation)} ` : ''}--full-auto --json --output-last-message ${shell(result)} - < ${shell(join(attempt.directory, 'brief.md'))} > ${shell(events)} 2> ${shell(join(attempt.directory, 'stderr.log'))}\nprintf '%s' "$?" > ${shell(join(attempt.directory, 'exit-code'))}\n`,
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
