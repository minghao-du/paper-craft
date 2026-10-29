/** Portable workflow CLI shared by agents with filesystem and command execution access. */
import { Command } from 'commander';
import { loadFleetConfig } from '@paper-craft/core/workflow/fleet-config';
import {
  consumeIntent,
  findIntent,
  preserveState,
  writeIntent,
} from '@paper-craft/core/workflow/handoff';
import { checkFleet, checkReclaim } from '@paper-craft/core/workflow/fleet';
import { CodexRunner, inspectConductor, startConductor } from '@paper-craft/core/workflow/runtime';
import { driveIssue, readIssue } from '@paper-craft/core/workflow/issue-driver';
import { drivePullRequest, GitHubPullRequests } from '@paper-craft/core/workflow/pr-driver';
import { inspectIssueRun } from '@paper-craft/core/workflow/issue-driver';
import { readFileSync } from 'node:fs';
import { output } from '../utils/output.js';

interface Options {
  config: string;
  fetch?: boolean;
  dir?: string;
  reason?: string;
}

function configured(command: Command): Command {
  return command.option(
    '--config <file>',
    'Authoritative conductor configuration',
    '.epic-config.json',
  );
}

function run(action: () => void): void {
  try {
    action();
  } catch (error) {
    output(
      { status: 'unknown', error: error instanceof Error ? error.message : String(error) },
      false,
    );
    process.exitCode = 2;
  }
}

/** Register workflow file operations and read-only fleet checks, with JSON output by default. */
export function registerWorkflowCommands(program: Command, opts: { human: () => boolean }): void {
  const workflow = program
    .command('workflow')
    .description('Portable file-based task handoff and preservation');
  configured(workflow.command('root').description('Resolve the configured clone root'))
    .option('--path', 'Print only the path for shell assignment')
    .action((options: Options & { path?: boolean }) =>
      run(() => {
        const config = loadFleetConfig(options.config);
        if (options.path) console.log(config.root);
        else output({ path: config.root }, opts.human());
      }),
    );
  const conductor = workflow
    .command('conductor')
    .description('Start or inspect the Fleet managed Conductor');
  configured(
    conductor.command('status').description('Read durable Conductor identity and occupancy'),
  ).action((options: Options) =>
    run(() => {
      output(
        inspectConductor(loadFleetConfig(options.config)) ?? { status: 'absent' },
        opts.human(),
      );
    }),
  );
  configured(
    conductor
      .command('start')
      .description('Launch Codex in tmux; require actual Runner acknowledgement'),
  )
    .requiredOption('--prompt-file <file>', 'UTF-8 Conductor instructions')
    .action(async (options: Options & { promptFile: string }) => {
      try {
        const result = await startConductor(
          loadFleetConfig(options.config),
          new CodexRunner(),
          readFileSync(options.promptFile, 'utf8'),
        );
        output(result, opts.human());
        if (result.status !== 'running') process.exitCode = 2;
      } catch (error) {
        run(() => {
          throw error;
        });
      }
    });
  configured(
    conductor
      .command('issue <number>')
      .description('Automatically dispatch and collect standalone Issue stages'),
  ).action(async (number: string, options: Options) => {
    try {
      const config = loadFleetConfig(options.config);
      const issue = readIssue(config.project, Number(number));
      const runner = new CodexRunner();
      const task = await driveIssue(config, runner, issue);
      output(
        await drivePullRequest(
          config,
          runner,
          new GitHubPullRequests(task.checkout, issue.repository),
          {
            repository: issue.repository,
            issue: issue.number,
            checkout: task.checkout,
          },
        ),
        opts.human(),
      );
    } catch (error) {
      run(() => {
        throw error;
      });
    }
  });
  configured(
    conductor
      .command('land <issue>')
      .description('Check, repair and merge delivered PR stages automatically'),
  )
    .option(
      '--confirmation-file <file>',
      'EPIC professional confirmation JSON: epic, head, evidence',
    )
    .action(async (number: string, options: Options & { confirmationFile?: string }) => {
      try {
        const config = loadFleetConfig(options.config);
        const issue = readIssue(config.project, Number(number));
        const task = inspectIssueRun(config, issue.repository, issue.number);
        if (!task || task.status !== 'done')
          throw new Error('Expected delivered Issue stages before landing');
        output(
          await drivePullRequest(
            config,
            new CodexRunner(),
            new GitHubPullRequests(task.checkout, issue.repository),
            {
              repository: issue.repository,
              issue: issue.number,
              checkout: task.checkout,
              epic: issue.parent,
              confirmation: options.confirmationFile
                ? JSON.parse(readFileSync(options.confirmationFile, 'utf8'))
                : undefined,
            },
          ),
          opts.human(),
        );
      } catch (error) {
        run(() => {
          throw error;
        });
      }
    });
  const intent = workflow.command('intent').description('Queue, find and consume task briefs');
  configured(intent.command('find <issue>').description('Find queued intent; exit 1 when absent'))
    .option('--path', 'Print only the path for shell assignment')
    .action((issue: string, options: Options & { path?: boolean }) =>
      run(() => {
        const path = findIntent(loadFleetConfig(options.config), issue);
        if (!path) process.exitCode = 1;
        if (options.path) {
          if (path) console.log(path);
        } else output({ status: path ? 'found' : 'absent', path }, opts.human());
      }),
    );
  configured(
    intent
      .command('write <issue>')
      .description('Queue a brief without overwriting existing intent'),
  )
    .requiredOption('--prompt-file <file>', 'UTF-8 task brief')
    .action((issue: string, options: Options & { promptFile: string }) =>
      run(() => {
        output(
          {
            status: 'queued',
            path: writeIntent(loadFleetConfig(options.config), issue, options.promptFile),
          },
          opts.human(),
        );
      }),
    );
  configured(
    intent.command('consume <issue>').description('Archive intent after confirmed worker startup'),
  ).action((issue: string, options: Options) =>
    run(() => {
      output(
        { status: 'consumed', path: consumeIntent(loadFleetConfig(options.config), issue) },
        opts.human(),
      );
    }),
  );
  configured(
    workflow.command('preserve').description('Copy and verify slot state; retain all originals'),
  )
    .requiredOption('--dir <directory>', 'Configured project or slot to preserve')
    .requiredOption('--reason <text>', 'Reason recorded in the archive manifest')
    .action((options: Options & { dir: string; reason: string }) =>
      run(() => {
        output(
          preserveState(loadFleetConfig(options.config), options.dir, options.reason),
          opts.human(),
        );
      }),
    );
  const fleet = program
    .command('fleet')
    .description('Portable Git/file checks; runtime occupancy remains unknown');
  for (const kind of ['currency', 'collisions'] as const) {
    configured(
      fleet
        .command(kind)
        .description(
          kind === 'currency'
            ? 'Check registered slots against the base branch'
            : 'Check conservative file overlap across registered slots',
        ),
    )
      .option('--fetch', 'Refresh origin base refs in the conductor and slots before checking')
      .action((options: Options) =>
        run(() => {
          const report = checkFleet(loadFleetConfig(options.config), kind, options.fetch);
          output(report, opts.human(), () => JSON.stringify(report, null, 2));
          process.exitCode = report.status === 'unknown' ? 2 : report.status === 'issues' ? 1 : 0;
        }),
      );
  }
  configured(
    fleet
      .command('reclaim-check')
      .description('Report reclaim evidence without modifying the checkout; exits 2'),
  )
    .requiredOption('--dir <directory>', 'Configured project or slot to inspect')
    .action((options: Options & { dir: string }) =>
      run(() => {
        output(checkReclaim(loadFleetConfig(options.config), options.dir), opts.human());
        process.exitCode = 2;
      }),
    );
}
