import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve('skills/pc-conductor-recover/scripts/tmux-recovery.ts');
const plugins = join(homedir(), '.tmux/plugins');
const skip =
  !existsSync(join(plugins, 'tmux-resurrect')) || !existsSync(join(plugins, 'tmux-continuum'))
    ? 'Install tmux-resurrect and tmux-continuum first.'
    : false;
const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (check()) return;
    await delay(100);
  }
  assert.fail(`Timed out: ${label}`);
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-recovery-')));
  const home = join(dir, 'home');
  const socket = join(dir, 'tmux');
  const log = join(dir, 'calls.jsonl');
  mkdirSync(join(home, '.tmux/plugins'), { recursive: true });
  for (const name of ['tmux-resurrect', 'tmux-continuum'])
    symlinkSync(join(plugins, name), join(home, '.tmux/plugins', name));
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    TMUX: '',
    TMUX_PANE: '',
    PC_TEST_LOG: log,
    PC_TEST_HELPER: helper,
  };
  const exec = (exe: string, args: string[], override = {}) =>
    execFileSync(exe, args, {
      env: { ...env, ...override },
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const cli = (...args: string[]) =>
    exec(process.execPath, [helper, ...args], { TMUX: `${socket},0,0` });
  const tmux = (...args: string[]) => exec('tmux', ['-S', socket, ...args]);
  const dispose = () => {
    try {
      tmux('kill-server');
    } catch {
      /* server may already be stopped */
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { dir, home, socket, log, env, exec, cli, tmux, dispose };
}

test(
  'paired snapshots restore exact conversations and layout; stale or unrelated identities are rejected',
  { skip, timeout: 120000 },
  async () => {
    const f = fixture();
    try {
      const bin = join(f.dir, 'bin');
      mkdirSync(bin);
      // Emulate a host with only this server for continuum's startup guard.
      // Core process-ownership checks still receive the real process table.
      writeFileSync(
        join(bin, 'ps'),
        '#!/bin/sh\nif [ "$1" = "-u" ]; then exit 0; fi\nexec /bin/ps "$@"\n',
        { mode: 0o755 },
      );
      const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const name = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
const index = args.indexOf(name === 'codex' ? 'resume' : '--conversation');
const id = index >= 0 ? args[index + 1] : args[args.indexOf('--test-id') + 1];
if (!args.includes('--no-record')) {
  const payload = name === 'codex' ? {session_id: id, hook_event_name: 'SessionStart', cwd: process.cwd()} : {conversation_id: id, cwd: process.cwd()};
  cp.execFileSync(process.execPath, [process.env.PC_TEST_HELPER, ...(name === 'codex' ? ['record', 'codex'] : ['agy-statusline'])], {input: JSON.stringify(payload)});
}
fs.appendFileSync(process.env.PC_TEST_LOG, JSON.stringify({name, args, cwd: process.cwd()}) + '\\n');
setInterval(() => {}, 1000);
`;
      for (const runner of ['codex', 'agy'])
        writeFileSync(join(bin, runner), fake, { mode: 0o755 });
      f.env.PATH = bin + ':' + process.env.PATH;
      f.cli('setup');
      const work = join(f.dir, "work $literal ' quote");
      const notes = join(f.dir, 'notes');
      mkdirSync(work);
      mkdirSync(notes);
      const config = join(f.home, '.tmux.conf');
      // Login zsh resets PATH on macOS; keep fake runners in PATH on restore.
      writeFileSync(
        config,
        'set -g default-shell /bin/sh\nset -g default-command /bin/sh\n' +
          readFileSync(config, 'utf8'),
      );
      f.tmux(
        '-f',
        config,
        'new-session',
        '-d',
        '-s',
        'work',
        '-n',
        'agents',
        '-c',
        work,
        '/bin/sh',
      );
      f.tmux('set-option', '-g', 'automatic-rename', 'off');
      assert.equal(f.tmux('show-option', '-gv', 'default-command'), '/bin/sh');
      const p0 = f.tmux('display', '-p', '-t', 'work:0.0', '#{pane_id}');
      const p1 = f.tmux(
        'split-window',
        '-h',
        '-t',
        p0,
        '-c',
        work,
        '-P',
        '-F',
        '#{pane_id}',
        '/bin/sh',
      );
      const p2 = f.tmux(
        'split-window',
        '-v',
        '-t',
        p1,
        '-c',
        work,
        '-P',
        '-F',
        '#{pane_id}',
        '/bin/sh',
      );
      f.tmux('new-window', '-d', '-t', 'work:1', '-n', 'notes', '-c', notes, '/bin/sh');
      const send = (p: string, text: string) => {
        f.tmux('send-keys', '-l', '-t', p, text);
        f.tmux('send-keys', '-t', p, 'Enter');
      };
      send(
        p0,
        [process.execPath, helper, 'run', 'codex', '--test-id', 'codex-one'].map(q).join(' '),
      );
      send(p1, [process.execPath, helper, 'run', 'agy', '--test-id', 'agy-two'].map(q).join(' '));
      send(
        p2,
        [process.execPath, helper, 'run', 'codex', '--test-id', 'unknown', '--no-record']
          .map(q)
          .join(' '),
      );
      const calls = () =>
        existsSync(f.log)
          ? readFileSync(f.log, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      await until(() => calls().length === 3, 'initial fake runners');
      const initialStatus = f.cli('status');
      assert.match(initialStatus, /codex-one/);
      assert.match(initialStatus, /agy-two/);
      assert.match(initialStatus, /UNRESOLVED/);
      const binding = f.tmux('show-option', '-pqv', '-t', p0, '@pc-recovery');
      // A forged event with a real payload from an unrelated process must not rebind.
      execFileSync(process.execPath, [helper, 'record', 'codex'], {
        env: { ...f.env, TMUX: `${f.socket},0,0`, TMUX_PANE: p0 },
        input: JSON.stringify({ session_id: 'wrong-id' }),
        timeout: 5000,
      });
      assert.equal(f.tmux('show-option', '-pqv', '-t', p0, '@pc-recovery'), binding);
      f.cli('save');
      const savedPath = join(f.home, '.local/share/pc/tmux-recovery/snapshots/last');
      const snapshot = readFileSync(savedPath, 'utf8');
      const panes = snapshot.split('\n').filter((line) => line.startsWith('pane\t'));
      assert.equal(panes.length, 4);
      const records = panes
        .map((line) => line.split('\t')[10])
        .filter((line) => line !== ':')
        .map((line) =>
          JSON.parse(Buffer.from(line.match(/'([A-Za-z0-9_-]+)'$/)![1], 'base64url').toString()),
        );
      assert.deepEqual(
        records.map((r) => r.id),
        ['codex-one', 'agy-two', null],
      );
      assert.ok(records.every((r) => r.cwd === work));
      const geometry = f.tmux(
        'list-panes',
        '-t',
        'work:0',
        '-F',
        '#{pane_left},#{pane_top},#{pane_width},#{pane_height}',
      );
      f.tmux('kill-server');
      await delay(300);
      // Exercise continuum's real server-start auto-restore using the generated config.
      f.tmux('-f', config, 'new-session', '-d', '-s', '0', '/bin/sh');
      await until(() => calls().length === 5, 'automatic restore');
      assert.deepEqual(
        calls()
          .slice(3)
          .sort((a, b) => b.name.localeCompare(a.name))
          .map((c) => [c.name, c.args, c.cwd]),
        [
          ['codex', ['--no-daemon', 'resume', 'codex-one'], work],
          ['agy', ['--conversation', 'agy-two'], work],
        ],
      );
      assert.equal(
        f.tmux(
          'list-panes',
          '-t',
          'work:0',
          '-F',
          '#{pane_left},#{pane_top},#{pane_width},#{pane_height}',
        ),
        geometry,
      );
      assert.match(
        f.tmux('list-windows', '-t', 'work', '-F', '#{window_index}:#{window_name}'),
        /0:agents\n1:notes/,
      );
      assert.equal(f.tmux('display', '-p', '-t', 'work:1.0', '#{pane_current_path}'), notes);
      assert.match(
        f.tmux('capture-pane', '-pJ', '-t', 'work:0.2'),
        /conversation was not recorded/,
      );
      f.cli('restore');
      assert.equal(calls().length, 5, 'repeat restore must not send a second resume command');
      const restoredBinding = f.tmux('show-option', '-pqv', '-t', 'work:0.0', '@pc-recovery');
      f.tmux('send-keys', '-t', 'work:0.0', 'C-c');
      await until(() => !f.cli('status').includes('codex-one'), 'runner exit cleanup');
      f.tmux('set-option', '-p', '-t', 'work:0.0', '@pc-recovery', restoredBinding);
      f.cli('save');
      const stale = readFileSync(savedPath, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('pane\twork\t0\t') && line.split('\t')[5] === '0')!;
      assert.equal(
        stale.split('\t')[10],
        ':',
        'dead owner binding must not resurrect an old conversation',
      );
    } finally {
      f.dispose();
    }
  },
);

test(
  'setup preserves user config and status output and is idempotent',
  { skip, timeout: 120000 },
  () => {
    const f = fixture();
    try {
      mkdirSync(join(f.home, '.codex'), { recursive: true });
      mkdirSync(join(f.home, '.gemini/antigravity-cli'), { recursive: true });
      const hooksPath = join(f.home, '.codex/hooks.json');
      const settingsPath = join(f.home, '.gemini/antigravity-cli/settings.json');
      const originalHook = { hooks: [{ type: 'command', command: 'printf existing' }] };
      writeFileSync(
        hooksPath,
        JSON.stringify({ description: 'user hooks', hooks: { SessionStart: [originalHook] } }),
      );
      writeFileSync(
        settingsPath,
        JSON.stringify({
          model: 'keep-user-model',
          statusLine: { type: 'command', command: "printf 'original status'", padding: 2 },
        }),
      );
      writeFileSync(join(f.home, '.zshrc'), '# user shell settings\n');
      f.cli('setup');
      const first = [
        hooksPath,
        settingsPath,
        join(f.home, '.zshrc'),
        join(f.home, '.tmux.conf'),
      ].map((p) => readFileSync(p, 'utf8'));
      f.cli('setup');
      assert.deepEqual(
        [hooksPath, settingsPath, join(f.home, '.zshrc'), join(f.home, '.tmux.conf')].map((p) =>
          readFileSync(p, 'utf8'),
        ),
        first,
      );
      const hooks = JSON.parse(first[0]);
      assert.deepEqual(hooks.hooks.SessionStart[0], originalHook);
      assert.equal(hooks.hooks.SessionStart.length, 2);
      assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
      const settings = JSON.parse(first[1]);
      assert.equal(settings.model, 'keep-user-model');
      assert.equal(settings.statusLine.padding, 2);
      const output = execFileSync(process.execPath, [helper, 'agy-statusline'], {
        env: f.env,
        input: JSON.stringify({ conversation_id: 'agy-one' }),
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(output, 'original status');
      assert.match(first[2], /^# user shell settings\n/);
    } finally {
      f.dispose();
    }
  },
);
