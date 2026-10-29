/** Bounded runtime observations. Presence never authorizes scheduling or reclaim. */
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { realpath, open } from 'node:fs/promises';
import { join } from 'node:path';
import { within } from '@paper-craft/core/workflow/fleet-config';

/** External executable boundary, shared by all browser clients. */
export type RuntimeExecutor = (program: string, args: string[]) => Promise<string>;
/** Execute only fixed read commands, with bounded output and no interactive stdin. */
export const executeRuntime: RuntimeExecutor = (program, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              `${program} unavailable or timed out; check installed capability in a terminal`,
            ),
          );
        else resolve(stdout);
      },
    );
    child.stdin?.end();
  });
/** Independently attributed evidence, not a stable execution identity. */
export interface RuntimeEvidence {
  source: string;
  observedAt: string;
  lastSuccessAt?: string;
  stale: boolean;
  occupancy: 'unknown';
  tmux: {
    state: 'observed' | 'unknown';
    panes: { id: string; pid: number; dead: boolean; command: string }[];
  };
  runner: { state: 'unknown' | 'recorded'; sessionId?: string; source?: string; detail: string };
  processes: { pid: number; command: string; source: string }[];
  error?: string;
  uncertainty: string;
}

/** Read a bounded existing Ralph header without reading or returning its private prompt. */
async function runnerRecord(path: string): Promise<RuntimeEvidence['runner']> {
  const unknown: RuntimeEvidence['runner'] = {
    state: 'unknown',
    detail: 'No verified live Runner session capability',
  };
  const source = join(path, '.claude', 'ralph-loop.local.md');
  try {
    const physical = await realpath(source);
    if (!within(path, physical))
      return { ...unknown, detail: 'Runner record escapes registered directory' };
    const file = await open(
      physical,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      if (!(await file.stat()).isFile()) return unknown;
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const header = buffer
        .subarray(0, bytesRead)
        .toString('utf8')
        .match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const sessionId = header?.[1].match(
        /^session_id:\s*["']?([a-zA-Z0-9_-]{1,128})["']?\s*$/m,
      )?.[1];
      return sessionId
        ? {
            state: 'recorded',
            sessionId,
            source,
            detail: 'Recorded identity only; may be stale or recovered. Liveness unverified.',
          }
        : unknown;
    } finally {
      await file.close();
    }
  } catch {
    return unknown;
  }
}

/** Observe only panes with a verified exact physical working directory. */
export async function observeRuntime(path: string, run: RuntimeExecutor): Promise<RuntimeEvidence> {
  const observedAt = new Date().toISOString();
  const result: RuntimeEvidence = {
    source: 'tmux list-panes / ps comm',
    observedAt,
    stale: false,
    occupancy: 'unknown',
    tmux: { state: 'unknown', panes: [] },
    runner: { state: 'unknown', detail: 'No verified Runner capability' },
    processes: [],
    uncertainty:
      'A terminal, shell or process is not proof of a live agent. Missing panes do not prove exit, completion or availability.',
  };
  try {
    const physical = await realpath(path);
    result.runner = await runnerRecord(physical);
    const output = await run('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}\t#{pane_current_path}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}',
    ]);
    for (const row of output.trim().split('\n')) {
      const [id, cwd, pidText, dead, command] = row.split('\t');
      if (!/^%\d+$/.test(id) || !/^\d+$/.test(pidText) || !cwd) continue;
      let actual;
      try {
        actual = await realpath(cwd);
      } catch {
        continue;
      }
      if (actual !== physical) continue;
      const pid = Number(pidText);
      result.tmux.panes.push({
        id,
        pid,
        dead: dead === '1',
        command: (command ?? '').slice(0, 128),
      });
      if (dead !== '1') {
        try {
          const comm = (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim();
          result.processes.push({
            pid,
            command: comm.slice(0, 256),
            source: 'Recorded tmux pane PID; ps comm (no arguments)',
          });
        } catch {
          result.error = 'Pane process observation unavailable; terminal evidence retained';
        }
      }
    }
    result.tmux.state = 'observed';
    if (!result.error) result.lastSuccessAt = observedAt;
  } catch {
    result.error =
      'Runtime observation unavailable; check tmux installation/server and permissions in a terminal';
  }
  return result;
}
