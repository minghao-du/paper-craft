#!/usr/bin/env node
// Standalone TypeScript: Node >= 22.18, no workspace build or external packages.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

type Runner = 'codex' | 'agy';
type Process = { pid: number; ppid: number; start: string; command: string };
type Binding = { runner: Runner; id: string | null; pid: number; start: string };
type Pane = { target: string; pid: number; command: string; cwd: string };
type Saved = { version: 1; runner: Runner; id: string | null; cwd: string };

const script = fileURLToPath(import.meta.url);
const configDir = join(homedir(), '.config/pc/tmux-recovery');
const plugins = join(homedir(), '.tmux/plugins');
const option = '@pc-recovery';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const command = (...args: string[]) => args.map(quote).join(' ');
function fail(message: string): never {
  throw new Error(message);
}
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmux = (...args: string[]) => run('tmux', args);
const isRunner = (s: unknown): s is Runner => s === 'codex' || s === 'agy';
const validID = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(s);

function atomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

function processes(): Map<number, Process> {
  const result = new Map<number, Process>();
  for (const row of run('ps', ['-axo', 'pid=,ppid=,lstart=,comm=']).split('\n')) {
    const m = row.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    if (m)
      result.set(Number(m[1]), {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        start: m[3],
        command: m[4],
      });
  }
  return result;
}

function ancestors(pid: number, table: Map<number, Process>): number[] {
  const ids: number[] = [];
  while (table.has(pid) && !ids.includes(pid)) {
    ids.push(pid);
    pid = table.get(pid)!.ppid;
  }
  return ids;
}

function pane(target = process.env.TMUX_PANE): Pane {
  if (!target) fail('Run inside tmux or supply --pane <target>.');
  const fields = tmux(
    'display-message',
    '-p',
    '-t',
    target,
    '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}',
  ).split('\t');
  if (fields.length !== 4) fail('Unsupported tab in pane path or unavailable pane.');
  return { target: fields[0], pid: Number(fields[1]), command: fields[2], cwd: fields[3] };
}

function binding(p: Pane, table: Map<number, Process>): Binding | null {
  const text = tmux('show-option', '-pqv', '-t', p.target, option);
  if (!text) return null;
  const b = JSON.parse(text) as Binding;
  const owner = table.get(b.pid);
  return isRunner(b.runner) &&
    (b.id === null || validID(b.id)) &&
    owner?.start === b.start &&
    ancestors(b.pid, table).includes(p.pid)
    ? b
    : null;
}

function saveBinding(p: Pane, b: Binding) {
  tmux('set-option', '-p', '-t', p.target, option, JSON.stringify(b));
}

function resolveBinding(p: Pane, table: Map<number, Process>): Binding | null {
  const b = binding(p, table);
  if (b) return b;
  const candidates = [...table.values()].filter(
    (proc) => isRunner(basename(proc.command)) && ancestors(proc.pid, table).includes(p.pid),
  );
  if (candidates.length === 1) {
    const proc = candidates[0];
    return { runner: basename(proc.command) as Runner, id: null, pid: proc.pid, start: proc.start };
  }
  return isRunner(p.command) ? { runner: p.command, id: null, pid: 0, start: '' } : null;
}

function status() {
  const table = processes();
  const rows = tmux(
    'list-panes',
    '-a',
    '-F',
    '#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}',
  ).split('\n');
  console.log('pane\trunner\tconversation\tstate');
  for (const row of rows) {
    const [label, id] = row.split('\t');
    const b = resolveBinding(pane(id), table);
    console.log(
      `${label}\t${b?.runner ?? 'shell'}\t${b?.id ?? '-'}\t${b ? (b.id ? 'recorded' : 'UNRESOLVED') : 'directory only'}`,
    );
  }
}

function bind(runner: string, id: string, target?: string) {
  if (!isRunner(runner) || !validID(id))
    fail('Use bind codex|agy <conversation-id> [--pane <target>].');
  const p = pane(target);
  const b = resolveBinding(p, processes());
  if (!b || b.runner !== runner || !b.pid)
    fail('No unique matching live runner in that pane; start it with epic-recover run first.');
  saveBinding(p, { ...b, id });
  console.log(`Recorded ${runner} ${id} in ${p.target}.`);
}

function record(runner: Runner, payload: Record<string, unknown>) {
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  const id = runner === 'codex' ? payload.session_id : payload.conversation_id;
  if (id !== '' && !validID(id)) return;
  const p = pane();
  const table = processes();
  const parents = ancestors(process.pid, table);
  const b = binding(p, table);
  // A shared daemon cannot prove pane ownership. Require the tracked launcher
  // in this callback's ancestry, or agy's actual foreground CLI ancestor.
  if (b && b.runner === runner && parents.includes(b.pid)) {
    saveBinding(p, { ...b, id: id || null });
  } else if (runner === 'agy') {
    const owner = parents
      .map((pid) => table.get(pid)!)
      .find(
        (proc) => basename(proc.command) === 'agy' && ancestors(proc.pid, table).includes(p.pid),
      );
    if (owner) saveBinding(p, { runner, id: id || null, pid: owner.pid, start: owner.start });
  }
}

function launch(runner: string, args: string[]) {
  if (!isRunner(runner)) fail('Supported runners: codex, agy.');
  const p = pane();
  const owner = processes().get(process.pid) ?? fail('Cannot establish launcher process identity.');
  saveBinding(p, { runner, id: null, pid: owner.pid, start: owner.start });
  const actual = runner === 'codex' ? ['--no-daemon', ...args] : args;
  try {
    const child = spawnSync(runner, actual, { stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    try {
      const b = binding(p, processes());
      if (b?.pid === process.pid) tmux('set-option', '-pu', '-t', p.target, option);
    } catch {
      /* A user may have closed the pane. */
    }
  }
}

function decorate(path: string) {
  // Resurrect does not propagate hook failures. First make its raw snapshot safe
  // to restore even if ownership lookup fails or a pane disappears mid-save.
  const raw = readFileSync(path, 'utf8');
  atomic(
    path,
    raw
      .split('\n')
      .map((row) => {
        if (!row.startsWith('pane\t')) return row;
        return [...row.split('\t').slice(0, 10), ':'].join('\t');
      })
      .join('\n'),
  );
  const table = processes();
  const rows = raw.split('\n').map((row) => {
    if (!row.startsWith('pane\t')) return row;
    const f = row.split('\t');
    if (f.length !== 11) fail('Unsupported resurrect pane format; snapshot was not modified.');
    const p = pane(`${f[1]}:${f[2]}.${f[5]}`);
    const b = resolveBinding(p, table);
    f[10] = ':'; // Ordinary terminals return as shells; arbitrary commands are not replayed.
    if (b) {
      const saved: Saved = { version: 1, runner: b.runner, id: b.id, cwd: p.cwd };
      const token = Buffer.from(JSON.stringify(saved)).toString('base64url');
      f[10] += command(process.execPath, script, 'restore-pane', token);
    }
    return f.join('\t');
  });
  atomic(
    path,
    rows.filter((row) => !row.startsWith('pc-recovery\t')).join('\n') + '\npc-recovery\t1\n',
  );
}

function restorePane(token: string) {
  const saved = JSON.parse(Buffer.from(token, 'base64url').toString()) as Saved;
  if (
    saved.version !== 1 ||
    !isRunner(saved.runner) ||
    (saved.id !== null && !validID(saved.id)) ||
    !existsSync(saved.cwd)
  )
    fail('Invalid recovery record or missing working directory.');
  if (!saved.id) {
    console.log(
      `Original ${saved.runner} conversation was not recorded. Choose its ID, then resume it explicitly; no conversation was guessed.`,
    );
    return;
  }
  process.chdir(saved.cwd);
  launch(
    saved.runner,
    saved.runner === 'codex' ? ['resume', saved.id] : ['--conversation', saved.id],
  );
}

function pluginAction(action: 'save' | 'restore') {
  const path = tmux('show-option', '-gqv', `@resurrect-${action}-script-path`);
  if (!path || !existsSync(path))
    fail(
      'tmux-resurrect is not loaded on this server. Run setup, then source the tmux configuration.',
    );
  if (action === 'restore') {
    const dir = tmux('show-option', '-gqv', '@resurrect-dir');
    if (!dir || !existsSync(join(dir, 'last')))
      fail('No saved workspace. Save before shutting down.');
    tmux('set-option', '-g', '@resurrect-never-overwrite', 'on');
  }
  run('bash', [path, ...(action === 'save' ? ['quiet'] : [])]);
  if (action === 'save') {
    const last = join(tmux('show-option', '-gqv', '@resurrect-dir'), 'last');
    if (!existsSync(last) || !readFileSync(last, 'utf8').includes('\npc-recovery\t1\n'))
      fail(
        'Layout save completed without verified conversation metadata. Check the save hook before shutdown.',
      );
  }
  console.log(
    action === 'save'
      ? 'Workspace saved. Run status to check unresolved conversations.'
      : 'Restore requested. Existing panes are preserved; check recovered TUIs for startup errors.',
  );
}

function update(path: string, text: string) {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === text) return;
    copyFileSync(path, `${path}.before-pc-recovery-${Date.now()}`);
  }
  atomic(path, text);
}

function appendOnce(path: string, line: string) {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!previous.split('\n').includes(line))
    update(path, previous + (previous.endsWith('\n') || !previous ? '' : '\n') + line + '\n');
}

function setup() {
  const installed = join(homedir(), '.local/share/pc/tmux-recovery/tmux-recovery.ts');
  update(installed, readFileSync(script, 'utf8'));
  for (const plugin of ['tmux-resurrect', 'tmux-continuum']) {
    const dest = join(plugins, plugin);
    if (!existsSync(dest))
      run('git', ['clone', '--depth', '1', `https://github.com/tmux-plugins/${plugin}.git`, dest]);
    if (!existsSync(join(dest, plugin === 'tmux-resurrect' ? 'resurrect.tmux' : 'continuum.tmux')))
      fail(`Incomplete plugin installation: ${dest}`);
  }
  const helper = (...args: string[]) => command(process.execPath, installed, ...args);
  const fragment = join(configDir, 'tmux.conf');
  update(
    fragment,
    [
      '# Managed by pc-conductor-recover setup. Load after other tmux plugins.',
      `set -g @resurrect-dir ${quote(join(homedir(), '.local/share/pc/tmux-recovery/snapshots'))}`,
      `set -g @resurrect-default-processes ''`,
      `set -g @resurrect-processes '~tmux-recovery.ts.*restore-pane'`,
      `set -g @resurrect-hook-post-save-layout ${quote(helper('decorate'))}`,
      `set -g @resurrect-hook-post-restore-all 'tmux set-option -g @resurrect-never-overwrite on'`,
      `set -g @continuum-save-interval '5'`,
      `set -g @continuum-restore 'on'`,
      'set -g status on',
      `run-shell ${quote(command('bash', join(plugins, 'tmux-resurrect/resurrect.tmux')))}`,
      `run-shell ${quote(command('bash', join(plugins, 'tmux-continuum/continuum.tmux')))}`,
      '',
    ].join('\n'),
  );
  const xdg = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tmux/tmux.conf');
  const main = existsSync(join(homedir(), '.tmux.conf'))
    ? join(homedir(), '.tmux.conf')
    : existsSync(xdg)
      ? xdg
      : join(homedir(), '.tmux.conf');
  appendOnce(main, `source-file ${quote(fragment)}`);
  const hooksPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
  const hooks = existsSync(hooksPath) ? JSON.parse(readFileSync(hooksPath, 'utf8')) : {};
  hooks.hooks ??= {};
  const recorder = helper('record', 'codex');
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    hooks.hooks[event] ??= [];
    if (
      !hooks.hooks[event].some((group: { hooks?: { command?: string }[] }) =>
        group.hooks?.some((h) => h.command === recorder),
      )
    )
      hooks.hooks[event].push({ hooks: [{ type: 'command', command: recorder, timeout: 5 }] });
  }
  update(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
  const agyPath = join(homedir(), '.gemini/antigravity-cli/settings.json');
  const settings = existsSync(agyPath) ? JSON.parse(readFileSync(agyPath, 'utf8')) : {};
  const statusCommand = helper('agy-statusline');
  if (settings.statusLine?.command !== statusCommand) {
    const original = settings.statusLine ?? {};
    update(join(configDir, 'agy-statusline.json'), JSON.stringify(original));
    settings.statusLine = { ...original, type: 'command', command: statusCommand, enabled: true };
    if (!original.command) settings.statusLine.stack_with_default = true;
    update(agyPath, JSON.stringify(settings, null, 2) + '\n');
  }
  const shell = join(configDir, 'launchers.zsh');
  update(
    shell,
    [
      '# Track interactive agents launched inside tmux; other commands pass through.',
      ...(['codex', 'agy'] as const).map(
        (r) =>
          `${r}() {\n  if [[ -n "$TMUX" && ( $# == 0 || "$1" == -* || "$1" == resume || "$1" == fork ) && "$*" != *--help* && "$*" != *--version* ]]; then\n    ${helper('run', r)} "$@"\n  else\n    command ${r} "$@"\n  fi\n}`,
      ),
      '',
    ].join('\n'),
  );
  appendOnce(join(homedir(), '.zshrc'), `source ${quote(shell)}`);
  console.log(
    `Installed. New zsh shells load tracked launchers. In existing shells: source ${quote(shell)}`,
  );
  console.log(
    'Codex: review and trust the two recording hooks with /hooks once. Until trusted, fresh IDs remain unresolved.',
  );
  console.log(
    `Tmux config: ${main}. Load it on an existing server with tmux source-file ${quote(main)}; new servers load it automatically.`,
  );
}

function agyStatusline(input: string) {
  try {
    record('agy', JSON.parse(input));
  } catch (e) {
    console.error(`pc recovery: ${String(e)}`);
  }
  const path = join(configDir, 'agy-statusline.json');
  const original = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (original.enabled !== false && original.command) {
    const child = spawnSync('sh', ['-c', original.command], {
      input,
      encoding: 'utf8',
      timeout: 4000,
    });
    process.stdout.write(child.stdout ?? '');
    process.stderr.write(child.stderr ?? '');
  }
}

const help = `Usage: epic-recover <command>
  setup                           Install plugins, tmux config and agent recorders
  status                          Read-only table for every pane on this tmux server
  save                            Save layout and verified conversation IDs now
  restore                         Restore latest snapshot on this server
  run codex|agy [arguments...]    Launch and track an interactive agent in this pane
  bind codex|agy <id> [--pane P]   Register a verified conversation for a live agent
  --help                          Show this help

Internal callbacks: decorate <snapshot>, restore-pane <token>, record codex,
agy-statusline. Requires Node >=22.18 and tmux. Target another server with TMUX
set to its socket identity. No project configuration is required.`;

try {
  const [action, ...args] = process.argv.slice(2);
  switch (action) {
    case undefined:
    case '--help':
    case '-h':
      console.log(help);
      break;
    case 'setup':
      setup();
      break;
    case 'status':
      status();
      break;
    case 'save':
    case 'restore':
      pluginAction(action);
      break;
    case 'run':
      launch(args[0], args.slice(1));
      break;
    case 'bind':
      if (args.length !== 2 && !(args.length === 4 && args[2] === '--pane'))
        fail('Use bind codex|agy <id> [--pane P].');
      bind(args[0], args[1], args[3]);
      break;
    case 'decorate':
      decorate(resolve(args[0]));
      break;
    case 'restore-pane':
      restorePane(args[0]);
      break;
    case 'record':
      if (args[0] !== 'codex') fail('Use record codex.');
      record('codex', JSON.parse(readFileSync(0, 'utf8')));
      break;
    case 'agy-statusline':
      agyStatusline(readFileSync(0, 'utf8'));
      break;
    default:
      fail(`Unknown command ${action}. Use --help.`);
  }
} catch (error) {
  console.error(`pc recovery: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
