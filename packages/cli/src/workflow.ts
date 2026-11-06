/**
 * @fileoverview CLI commands for workflow lifecycle using Run:
 * init, open (start), observe (status), dispatch, submit-result, stop, resume, finish (release).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { Run } from '../../core/src/workflow/run.js';
import { WorkflowFiles } from '../../core/src/workflow/files.js';
import { initWorkflowConfig } from '../../core/src/workflow/config.js';
import type { AgentExecutor } from '../../core/src/workflow/types.js';
import type { WorkflowEngine } from '../../core/src/workflow/engine.js';

/**
 * Execution context for invoking workflow CLI commands programmatically.
 */
export interface CliContext {
  /** Working directory for CLI commands. Defaults to process.cwd(). */
  cwd?: string;
  /** Custom standard output sink. */
  stdout?: (msg: string) => void;
  /** Custom standard error sink. */
  stderr?: (msg: string) => void;
  /** Optional custom AgentExecutor instance. */
  executor?: AgentExecutor;
  /** Optional pre-configured Run instance. */
  run?: Run;
  /** Optional WorkflowEngine instance for testing and dependency injection. */
  engine?: WorkflowEngine;
}

const USAGE_HELP = `
Usage: pc workflow <command> [options]

Commands:
  init                     Scaffold default workflow configuration (.pc-workflow.yml)
  open <issue>             Open or allocate a workflow Run (alias: start)
  observe [runId]          Inspect status and execution of a workflow Run (alias: status)
  dispatch [runId]         Dispatch an isolated task with contract-bound instructions
  submit-result            Submit structured result for an assigned task
  stop [runId]             Stop active executions and pause a workflow Run
  resume [runId]           Resume and reconcile an existing workflow Run
  finish [runId]           Complete Run and safely retire resources (alias: release)

Global Options:
  -h, --help               Show help information
  -v, --version            Show version information

Init Options:
  --config <path>          Path where configuration should be written
  --repo <owner/repo>      GitHub repository slug
  --worktree-root <dir>    Directory for execution worktrees (default: .worktrees)
  --provider <provider>    Agent execution provider (default: agy)

Open / Start Options:
  --config <path>          Path to workflow configuration file
  --provider <provider>    Provider override (default: agy)
  --goal <text>            Run objective or goal
  --requirements <text>    Immutable shared requirements text
  --requirements-file <file> Path to UTF-8 file containing shared requirements

Observe / Status Options:
  --run <runId>            Run identifier to inspect (defaults to latest)
  --task <taskId>          Specific task identifier to inspect
  --detailed               Show full structured context and telemetry

Dispatch Options:
  --run <runId>            Target workflow Run identifier (or positional arg)
  --task-type <type>       Formal task type (default: pc-issue-work)
  --instructions <text>    Task-specific instructions
  --instructions-file <file> Path to file containing task instructions
  --inputs <json>          JSON string of task inputs
  --inputs-file <file>     Path to JSON file containing task inputs
  --predecessor <taskId>   Predecessor task ID to link findings from
  --worktree <path>        Worktree path override

Submit-Result Options:
  --run <runId>            Target workflow Run identifier
  --task <taskId>          Task identifier bound to the attempt
  --outcome <outcome>      Submitted outcome (e.g. completed, blocked, direct, decomposed, verified, rework_needed, recorded)
  --summary <summary>      Summary of work performed
  --artifacts <json>       JSON string of produced artifacts
  --artifacts-file <file>  Path to JSON file containing produced artifacts

Stop Options:
  --run <runId>            Run identifier to stop (defaults to latest)
  --reason <reason>        Explanation for stopping the Run

Resume Options:
  --run <runId>            Run identifier to resume (defaults to latest)

Finish / Release Options:
  --run <runId>            Run identifier to finish (defaults to latest)
  --conclusion <text>      Summary conclusion for completion
  --evidence <json>        JSON array of evidence references
`.trim();

/**
 * Resolves the latest Run identifier from the local storage root.
 */
async function resolveLatestRunId(cwd: string): Promise<string> {
  const storageRoot = path.join(cwd, '.paper-craft', 'cache');
  const files = new WorkflowFiles(storageRoot);
  const runIds = await files.listRunIds();
  if (runIds.length === 0) {
    throw new Error('No workflow runs found.');
  }
  runIds.sort().reverse();
  return runIds[0];
}

/**
 * Executes a workflow CLI command using Run.
 * @returns Process exit code (0 for success, non-zero for error).
 */
export async function runCli(argv: string[], ctx?: CliContext): Promise<number> {
  const stdout = ctx?.stdout ?? ((msg: string) => console.log(msg));
  const stderr = ctx?.stderr ?? ((msg: string) => console.error(msg));
  const cwd = ctx?.cwd ?? process.cwd();

  // Normalize args: strip leading 'pc' or 'workflow' if passed
  const args = [...argv];
  if (args[0] === 'pc') {
    args.shift();
  }
  if (args[0] === 'workflow') {
    args.shift();
  }

  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    stdout(USAGE_HELP);
    return 0;
  }

  // Resolve executor from context or engine if available
  const executor = ctx?.executor ?? (ctx?.engine as { executor?: AgentExecutor } | undefined)?.executor;

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

        const res = await initWorkflowConfig(cwd, {
          configPath: values.config,
          repository: values.repo,
          worktreeRoot: values['worktree-root'],
          provider: values.provider,
        });

        stdout(`Initialized workflow configuration at: ${res.configPath}`);
        return 0;
      }

      case 'open':
      case 'start': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            config: { type: 'string' },
            provider: { type: 'string' },
            goal: { type: 'string' },
            requirements: { type: 'string' },
            'requirements-file': { type: 'string' },
            repo: { type: 'string' },
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

        let goal = values.goal ?? values.requirements;
        if (values['requirements-file']) {
          const reqPath = path.resolve(cwd, values['requirements-file']);
          try {
            goal = await fs.readFile(reqPath, 'utf8');
          } catch {
            stderr(`Error: Requirements file not found at: ${reqPath}`);
            return 1;
          }
        }

        // Try reading repository from .pc-workflow.yml if not explicitly supplied
        let repository = values.repo;
        if (!repository) {
          try {
            const configPath = path.join(cwd, '.pc-workflow.yml');
            const raw = await fs.readFile(configPath, 'utf8');
            const match = raw.match(/repository:\s*([^\s\n]+)/);
            if (match) {
              repository = match[1];
            }
          } catch {
            // No config yet
          }
        }

        const run =
          ctx?.run ??
          (await Run.open({
            issue: issueNumber,
            goal,
            repository,
            repoRoot: cwd,
            provider: values.provider,
            executor,
          }));

        const obs = await run.observe();

        stdout(
          JSON.stringify(
            {
              run_id: run.runId,
              repository: obs.snapshot.repository ?? repository,
              issue: obs.snapshot.issue ?? issueNumber,
              status: obs.status,
              worktree: run.worktreePath,
              provider: obs.snapshot.provider ?? values.provider ?? 'agy',
            },
            null,
            2,
          ),
        );
        return 0;
      }

      case 'observe':
      case 'status': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            task: { type: 'string' },
            detailed: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        let targetRunId = values.run || positionals[0];
        if (!targetRunId) {
          targetRunId = await resolveLatestRunId(cwd);
        }

        const run =
          ctx?.run && ctx.run.runId === targetRunId
            ? ctx.run
            : await Run.open({
                runId: targetRunId,
                repoRoot: cwd,
                executor,
              });

        const obs = await run.observe(values.task);

        if (values.detailed) {
          stdout(JSON.stringify(obs, null, 2));
        } else {
          stdout(
            JSON.stringify(
              {
                run_id: obs.runId,
                status: obs.status,
                issue: obs.snapshot.issue,
                repository: obs.snapshot.repository,
                worktree: obs.snapshot.worktreePath,
                active_task_id: obs.activeTaskId,
                execution: obs.execution,
                result: obs.result,
                has_submitted_result: obs.hasSubmittedResult,
              },
              null,
              2,
            ),
          );
        }
        return 0;
      }

      case 'dispatch': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            'task-type': { type: 'string' },
            instructions: { type: 'string' },
            'instructions-file': { type: 'string' },
            inputs: { type: 'string' },
            'inputs-file': { type: 'string' },
            predecessor: { type: 'string' },
            worktree: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        let targetRunId = values.run || positionals[0];
        if (!targetRunId) {
          targetRunId = await resolveLatestRunId(cwd);
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

        let inputs: Record<string, unknown> | undefined;
        if (values['inputs-file']) {
          const resolvedPath = path.resolve(cwd, values['inputs-file']);
          try {
            const raw = await fs.readFile(resolvedPath, 'utf8');
            inputs = JSON.parse(raw);
          } catch (err) {
            stderr(`Error: Failed to read inputs file at ${resolvedPath}: ${(err as Error).message}`);
            return 1;
          }
        } else if (values.inputs) {
          try {
            inputs = JSON.parse(values.inputs);
          } catch (err) {
            stderr(`Error: Invalid JSON in --inputs: ${(err as Error).message}`);
            return 1;
          }
        }

        const taskType = values['task-type'] ?? 'pc-issue-work';

        const run =
          ctx?.run && ctx.run.runId === targetRunId
            ? ctx.run
            : await Run.open({
                runId: targetRunId,
                repoRoot: cwd,
                executor,
              });

        const dispatchResult = await run.dispatch({
          taskType,
          instructions: taskInstructions,
          inputs,
          predecessorResultId: values.predecessor,
          worktreePath: values.worktree,
        });

        stdout(
          JSON.stringify(
            {
              taskId: dispatchResult.taskId,
              taskType: dispatchResult.taskType,
              status: dispatchResult.status,
              worktreePath: dispatchResult.worktreePath,
              handle: dispatchResult.handle,
              step: dispatchResult.taskType,
              role: dispatchResult.taskType,
            },
            null,
            2,
          ),
        );
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

        const run =
          ctx?.run && ctx.run.runId === values.run
            ? ctx.run
            : await Run.open({
                runId: values.run,
                repoRoot: cwd,
                executor,
              });

        const submitResult = await run.submitResult(values.task, {
          outcome: values.outcome,
          summary: values.summary,
          artifacts,
        });

        stdout(
          JSON.stringify(
            {
              acknowledged: submitResult.acknowledged,
              taskId: submitResult.taskId,
              outcome: submitResult.result.outcome,
              executionTerminated: true,
              result: submitResult.result,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      case 'stop': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            reason: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        let targetRunId = values.run || positionals[0];
        if (!targetRunId) {
          targetRunId = await resolveLatestRunId(cwd);
        }

        const run =
          ctx?.run && ctx.run.runId === targetRunId
            ? ctx.run
            : await Run.open({
                runId: targetRunId,
                repoRoot: cwd,
                executor,
              });

        const res = await run.stop(values.reason);
        stdout(JSON.stringify(res, null, 2));
        return res.stopped ? 0 : 1;
      }

      case 'resume':
      case 'recover': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        let targetRunId = values.run || positionals[0];
        if (!targetRunId) {
          targetRunId = await resolveLatestRunId(cwd);
        }

        const run =
          ctx?.run && ctx.run.runId === targetRunId
            ? ctx.run
            : await Run.open({
                runId: targetRunId,
                repoRoot: cwd,
                executor,
              });

        const obs = await run.observe();
        stdout(
          JSON.stringify(
            {
              run_id: run.runId,
              status: obs.status,
              active_task_id: obs.activeTaskId,
              execution: obs.execution,
              result: obs.result,
              has_submitted_result: obs.hasSubmittedResult,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      case 'finish':
      case 'release': {
        const { values, positionals } = parseArgs({
          args: args.slice(1),
          options: {
            run: { type: 'string' },
            conclusion: { type: 'string' },
            evidence: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
          },
          allowPositionals: true,
        });

        if (values.help) {
          stdout(USAGE_HELP);
          return 0;
        }

        let targetRunId = values.run || positionals[0];
        if (!targetRunId) {
          targetRunId = await resolveLatestRunId(cwd);
        }

        let evidence: string[] = [];
        if (values.evidence) {
          try {
            evidence = JSON.parse(values.evidence);
          } catch {
            evidence = [values.evidence];
          }
        }

        const run =
          ctx?.run && ctx.run.runId === targetRunId
            ? ctx.run
            : await Run.open({
                runId: targetRunId,
                repoRoot: cwd,
                executor,
              });

        const res = await run.finish({
          conclusion: values.conclusion ?? 'Run finished',
          evidence,
        });

        stdout(
          JSON.stringify(
            {
              runId: res.runId,
              completed: res.completed,
              released: res.worktreeRetired,
              status: res.status,
              conclusion: res.conclusion,
              evidence: res.evidence,
              worktreePath: res.worktreePath,
            },
            null,
            2,
          ),
        );
        return res.completed ? 0 : 1;
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
