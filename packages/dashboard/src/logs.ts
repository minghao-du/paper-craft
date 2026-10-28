/** Bounded on-demand log reads from registered task sources. */
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { loadFleetConfig, workflowSource, within } from '@paper-craft/core/workflow/fleet-config';
import { observeRuntime, type RuntimeExecutor } from './runtime.js';
import type { DashboardTask } from '@paper-craft/core/workflow/dashboard';

/** Strip secret-bearing lines and private prompt blocks before disclosure. */
function sanitize(text: string): string {
  return text
    .replace(/<(?:prompt|system|user_prompt)>[\s\S]*$/gi, '[private prompt omitted]')
    .replace(
      /^.*(?:authorization|bearer\s|password|passwd|api[_-]?key|access[_-]?token|secret|private[_ -]?key|(?:system|user|initial)[_ -]?prompt).*$/gim,
      '[sensitive line omitted]',
    )
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{10,})/g, '[credential omitted]');
}
/** Read only a fixed worklog or reverified terminal. Runner transcripts lack safe identity. */
export async function readTaskLog(
  configFile: string,
  task: DashboardTask,
  kind: string,
  offset: number,
  run: RuntimeExecutor,
) {
  const base = { kind, readAt: new Date().toISOString(), offset };
  try {
    const config = loadFleetConfig(configFile);
    const directory = workflowSource(config, task.path);
    if (kind === 'runner')
      return {
        ...base,
        state: 'unknown',
        error: 'No safely verified Runner log capability; private transcripts are not exposed',
      };
    if (kind === 'terminal') {
      const runtime = await observeRuntime(directory, run);
      const pane = runtime.tmux.panes.filter((p) => !p.dead);
      if (runtime.error || pane.length !== 1)
        return {
          ...base,
          state: 'unknown',
          error: 'Expected exactly one currently verified terminal pane',
        };
      const text = await run('tmux', [
        'capture-pane',
        '-p',
        '-t',
        pane[0].id,
        '-S',
        '-200',
        '-E',
        '-1',
      ]);
      // Recheck after capture as recovered panes may have changed directories or identity.
      const verified = await observeRuntime(directory, run);
      if (!verified.tmux.panes.some((p) => p.id === pane[0].id && p.pid === pane[0].pid))
        return { ...base, state: 'unknown', error: 'Terminal identity changed during read' };
      return {
        ...base,
        state: 'read',
        source: `tmux ${pane[0].id}`,
        text: sanitize(text.slice(0, 16384)),
        nextOffset: null,
        detail: 'Latest bounded terminal segment; private prompt/credential lines omitted',
      };
    }
    const source = join(directory, '.epic-worklog.md');
    const physical = await realpath(source);
    if (!within(directory, physical)) throw new Error('Worklog escapes registered source');
    const file = await open(
      physical,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error('Expected regular worklog file');
      const buffer = Buffer.alloc(16384);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (offset > 0) text = text.slice(text.indexOf('\n') + 1);
      if (offset + bytesRead < metadata.size)
        text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
      return {
        ...base,
        state: 'read',
        source,
        text: sanitize(text),
        nextOffset: offset + bytesRead < metadata.size ? offset + bytesRead : null,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return {
      ...base,
      state: missing ? 'absent' : 'error',
      error: missing
        ? 'Worklog not present'
        : 'Cannot read validated log source; check registration and file permissions',
    };
  }
}
