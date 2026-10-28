/** Local Dashboard launch and JSON observation commands. */
import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDashboard } from '@paper-craft/dashboard';
import { serve } from '@hono/node-server';

/** Register read-only Dashboard setup and observation entry points. */
export function registerDashboardCommand(program: Command): void {
  const command = program.command('dashboard').description('Read-only local Fleet observations');
  const configure = (cmd: Command) =>
    cmd
      .option('--config <path...>', 'Explicit authoritative Fleet configuration(s)')
      .option('--project <name>', 'Optional research Project association for new registrations')
      .option(
        '--data-dir <path>',
        'Dashboard-owned registration and observation directory',
        join(homedir(), '.config', 'pc', 'dashboard'),
      )
      .option('--interval <milliseconds>', 'Local collection interval', '15000')
      .option('--github-interval <milliseconds>', 'GitHub collection interval', '180000')
      .option('--git-interval <milliseconds>', 'Cached Git collection interval', '60000')
      .option('--runtime-interval <milliseconds>', 'Runtime observation interval', '15000');

  const options = (opts: Record<string, unknown>) => {
    const intervalMs = Number(opts.interval);
    if (!Number.isFinite(intervalMs) || intervalMs < 100)
      throw new Error('Expected interval of at least 100 milliseconds');
    const githubIntervalMs = Number(opts.githubInterval);
    if (!Number.isFinite(githubIntervalMs) || githubIntervalMs < 100)
      throw new Error('Expected GitHub interval of at least 100 milliseconds');
    const gitIntervalMs = Number(opts.gitInterval);
    if (!Number.isFinite(gitIntervalMs) || gitIntervalMs < 100)
      throw new Error('Expected Git interval of at least 100 milliseconds');
    const runtimeIntervalMs = Number(opts.runtimeInterval);
    if (!Number.isFinite(runtimeIntervalMs) || runtimeIntervalMs < 100)
      throw new Error('Expected runtime interval of at least 100 milliseconds');
    return {
      gitIntervalMs,
      runtimeIntervalMs,
      githubIntervalMs,

      dataDir: resolve(String(opts.dataDir)),
      configs: (opts.config as string[] | undefined)?.map((p) => resolve(p)),
      intervalMs,
      project: opts.project as string | undefined,
    };
  };
  configure(
    command.command('status').description('Print cached-compatible Fleet evidence as JSON'),
  ).action(async (opts) => {
    const dashboard = await createDashboard(options(opts));
    try {
      const response = await dashboard.app.request('http://127.0.0.1:4317/api/snapshot', {
        headers: { host: '127.0.0.1:4317', authorization: `Bearer ${dashboard.token}` },
      });
      console.log(JSON.stringify(await response.json(), null, 2));
    } finally {
      dashboard.stop();
    }
  });
  configure(
    command.command('serve').description('Serve protected loopback Dashboard until stopped'),
  )
    .option('--port <number>', 'Loopback port', '4317')
    .option('--no-open', 'Do not open browser automatically')
    .action(async (opts) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Expected port 1–65535');
      const dashboard = await createDashboard({ ...options(opts), host: `127.0.0.1:${port}` });
      const server = serve({ fetch: dashboard.app.fetch, hostname: '127.0.0.1', port });
      const url = `http://127.0.0.1:${port}/#token=${dashboard.token}`;
      console.log(`Dashboard access link (keep private): ${url}`);
      if (opts.open) {
        const executable =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer'
              : 'xdg-open';
        const child = spawn(executable, [url], { stdio: 'ignore' });
        child.on('error', () => console.error('Open the startup link in your browser.'));
        child.unref();
      }
      const stop = () => {
        dashboard.stop();
        server.close();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
}
