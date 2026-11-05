/**
 * @fileoverview CLI commands for workflow lifecycle: init, start, status.
 */

import { parseArgs } from 'node:util';
import { WorkflowEngine } from '../../core/src/workflow/engine.js';

export interface CliContext {
  cwd?: string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  engine?: WorkflowEngine;
}

const USAGE_HELP = `
Usage: pc workflow <command> [options]

Commands:
  init                     Scaffold default workflow configuration (.pc-workflow.yml)
  start <issue>            Validate preflight gates and start a new workflow Run
  status                   Inspect the current status of a workflow Run

Global Options:
  -h, --help               Show help information
  -v, --version            Show version information

Init Options:
  --config <path>          Path where configuration should be written
  --repo <owner/repo>      GitHub repository slug
  --worktree-root <dir>    Directory for execution worktrees (default: .worktrees)
  --provider <provider>    Agent execution provider (default: agy)

Start Options:
  --config <path>          Path to workflow configuration file
  --provider <provider>    Provider override (default: agy)
  --requirements <text>    Immutable shared requirements text
  --requirements-file <file> Path to UTF-8 file containing shared requirements

Status Options:
  --run <runId>            Run identifier to inspect (defaults to latest)
  --config <path>          Path to workflow configuration file
  --detailed               Show full structured context and telemetry
`.trim();

/**
 * Executes a workflow CLI command.
 * @returns Process exit code (0 for success, non-zero for error).
 */
export async function runCli(argv: string[], ctx?: CliContext): Promise<number> {
  const stdout = ctx?.stdout ?? ((msg: string) => console.log(msg));
  const stderr = ctx?.stderr ?? ((msg: string) => console.error(msg));
  const cwd = ctx?.cwd ?? process.cwd();

  // Normalize args: strip leading 'pc', 'workflow', or 'orchestrator' if passed
  const args = [...argv];
  if (args[0] === 'pc') {
    args.shift();
  }
  if (args[0] === 'workflow') {
    args.shift();
  }
  if (args[0] === 'orchestrator') {
    args.shift();
  }

  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout(USAGE_HELP);
    return 0;
  }

  const engine = ctx?.engine ?? new WorkflowEngine({ cwd });

  try {
    switch (command) {
      case 'init': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            config: { type: 'string' },
            repo: { type: 'string' },
            'worktree-root': { type: 'string' },
            provider: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        const res = await engine.init({
          configPath: values.config,
          repository: values.repo,
          worktreeRoot: values['worktree-root'],
          provider: values.provider,
        });

        stdout(`Initialized workflow configuration at: ${res.configPath}`);
        return 0;
      }

      case 'start': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            config: { type: 'string' },
            provider: { type: 'string' },
            requirements: { type: 'string' },
            'requirements-file': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        const rawIssue = positionals[0];
        if (!rawIssue) {
          stderr('Error: Issue number is required. Usage: pc workflow start <issue>');
          return 1;
        }

        const cleanIssue = rawIssue.replace(/^#/, '');
        const issueNumber = Number.parseInt(cleanIssue, 10);
        if (Number.isNaN(issueNumber) || issueNumber <= 0) {
          stderr(`Error: Invalid issue number "${rawIssue}". Must be a positive integer.`);
          return 1;
        }

        const runContext = await engine.start({
          issue: issueNumber,
          configPath: values.config,
          provider: values.provider,
          requirements: values.requirements,
          requirementsFile: values['requirements-file'],
        });

        stdout(
          JSON.stringify(
            {
              run_id: runContext.run_id,
              repository: runContext.repository,
              issue: runContext.issue,
              status: runContext.status,
              step: runContext.current_step,
              worktree: runContext.worktree_path,
              provider: runContext.provider,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      case 'status': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            config: { type: 'string' },
            detailed: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        const statusResult = await engine.status({
          runId: values.run,
          configPath: values.config,
          detailed: values.detailed,
        });

        stdout(JSON.stringify(statusResult, null, 2));
        return 0;
      }

      default: {
        stderr(`Unknown command: "${command}". Use "pc workflow --help" for available commands.`);
        return 1;
      }
    }
  } catch (err) {
    stderr((err as Error).message || String(err));
    return 1;
  }
}
