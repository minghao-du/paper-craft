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
  buildCleanupReceiptArtifacts,
  buildMarkdownReceipt,
  buildPrepareReceiptArtifacts,
  CompactReceiptReport,
  formatPrepareSummary,
  loadEnvelope,
  mapCleanupResultToExternalReport,
  mapPreparedWorkspaceToResult,
  mapToCleanupRequest,
  mapToPrepareRequest,
  RawPrepareCliArgs,
  resolvePrepareIssueIds,
  WorkspaceTaskInput,
} from './task-io.js';
import { WorkspaceError } from './types.js';
import { verifyAssignedEnvironment } from './verify.js';

interface CliArgs {
  subcommand?: 'prepare' | 'cleanup' | 'verify';
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
  repository?: string;
  detached?: boolean;
  cleanliness?: string;
}

class CliUsageError extends Error {}

type StringOptionKey = Exclude<keyof CliArgs, 'subcommand' | 'issue' | 'outputFormat' | 'cleanupFlag' | 'detached'>;

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
  '--repository': 'repository',
  '--cleanliness': 'cleanliness',
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
    if (argv[0] !== 'prepare' && argv[0] !== 'cleanup' && argv[0] !== 'verify') {
      throw new CliUsageError(`Unknown subcommand '${argv[0]}'. Expected 'prepare', 'cleanup', or 'verify'.`);
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

    if (arg === '--cleanup' || arg === '--detached') {
      if (seen.has(canonical)) throw new CliUsageError(`Duplicate option '${arg}'.`);
      seen.add(canonical);
      if (arg === '--cleanup') args.cleanupFlag = true;
      else args.detached = true;
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
  if (args.subcommand === 'verify') {
    const allowed = new Set(['--repo-dir', '--repository', '--base-remote', '--branch', '--detached', '--commit', '--cleanliness', '--input-envelope']);
    const invalid = [...seen].find((option) => !allowed.has(option));
    if (invalid) throw new CliUsageError(`Option '${invalid}' is unavailable for 'verify'.`);
    if (args.branch !== undefined && args.detached) {
      throw new CliUsageError("Choose either '--branch' or '--detached' for 'verify'.");
    }
    if (args.cleanliness !== 'clean' && args.cleanliness !== 'allow-dirty') {
      throw new CliUsageError("Verify requires '--cleanliness clean' or '--cleanliness allow-dirty'.");
    }
    if (args.inputEnvelope && [...seen].some((option) => option !== '--input-envelope' && option !== '--cleanliness')) {
      throw new CliUsageError("With '--input-envelope', supply only '--cleanliness' for 'verify'.");
    }
  } else if (args.repository !== undefined || args.detached || args.cleanliness !== undefined) {
    throw new CliUsageError("'--repository', '--detached', and '--cleanliness' are options for 'verify'.");
  }

  return { args, help: false };
}

function printHelp(): void {
  console.log(`Usage: pc-workspace <prepare|cleanup|verify> [options]

Subcommands:
  prepare                   Prepare or validate a feature or detached worktree
  cleanup                   Clean explicitly assigned worktrees and merged branches
  verify                    Verify the assigned checkout using local, read-only Git checks

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

Verify:
  --input-envelope <path>   Read the assignment from an envelope, or select the checkout with --repo-dir
  --repository <owner/repo> Expected repository for direct verification
  --branch <name>           Expected branch for direct verification
  --detached                Expect detached HEAD for direct verification
  --commit <sha>            Expected full HEAD SHA for direct verification
  --cleanliness <policy>    Required, either clean or allow-dirty
`);
}

function runVerify(args: CliArgs, envelope?: WorkspaceTaskInput): number {
  const assignment = envelope?.environment;
  const params = envelope?.inputs?.parameters;
  const repository = assignment?.repository ?? assignment?.delivery_target ?? args.repository;
  // Existing dispatch records unassigned revisions with two JSON nulls.
  const branch = assignment?.branch === null && assignment.commit == null ? undefined : assignment?.branch;
  try {
    const verified = verifyAssignedEnvironment({
      workingDirectory: assignment?.working_directory ?? args.repoDir ?? process.cwd(),
      repository: assignment && repository === 'local/repo' ? undefined : repository,
      baseRemote: assignment?.base_remote ??
        (typeof params?.base_remote === 'string' ? params.base_remote : args.baseRemote),
      branch: assignment ? branch : args.detached ? null : args.branch,
      commit: assignment?.commit ?? args.commit,
      requireClean: args.cleanliness === 'clean',
    });
    console.log(JSON.stringify({
      working_directory: verified.workingDirectory,
      repository: verified.repository,
      base_remote: verified.baseRemote,
      branch: verified.branch,
      commit: verified.commit,
    }, null, 2));
    return 0;
  } catch (err) {
    console.error(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof WorkspaceError ? { code: err.code, details: err.details } : {}),
    }));
    return 1;
  }
}

interface DeliverCommandReportOptions {
  status: 'succeeded' | 'blocked';
  result: Record<string, unknown>;
  summary: string;
  receiptPath?: string;
  outputFormat: 'raw' | 'compact';
  artifacts: Record<string, unknown>;
  created: boolean;
  logicalStage: string;
  isCleanup?: boolean;
  envelope?: WorkspaceTaskInput;
  rootIssueId?: string;
  currentIssueId?: string;
  errorMessage?: string;
  receiptSubject: string;
  failedSummaryPrefix: string;
  suppressRawOnBlocked?: boolean;
}

/**
 * Persist optional Markdown receipt, emit compact/raw JSON report, and return exit code.
 */
function deliverCommandReport(opts: DeliverCommandReportOptions): number {
  const compactReport: CompactReceiptReport = {
    execution_status: opts.status,
    result: opts.result,
    receipt_path: opts.receiptPath || '',
    summary: opts.summary,
  };

  let receiptWriteFailed = false;
  if (opts.receiptPath) {
    try {
      const receiptContent = buildMarkdownReceipt({
        status: opts.status,
        compactReport,
        artifacts: opts.artifacts,
        created: opts.created,
        logicalStage: opts.logicalStage,
        isCleanup: opts.isCleanup,
        envelope: opts.envelope,
        rootIssueId: opts.rootIssueId,
        currentIssueId: opts.currentIssueId,
        summary: opts.summary,
        errorMessage: opts.errorMessage,
      });
      atomicWriteText(opts.receiptPath, receiptContent);
    } catch (receiptErr) {
      receiptWriteFailed = true;
      console.error(
        `Failed to write ${opts.receiptSubject} receipt to ${opts.receiptPath}: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`,
      );
    }
  }

  if (receiptWriteFailed) {
    // Section 7.4: emit failed execution_status in compact report, keep real result, exit non-zero
    const failedReport: CompactReceiptReport = {
      execution_status: 'failed',
      result: opts.result,
      receipt_path: opts.receiptPath || '',
      summary: `${opts.failedSummaryPrefix}: ${opts.summary}`,
    };
    if (opts.outputFormat === 'compact') {
      console.log(JSON.stringify(failedReport, null, 2));
    } else if (!opts.suppressRawOnBlocked || opts.status === 'succeeded') {
      console.log(JSON.stringify(opts.result, null, 2));
    }
    return 1;
  }

  if (opts.outputFormat === 'compact') {
    console.log(JSON.stringify(compactReport, null, 2));
  } else if (!opts.suppressRawOnBlocked || opts.status === 'succeeded') {
    console.log(JSON.stringify(opts.result, null, 2));
  }

  return opts.status === 'succeeded' ? 0 : 1;
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
  const logicalStage = taskSection.logical_stage || 'workspace_prepare';
  const { rootIssueId, currentIssueId } = resolvePrepareIssueIds(request.target, envelope);

  try {
    const prepared = prepare(request);
    const summary = formatPrepareSummary(prepared, request.target);

    return deliverCommandReport({
      status: 'succeeded',
      result: mapPreparedWorkspaceToResult(prepared),
      summary,
      receiptPath,
      outputFormat,
      artifacts: buildPrepareReceiptArtifacts({
        status: 'succeeded',
        prepared,
        receiptPath,
      }),
      created: prepared.disposition === 'created',
      logicalStage,
      envelope,
      rootIssueId,
      currentIssueId,
      receiptSubject: 'workspace',
      failedSummaryPrefix: 'Workspace prepared successfully but receipt writing failed',
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Worktree preparation blocked. ${errMsg}`);
    const summary = `Worktree preparation blocked: ${errMsg}`;
    const result: Record<string, unknown> = { error: errMsg, stage: 'workspace_prepare' };
    if (err instanceof WorkspaceError && err.code === 'UNCLEAN_CHECKOUT') {
      const { directory, status } = err.details ?? {};
      if (typeof directory === 'string' && typeof status === 'string') {
        result.code = err.code;
        result.details = { directory, status };
      }
    }

    return deliverCommandReport({
      status: 'blocked',
      result,
      summary,
      receiptPath,
      outputFormat,
      artifacts: buildPrepareReceiptArtifacts({
        status: 'blocked',
        request,
        envelope,
        receiptPath,
      }),
      created: false,
      logicalStage,
      envelope,
      rootIssueId,
      currentIssueId,
      errorMessage: errMsg,
      receiptSubject: 'workspace',
      failedSummaryPrefix: 'Worktree preparation blocked and receipt writing failed',
      suppressRawOnBlocked: true,
    });
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
    summary = `Confirmed ${externalReport.removed_paths.length} worktrees absent. Retained ${externalReport.retained_paths.length} candidates.`;
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

  return deliverCommandReport({
    status,
    result: externalReport as Record<string, unknown>,
    summary,
    receiptPath,
    outputFormat,
    artifacts: buildCleanupReceiptArtifacts({
      request,
      envelope,
      receiptPath,
    }),
    created: false,
    logicalStage: 'workspace_cleanup',
    isCleanup: true,
    envelope,
    rootIssueId: request.rootIssueId,
    errorMessage: status === 'blocked' ? summary : undefined,
    receiptSubject: 'cleanup',
    failedSummaryPrefix: 'Workspace cleanup executed but receipt writing failed',
  });
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
  if (subcommand === 'verify') {
    return runVerify(args, envelope);
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
