import {
  startRun,
  inspectRuns,
  recoverRun,
  subjectOrchestrator,
} from '@paper-craft/core/workflow/run-driver';
import { execFileSync } from 'node:child_process';
import { CodexShortRunner } from '@paper-craft/core/workflow/subagents';
import { recoverFleet } from '@paper-craft/core/workflow/recovery';
import { finishEpic } from '../workflow/epic-completion.js';
import { landDelivery } from '@paper-craft/core/workflow/postmerge';
import { registerSubagentCommands } from './workflow-subagents.js';
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
import {
  CodexRunner,
  managedRunner,
  inspectConductor,
  startConductor,
} from '@paper-craft/core/workflow/runtime';
import { driveEpic, inspectEpicRun } from '@paper-craft/core/workflow/epic-driver';
import { driveIssue, readIssue } from '@paper-craft/core/workflow/issue-driver';
import { GitHubPullRequests } from '@paper-craft/core/workflow/pr-driver';
import { inspectIssueRun } from '@paper-craft/core/workflow/issue-driver';
import { readFileSync, existsSync } from 'node:fs';
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
  registerSubagentCommands(workflow, opts);
  const orchestrator = workflow
    .command('orchestrator')
    .description('Create or inspect a subject-scoped managed Run');
  configured(
    orchestrator.command('status').description('Read Fleet Run and Orchestrator ownership'),
  ).action((options: Options) =>
    run(() => output(inspectRuns(loadFleetConfig(options.config)), opts.human())),
  );
  configured(
    orchestrator
      .command('start <issue>')
      .description('Create or reconnect a Run from configured repository context')
      .requiredOption('--provider <provider>', 'Managed provider: codex, agy, or claude'),
  ).action(async (number: string, options: Options & { provider: string }) => {
    try {
      const config = loadFleetConfig(options.config);
      const subject = readIssue(config.project, Number(number));
      const children: unknown = JSON.parse(
        execFileSync(
          'gh',
          ['api', `repos/${subject.repository}/issues/${subject.number}/sub_issues`],
          { cwd: config.project, encoding: 'utf8' },
        ),
      );
      if (!Array.isArray(children)) throw new Error('Cannot resolve Issue/EPIC scope');
      output(
        await startRun(
          config,
          managedRunner(options.provider),
          { ...subject, kind: children.length ? 'epic' : 'issue' },
          options.provider,
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
    orchestrator
      .command('recover <run>')
      .description('Reconcile durable results and startup identity; preserve unknown occupancy')
      .option('--replace', 'Replace Orchestrator only after verified termination'),
  ).action(async (id: string, options: Options & { replace?: boolean }) => {
    try {
      const config = loadFleetConfig(options.config);
      const run = inspectRuns(config).runs.find((run) => run.id === id);
      if (!run) throw new Error('Unknown Run');
      const runner = managedRunner(run.provider);
      output(
        await recoverRun(config, runner, id, {
          replaceOrchestrator: options.replace,
          stopped: (attempt) => runner.stopped(attempt),
        }),
        opts.human(),
      );
    } catch (error) {
      run(() => {
        throw error;
      });
    }
  });
  const conductor = workflow
    .command('conductor')
    .description('Start or inspect the Fleet managed Conductor');
  configured(
    conductor
      .command('recover')
      .description('Reconcile original attempts and automatically continue persisted workflows'),
  ).action(async (options: Options) => {
    try {
      const config = loadFleetConfig(options.config);
      const runner = new CodexRunner();
      output(
        await recoverFleet(config, runner, new CodexShortRunner(), async (work) => {
          const runner = managedRunner(
            subjectOrchestrator(config, work.repository, work.number)?.runner ?? 'codex',
          );
          const issue = readIssue(config.project, work.number);
          if (issue.repository !== work.repository)
            throw new Error('Recovered repository differs from live Issue');
          if (work.epic) return finishEpic(config, runner, await driveEpic(config, runner, issue));
          const task = await driveIssue(config, runner, issue);
          return landDelivery(
            config,
            runner,
            new GitHubPullRequests(
              existsSync(task.checkout) ? task.checkout : config.project,
              work.repository,
            ),
            { repository: work.repository, issue: work.number, checkout: task.checkout },
          );
        }),
        opts.human(),
      );
    } catch (error) {
      output({ status: 'blocked', error: String(error) }, false);
      process.exitCode = 2;
    }
  });
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
      .command('finalize-epic <number>')
      .description('Assess EPIC delivery; finalize specialists only after confirmed closure')
      .requiredOption('--repository <owner/name>', 'Target repository')
      .option(
        '--retry',
        'Start a fresh finalization round only after verified specialist termination',
      ),
  ).action(async (number: string, options: Options & { repository: string; retry?: boolean }) => {
    try {
      const config = loadFleetConfig(options.config);
      const epic = inspectEpicRun(config, options.repository, Number(number));
      if (!epic) throw new Error('Expected delivered EPIC record');
      output(
        await finishEpic(
          config,
          managedRunner(subjectOrchestrator(config, epic.repository, epic.epic)?.runner ?? 'codex'),
          epic,
          undefined,
          options.retry,
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
      .command('close-epic <number>')
      .description('Record explicit human confirmation, close and archive an accepted EPIC')
      .requiredOption('--repository <owner/name>', 'Target repository')
      .requiredOption('--human-confirmation <text>', 'Exact explicit human closure confirmation'),
  ).action(
    async (
      number: string,
      options: Options & { repository: string; humanConfirmation: string },
    ) => {
      try {
        const config = loadFleetConfig(options.config);
        const epic = inspectEpicRun(config, options.repository, Number(number));
        if (!epic) throw new Error('Expected delivered EPIC record');
        output(
          await finishEpic(
            config,
            managedRunner(
              subjectOrchestrator(config, epic.repository, epic.epic)?.runner ?? 'codex',
            ),
            epic,
            {
              epic: Number(number),
              confirmed: true,
              source: 'human',
              evidence: options.humanConfirmation,
            },
          ),
          opts.human(),
        );
      } catch (error) {
        run(() => {
          throw error;
        });
      }
    },
  );
  configured(
    conductor
      .command('issue <number>')
      .description('Deliver only the requested Issue, retaining parent constraints'),
  ).action(async (number: string, options: Options) => {
    try {
      const config = loadFleetConfig(options.config);
      const issue = readIssue(config.project, Number(number));
      const runner = managedRunner(
        subjectOrchestrator(config, issue.repository, issue.number)?.runner ?? 'codex',
      );
      const task = await driveIssue(config, runner, issue);
      output(
        await landDelivery(
          config,
          runner,
          new GitHubPullRequests(
            existsSync(task.checkout) ? task.checkout : config.project,
            issue.repository,
          ),
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
      .description('Merge, record, preserve and clean delivered PR stages automatically'),
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
          await landDelivery(
            config,
            managedRunner(
              subjectOrchestrator(config, issue.repository, issue.number)?.runner ?? 'codex',
            ),
            new GitHubPullRequests(
              existsSync(task.checkout) ? task.checkout : config.project,
              issue.repository,
            ),
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
