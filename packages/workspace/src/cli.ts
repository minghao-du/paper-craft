#!/usr/bin/env node
/**
 * Workspace CLI entry point.
 *
 * Implements Section 7 of WORKSPACE_TYPESCRIPT_REFACTOR_PLAN.md.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './cleanup.js';
import { prepare } from './prepare.js';
import {
  atomicWriteText,
  buildMarkdownReceipt,
  CompactReceiptReport,
  loadEnvelope,
  mapCleanupResultToExternalReport,
  mapPreparedWorkspaceToResult,
  mapToCleanupRequest,
  mapToPrepareRequest,
  RawPrepareCliArgs,
  WorkspaceTaskInput,
} from './task-io.js';

interface CliArgs {
  subcommand?: 'prepare' | 'cleanup';
  repoDir?: string;
  issue?: number;
  branch?: string;
  worktree?: string;
  commit?: string;
  expectedHead?: string;
  workspaceConfig?: string;
  base?: string;
  deliveryTarget?: string;
  baseRemote?: string;
  pushRemote?: string;
  worktreeContainer?: string;
  receiptPath?: string;
  outputFormat?: 'raw' | 'compact';
  inputEnvelope?: string;
  cleanupFlag?: boolean;
}

class CliUsageError extends Error {}

type StringOptionKey = Exclude<keyof CliArgs, 'subcommand' | 'issue' | 'outputFormat' | 'cleanupFlag'>;

const STRING_OPTIONS: Record<string, StringOptionKey> = {
  '--repo-dir': 'repoDir',
  '--branch': 'branch',
  '--worktree': 'worktree',
  '--commit': 'commit',
  '--expected-head': 'expectedHead',
  '--workspace-config': 'workspaceConfig',
  '--base': 'base',
  '--delivery-target': 'deliveryTarget',
  '--base-remote': 'baseRemote',
  '--push-remote': 'pushRemote',
  '--worktree-container': 'worktreeContainer',
  '--receipt-path': 'receiptPath',
  '--input-envelope': 'inputEnvelope',
  '--input': 'inputEnvelope', // documented alias of --input-envelope
};

function parseIssueNumber(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliUsageError(`Invalid --issue value '${value}': expected a positive integer.`);
  }
  const issue = Number(value);
  if (!Number.isSafeInteger(issue)) {
    throw new CliUsageError(`Invalid --issue value '${value}': out of safe integer range.`);
  }
  return issue;
}

/**
 * Strictly parse argv. Pure: no Git, filesystem, or process side effects.
 * Returns `help: true` when -h/--help is present (help wins over other errors).
 */
function parseCliArgs(argv: string[]): { args: CliArgs; help: boolean } {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { args: {}, help: true };
  }

  const args: CliArgs = {};
  const seen = new Set<string>();
  let i = 0;

  if (argv.length > 0 && !argv[0].startsWith('-')) {
    if (argv[0] !== 'prepare' && argv[0] !== 'cleanup') {
      throw new CliUsageError(`Unknown subcommand '${argv[0]}'. Expected 'prepare' or 'cleanup'.`);
    }
    args.subcommand = argv[0];
    i = 1;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      throw new CliUsageError(`Unexpected argument '${arg}'.`);
    }

    // Canonical identity for duplicate detection (aliases collapse together).
    const canonical = arg === '--input' ? '--input-envelope' : arg;

    if (arg === '--cleanup') {
      if (seen.has(canonical)) throw new CliUsageError(`Duplicate option '${arg}'.`);
      seen.add(canonical);
      args.cleanupFlag = true;
      i++;
      continue;
    }

    const isString = Object.prototype.hasOwnProperty.call(STRING_OPTIONS, arg);
    if (!isString && arg !== '--issue' && arg !== '--output-format') {
      throw new CliUsageError(`Unknown option '${arg}'.`);
    }
    if (seen.has(canonical)) {
      throw new CliUsageError(`Duplicate or conflicting option '${arg}'.`);
    }
    seen.add(canonical);

    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new CliUsageError(`Option '${arg}' requires a value.`);
    }

    if (arg === '--issue') {
      args.issue = parseIssueNumber(value);
    } else if (arg === '--output-format') {
      if (value !== 'raw' && value !== 'compact') {
        throw new CliUsageError(`Invalid --output-format '${value}': expected 'raw' or 'compact'.`);
      }
      args.outputFormat = value;
    } else {
      args[STRING_OPTIONS[arg]] = value;
    }
    i += 2;
  }

  if (args.subcommand === 'prepare' && args.cleanupFlag) {
    throw new CliUsageError("Conflicting arguments: 'prepare' subcommand with --cleanup.");
  }

  return { args, help: false };
}

function printHelp(): void {
  console.log(`Usage: pc-workspace <prepare|cleanup> [options]

Subcommands:
  prepare                   Prepare or validate a feature or detached worktree
  cleanup                   Clean explicitly assigned worktrees and merged branches

Options:
  --repo-dir <path>         Existing checkout directory (defaults to '.')
  --issue <num>             Positive issue number for default branch and path names
  --branch <name>           Feature branch name
  --worktree <path>         Explicit worktree path
  --commit <sha>            Commit SHA for detached worktree
  --expected-head <sha>     Predecessor commit for rework (requires existing worktree)
  --workspace-config <path> Explicit workspace config JSON file
  --base <branch>           Mainline base branch
  --delivery-target <repo>  Delivery target repository (owner/repo)
  --base-remote <remote>    Mainline base remote (e.g. origin, upstream)
  --push-remote <remote>    Feature push remote (e.g. origin)
  --worktree-container <p>  Container directory for disposable worktrees
  --input-envelope <path>   Task Input Envelope JSON (<step>-input.json)
  --receipt-path <path>     Path to write Markdown receipt
  --output-format <format>  Output format: raw or compact
`);
}

async function runPrepare(
  args: CliArgs,
  envelope?: WorkspaceTaskInput,
): Promise<number> {
  let mapped;
  try {
    mapped = mapToPrepareRequest(args as RawPrepareCliArgs, envelope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Worktree preparation blocked. ${msg}`);
    return 1;
  }

  const { request, receiptPath, outputFormat } = mapped;
  const taskSection = envelope?.task ?? {};
  const currentIssueId = String(
    taskSection.current_issue_id ??
      (request.target.kind === 'issue' ? request.target.issue : 'N/A'),
  );

  let envResult: Record<string, unknown>;
  let created: boolean;
  let summary: string;
  let receiptWriteFailed = false;

  try {
    const prepared = prepare(request);
    created = prepared.disposition === 'created';
    envResult = mapPreparedWorkspaceToResult(prepared);

    if (created) {
      if (currentIssueId !== 'N/A') {
        summary = `Prepared feature worktree for issue ${currentIssueId} at ${prepared.path}`;
      } else if (prepared.branch) {
        summary = `Prepared feature worktree on branch '${prepared.branch}' at ${prepared.path}`;
      } else {
        summary = `Prepared detached worktree at ${prepared.path} pinned to commit ${prepared.commit}`;
      }
    } else {
      summary = `Reused existing worktree at ${prepared.path} with commit ${prepared.commit}`;
    }

    const compactReport: CompactReceiptReport = {
      execution_status: 'succeeded',
      result: envResult,
      receipt_path: receiptPath || '',
      summary,
    };

    if (receiptPath) {
      try {
        const receiptContent = buildMarkdownReceipt({
          status: 'succeeded',
          compactReport,
          artifacts: {
            working_directory: prepared.path,
            repository: prepared.repository,
            delivery_target: prepared.deliveryTarget,
            base_remote: prepared.baseRemote,
            push_remote: prepared.pushRemote,
            worktree: prepared.path,
            baseBranch: prepared.baseBranch,
            branch: prepared.branch,
            commit: prepared.commit,
            environment_receipt: receiptPath,
          },
          created,
          logicalStage: taskSection.logical_stage || 'workspace_prepare',
          envelope,
          rootIssueId: taskSection.root_issue_id ? String(taskSection.root_issue_id) : undefined,
          currentIssueId,
          summary,
        });
        atomicWriteText(receiptPath, receiptContent);
      } catch (receiptErr) {
        receiptWriteFailed = true;
        console.error(
          `Failed to write workspace receipt to ${receiptPath}: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`,
        );
      }
    }

    if (receiptWriteFailed) {
      // Section 7.4: emit failed execution_status in compact report, keep real result, exit non-zero
      const failedReport: CompactReceiptReport = {
        execution_status: 'failed',
        result: envResult,
        receipt_path: receiptPath || '',
        summary: `Workspace prepared successfully but receipt writing failed: ${summary}`,
      };
      if (outputFormat === 'compact') {
        console.log(JSON.stringify(failedReport, null, 2));
      } else {
        console.log(JSON.stringify(envResult, null, 2));
      }
      return 1;
    }

    if (outputFormat === 'compact') {
      console.log(JSON.stringify(compactReport, null, 2));
    } else {
      console.log(JSON.stringify(envResult, null, 2));
    }
    return 0;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Worktree preparation blocked. ${errMsg}`);

    const errResult = {
      error: errMsg,
      stage: 'workspace_prepare',
    };
    const compactReport: CompactReceiptReport = {
      execution_status: 'blocked',
      result: errResult,
      receipt_path: receiptPath || '',
      summary: `Worktree preparation blocked: ${errMsg}`,
    };

    if (receiptPath) {
      try {
        const receiptContent = buildMarkdownReceipt({
          status: 'blocked',
          compactReport,
          artifacts: {
            working_directory: String(args.worktree || 'N/A'),
            repository: String(args.deliveryTarget || 'N/A'),
            delivery_target: String(args.deliveryTarget || 'N/A'),
            base_remote: String(args.baseRemote || 'origin'),
            push_remote: String(args.pushRemote || 'origin'),
            worktree: String(args.worktree || 'N/A'),
            baseBranch: String(args.base || 'N/A'),
            branch: args.branch ?? null,
            commit: args.commit ?? 'N/A',
            environment_receipt: receiptPath,
          },
          created: false,
          logicalStage: taskSection.logical_stage || 'workspace_prepare',
          envelope,
          rootIssueId: taskSection.root_issue_id ? String(taskSection.root_issue_id) : undefined,
          currentIssueId,
          summary: `Worktree preparation blocked: ${errMsg}`,
          errorMessage: errMsg,
        });
        atomicWriteText(receiptPath, receiptContent);
      } catch {
        /* ignore secondary receipt write error */
      }
    }

    if (outputFormat === 'compact') {
      console.log(JSON.stringify(compactReport, null, 2));
    }
    return 1;
  }
}

async function runCleanup(
  args: CliArgs,
  envelope?: WorkspaceTaskInput,
): Promise<number> {
  if (!envelope) {
    console.error('Cleanup requires --input-envelope with task inputs.');
    return 1;
  }

  let mapped;
  try {
    mapped = mapToCleanupRequest(envelope, {
      repoDir: args.repoDir,
      receiptPath: args.receiptPath,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Workspace cleanup blocked. ${msg}`);
    return 1;
  }

  const { request, receiptPath } = mapped;
  const outputFormat = args.outputFormat ?? (args.inputEnvelope || receiptPath ? 'compact' : 'raw');

  let status: 'succeeded' | 'blocked' = 'succeeded';
  let externalReport;
  let summary: string;

  try {
    const cleanupResult = cleanup(request);
    externalReport = mapCleanupResultToExternalReport(cleanupResult);
    summary = `Removed ${externalReport.removed_paths.length} worktrees; retained ${externalReport.retained_paths.length} candidates.`;
  } catch (err) {
    status = 'blocked';
    const errMsg = err instanceof Error ? err.message : String(err);
    externalReport = {
      outcome: 'incomplete',
      removed_paths: [],
      retained_paths: [],
      removed_branches: [],
      retained_branches: [],
      error: errMsg,
    };
    summary = `Workspace cleanup blocked: ${errMsg}`;
    console.error(summary);
  }

  const compactReport: CompactReceiptReport = {
    execution_status: status,
    result: externalReport as Record<string, unknown>,
    receipt_path: receiptPath || '',
    summary,
  };

  let receiptWriteFailed = false;
  if (receiptPath) {
    try {
      const receiptContent = buildMarkdownReceipt({
        status,
        compactReport,
        artifacts: {},
        created: false,
        logicalStage: 'workspace_cleanup',
        isCleanup: true,
        envelope,
        rootIssueId: request.rootIssueId,
        summary,
        errorMessage: status === 'blocked' ? summary : undefined,
      });
      atomicWriteText(receiptPath, receiptContent);
    } catch (err) {
      receiptWriteFailed = true;
      console.error(
        `Failed to write cleanup receipt to ${receiptPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (receiptWriteFailed) {
    const failedReport: CompactReceiptReport = {
      execution_status: 'failed',
      result: externalReport as Record<string, unknown>,
      receipt_path: receiptPath || '',
      summary: `Workspace cleanup executed but receipt writing failed: ${summary}`,
    };
    if (outputFormat === 'compact') {
      console.log(JSON.stringify(failedReport, null, 2));
    } else {
      console.log(JSON.stringify(externalReport, null, 2));
    }
    return 1;
  }

  if (outputFormat === 'compact') {
    console.log(JSON.stringify(compactReport, null, 2));
  } else {
    console.log(JSON.stringify(externalReport, null, 2));
  }

  return status === 'succeeded' ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      printHelp();
      return 0;
    }
    args = parsed.args;
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(`${err.message}\nRun 'pc-workspace --help' for usage.`);
      return 2;
    }
    throw err;
  }

  let envelope: WorkspaceTaskInput | undefined;
  if (args.inputEnvelope) {
    try {
      envelope = loadEnvelope(args.inputEnvelope);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      return 1;
    }
  }

  // Determine effective subcommand
  let subcommand = args.subcommand;
  if (!subcommand) {
    if (args.cleanupFlag || envelope?.task?.logical_stage === 'workspace_cleanup') {
      subcommand = 'cleanup';
    } else {
      subcommand = 'prepare';
    }
  }

  if (subcommand === 'cleanup') {
    return runCleanup(args, envelope);
  }
  return runPrepare(args, envelope);
}

const isDirectRun =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
    process.argv[1].endsWith('packages/workspace/src/cli.ts') ||
    process.argv[1].endsWith('packages/workspace/src/cli.js'));

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
