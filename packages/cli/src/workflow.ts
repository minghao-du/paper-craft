/**
 * @fileoverview CLI commands for workflow lifecycle: init, start, status, dispatch, submit-result.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
  status [runId]           Inspect the current status of a workflow Run
  resume [runId]           Resume an interrupted workflow Run and reconcile executions
  stop [runId]             Stop active executions and pause a workflow Run
  dispatch [runId]         Dispatch a specialist role task with instructions
  submit-result            Submit structured result for an assigned role task
  release [runId]          Release resources and verify termination for a completed or finalized Run

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

Resume Options:
  --run <runId>            Run identifier to resume (defaults to latest)
  --config <path>          Path to workflow configuration file

Stop Options:
  --run <runId>            Run identifier to stop (defaults to latest)
  --config <path>          Path to workflow configuration file
  --reason <reason>        Explanation for stopping the Run

Dispatch Options:
  --run <runId>            Target workflow Run identifier (or positional arg)
  --instructions <text>    Task-specific instructions for the specialist role
  --instructions-file <file> Path to file containing task instructions

Submit-Result Options:
  --run <runId>            Target workflow Run identifier
  --task <taskId>          Task identifier bound to the attempt
  --outcome <outcome>      Submitted outcome (e.g. completed, blocked)
  --summary <summary>      Summary of work performed
  --artifacts <json>       JSON string of produced artifacts
  --artifacts-file <file>  Path to JSON file containing produced artifacts

Release Options:
  --run <runId>            Run identifier to release (defaults to latest)
  --config <path>          Path to workflow configuration file
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
        const { values, positionals } = parseArgs({
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

        const targetRunId = values.run || positionals[0];
        const statusResult = await engine.status(
          targetRunId
            ? { runId: targetRunId, configPath: values.config, detailed: values.detailed }
            : { configPath: values.config, detailed: values.detailed },
        );

        stdout(JSON.stringify(statusResult, null, 2));
        return 0;
      }

      case 'stop': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            config: { type: 'string' },
            reason: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        const targetRunId = values.run || positionals[0];
        const res = await engine.stop({
          runId: targetRunId,
          configPath: values.config,
          reason: values.reason,
        });

        stdout(JSON.stringify(res, null, 2));
        return res.stopped ? 0 : 1;
      }

      case 'resume':
      case 'recover': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            config: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        const targetRunId = values.run || positionals[0];
        const res = await engine.resume(
          targetRunId
            ? { runId: targetRunId, configPath: values.config }
            : values.config
              ? { configPath: values.config }
              : undefined,
        );

        stdout(
          JSON.stringify(
            {
              run_id: res.runId,
              repository: res.repository,
              issue: res.issue,
              status: res.status,
              step: res.currentStep,
              worktree: res.worktreePath,
              events_count: res.eventsCount,
              reconciled_task: res.reconciledTask
                ? {
                    task_id: res.reconciledTask.taskId,
                    step: res.reconciledTask.step,
                    role: res.reconciledTask.role,
                    execution_status: res.reconciledTask.executionStatus,
                    action: res.reconciledTask.action,
                    handle: res.reconciledTask.handle,
                    error: res.reconciledTask.error,
                    outcome: res.reconciledTask.result?.outcome,
                  }
                : undefined,
              message: res.message,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      case 'dispatch': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            instructions: { type: 'string' },
            'instructions-file': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        const targetRunId = values.run || positionals[0];
        let runId = targetRunId;
        if (!runId) {
          // Fall back to status run resolution to find latest
          const latestStatus = await engine.status();
          runId = latestStatus.run_id;
        }

        let taskInstructions = '';
        if (values['instructions-file']) {
          const resolvedPath = path.resolve(cwd, values['instructions-file']);
          try {
            taskInstructions = await fs.readFile(resolvedPath, 'utf8');
          } catch {
            stderr(`Error: Instructions file not found at: ${resolvedPath}`);
            return 1;
          }
        } else if (values.instructions) {
          taskInstructions = values.instructions;
        }

        if (!taskInstructions.trim()) {
          stderr('Error: Task instructions are required. Use --instructions <text> or --instructions-file <file>.');
          return 1;
        }

        const dispatchResult = await engine.dispatch(runId, taskInstructions);
        stdout(JSON.stringify(dispatchResult, null, 2));
        return 0;
      }

      case 'submit-result': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            task: { type: 'string' },
            outcome: { type: 'string' },
            summary: { type: 'string' },
            artifacts: { type: 'string' },
            'artifacts-file': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        if (!values.run) {
          stderr('Error: Run identifier is required. Use --run <runId>.');
          return 1;
        }
        if (!values.task) {
          stderr('Error: Task identifier is required. Use --task <taskId>.');
          return 1;
        }
        if (!values.outcome) {
          stderr('Error: Outcome is required. Use --outcome <outcome>.');
          return 1;
        }
        if (!values.summary) {
          stderr('Error: Summary is required. Use --summary <summary>.');
          return 1;
        }

        let artifacts: Record<string, unknown> = {};
        if (values['artifacts-file']) {
          const resolvedPath = path.resolve(cwd, values['artifacts-file']);
          try {
            const raw = await fs.readFile(resolvedPath, 'utf8');
            artifacts = JSON.parse(raw);
          } catch (err) {
            stderr(`Error: Failed to read artifacts file at ${resolvedPath}: ${(err as Error).message}`);
            return 1;
          }
        } else if (values.artifacts) {
          try {
            artifacts = JSON.parse(values.artifacts);
          } catch (err) {
            stderr(`Error: Invalid JSON in --artifacts: ${(err as Error).message}`);
            return 1;
          }
        }

        const submitResponse = await engine.submitResult(values.run, values.task, {
          outcome: values.outcome,
          summary: values.summary,
          artifacts,
        });

        stdout(JSON.stringify(submitResponse, null, 2));
        return 0;
      }

      case 'release': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            config: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        const targetRunId = values.run || positionals[0];
        let runId = targetRunId;
        if (!runId) {
          const latestStatus = await engine.status({ configPath: values.config });
          runId = latestStatus.run_id;
        }

        const res = await engine.releaseRunResources(runId);
        stdout(JSON.stringify(res, null, 2));
        return res.released ? 0 : 1;
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
