/**
 * Envelope conversion, report mapping, and receipt generation.
 *
 * Implements Section 7 of WORKSPACE_TYPESCRIPT_REFACTOR_PLAN.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CleanupCandidate,
  CleanupRequest,
  CleanupResult,
  ExternalCleanupReport,
  PreparedWorkspace,
  PrepareRequest,
  PrepareTarget,
  TaskBranchCleanupCandidate,
  WorkspaceError,
  WorkspaceOverrides,
} from './types.js';
import { findRepoRoot, resolvePath } from './git.js';
import {
  parseTaskInputEnvelope,
  type TaskInputEnvelope as ProtocolTaskInputEnvelope,
} from '../../orchestrator/src/protocol/index.js';

/** @deprecated Use WorkspaceTaskInput (simplified) or the protocol TaskInputEnvelope (full). */
export type TaskInputEnvelope = WorkspaceTaskInput;

/**
 * Simplified, all-optional task input for the explicit/independent workspace
 * mapping functions. NOT the full versioned envelope: `--input-envelope`
 * files are validated against the protocol `TaskInputEnvelope` by
 * `loadEnvelope`, whose result is assignable to this type.
 */
export interface WorkspaceTaskInput {
  schema_version?: string;
  task?: {
    logical_stage?: string;
    step_index?: number;
    attempt?: number;
    root_issue_id?: string | number;
    current_issue_id?: string | number;
  };
  provider?: {
    type?: string;
    target?: string;
    args?: string[];
  };
  environment?: {
    working_directory?: string;
    repository?: string;
    delivery_target?: string;
    base_remote?: string;
    push_remote?: string;
    base_branch?: string;
    branch?: string | null;
    commit?: string | null;
  };
  inputs?: {
    objective?: string;
    scope?: string;
    acceptance_criteria?: string[];
    predecessor_receipts?: string[];
    parameters?: Record<string, unknown>;
  };
  contract?: {
    receipt_path?: string;
    receipt_template?: string;
  };
  budgets?: {
    delivery_attempts_used?: number;
    delivery_attempts_max?: number;
    replans_used?: number;
    replans_max?: number;
  };
}

export interface CompactReceiptReport {
  execution_status: 'succeeded' | 'blocked' | 'failed';
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
}

/**
 * Write file atomically with flush, fsync, and replace.
 */
export function atomicWriteText(filePath: string, content: string): void {
  const resolved = resolvePath(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(dir, `.${path.basename(resolved)}.tmp.${process.pid}.${Date.now()}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempFile, 'w');
    const toWrite = content.endsWith('\n') ? content : content + '\n';
    fs.writeSync(fd, toWrite);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempFile, resolved);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Normalize issue number from number or string representation (#79, issue-79, 79).
 */
export function normalizeIssue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    let clean = value.trim();
    if (clean.startsWith('#')) clean = clean.slice(1).trim();
    if (clean.startsWith('issue-')) clean = clean.slice(6).trim();
    if (/^\d+$/.test(clean)) {
      const n = parseInt(clean, 10);
      if (n > 0) return n;
    }
  }
  return null;
}

export interface RawPrepareCliArgs {
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
}

/**
 * Load a complete versioned Task Input Envelope and validate it through the
 * shared protocol entry.
 */
export function loadEnvelope(envelopePath: string): ProtocolTaskInputEnvelope {
  const absPath = resolvePath(envelopePath);
  if (!fs.existsSync(absPath)) {
    throw new WorkspaceError('INVALID_INPUT', `Input envelope not found: ${absPath}`);
  }
  try {
    return parseTaskInputEnvelope(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Invalid envelope at ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Compare two values and verify no business conflict.
 */
function assertNoConflict(name: string, cliVal: unknown, envVal: unknown, arePaths = false): void {
  if (cliVal === undefined || envVal === undefined || cliVal === null || envVal === null) return;
  if (arePaths) {
    if (resolvePath(String(cliVal)) !== resolvePath(String(envVal))) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Conflicting '${name}' specified: CLI provided '${cliVal}' but envelope specified '${envVal}'.`,
      );
    }
    return;
  }
  if (String(cliVal).trim() !== String(envVal).trim()) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Conflicting '${name}' specified: CLI provided '${cliVal}' but envelope specified '${envVal}'.`,
    );
  }
}

/**
 * Map CLI arguments and optional envelope to a PrepareRequest.
 */
export function mapToPrepareRequest(
  args: RawPrepareCliArgs,
  envelope?: WorkspaceTaskInput,
): {
  request: PrepareRequest;
  receiptPath?: string;
  outputFormat: 'raw' | 'compact';
} {
  const envSection = envelope?.environment ?? {};
  const taskSection = envelope?.task ?? {};
  const inputsSection = envelope?.inputs ?? {};
  const paramsSection = (inputsSection.parameters ?? {}) as Record<string, unknown>;
  const contractSection = envelope?.contract ?? {};

  // Check stage consistency
  if (taskSection.logical_stage && taskSection.logical_stage === 'workspace_cleanup') {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Envelope specifies logical_stage '${taskSection.logical_stage}' which contradicts 'prepare' command.`,
    );
  }

  // 1. Issue extraction
  const envIssue = normalizeIssue(taskSection.current_issue_id ?? taskSection.root_issue_id);
  if (args.issue !== undefined && envIssue !== null) {
    if (args.issue !== envIssue) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Conflicting issue: CLI specified '${args.issue}' but envelope has '${envIssue}'.`,
      );
    }
  }
  const issue = args.issue ?? envIssue ?? undefined;

  // 2. Base branch
  const envBase = envSection.base_branch;
  assertNoConflict('base', args.base, envBase);
  const base = args.base ?? envBase;

  // 3. Worktree & Expected Head
  const envWorktree = paramsSection.worktree as string | undefined;
  assertNoConflict('worktree', args.worktree, envWorktree, true);
  let worktree = args.worktree ?? envWorktree;

  const envExpectedHead = paramsSection.expected_head as string | undefined;
  assertNoConflict('expected_head', args.expectedHead, envExpectedHead);
  let expectedHead = args.expectedHead ?? envExpectedHead;

  const envConfigPath = paramsSection.workspace_config as string | undefined;
  assertNoConflict('workspace_config', args.workspaceConfig, envConfigPath, true);
  const configPath = args.workspaceConfig ?? envConfigPath;

  // 4. Branch & Commit
  const envBranch = envSection.branch;
  const envCommit = envSection.commit;
  assertNoConflict('branch', args.branch, envBranch);
  assertNoConflict('commit', args.commit, envCommit);

  let branch = args.branch ?? (envBranch ? String(envBranch) : undefined);
  let commit = args.commit ?? (envCommit ? String(envCommit) : undefined);

  // If env branch and commit are both specified, branch is feature branch and commit is expectedHead
  if (!args.branch && !args.commit && envBranch && envCommit) {
    branch = String(envBranch);
    if (!expectedHead) {
      expectedHead = String(envCommit);
    }
    commit = undefined;
  }

  // 5. Working directory & repoDir resolution
  let repoDir = args.repoDir;
  const envWorkdir = envSection.working_directory;
  if (envWorkdir) {
    const p = resolvePath(envWorkdir);
    if (worktree) {
      if (!repoDir) repoDir = p;
    } else {
      let isGitRepo: boolean;
      try {
        findRepoRoot(p);
        isGitRepo = true;
      } catch {
        isGitRepo = false;
      }
      if (!isGitRepo) {
        worktree = p;
      } else {
        if (!repoDir) repoDir = p;
      }
    }
  }

  if (!repoDir) {
    repoDir = '.';
  }

  // 6. Overrides
  const deliveryTarget = args.deliveryTarget ?? envSection.delivery_target ?? (paramsSection.delivery_target as string | undefined);
  const baseRemote = args.baseRemote ?? envSection.base_remote ?? (paramsSection.base_remote as string | undefined);
  const pushRemote = args.pushRemote ?? envSection.push_remote ?? (paramsSection.push_remote as string | undefined);
  const worktreeContainer = args.worktreeContainer ?? (paramsSection.worktree_container as string | undefined);

  const overrides: WorkspaceOverrides = {
    deliveryTarget: deliveryTarget ? String(deliveryTarget) : undefined,
    baseRemote: baseRemote ? String(baseRemote) : undefined,
    pushRemote: pushRemote ? String(pushRemote) : undefined,
    baseBranch: base ? String(base) : undefined,
    worktreeContainer: worktreeContainer ? String(worktreeContainer) : undefined,
  };

  // 7. Receipt Path
  const receiptPath = args.receiptPath ?? contractSection.receipt_path;

  // 8. Output Format
  const outputFormat =
    args.outputFormat ?? (args.inputEnvelope || receiptPath ? 'compact' : 'raw');

  // Build target
  let target: PrepareTarget;
  if (commit) {
    if (!worktree) {
      throw new WorkspaceError('INVALID_INPUT', 'Detached commit mode requires explicit worktree path');
    }
    target = { kind: 'detached', commit, path: worktree };
  } else if (issue !== undefined) {
    target = {
      kind: 'issue',
      issue,
      branch: branch || undefined,
      path: worktree || undefined,
      expectedHead: expectedHead || undefined,
    };
  } else if (branch && worktree) {
    target = {
      kind: 'branch',
      branch,
      path: worktree,
      expectedHead: expectedHead || undefined,
    };
  } else {
    throw new WorkspaceError(
      'INVALID_INPUT',
      'Insufficient parameters: supply issue number, or worktree with branch or commit.',
    );
  }

  return {
    request: {
      sourceCheckout: resolvePath(repoDir),
      target,
      configPath,
      overrides,
      expectedRepository: envSection.repository,
    },
    receiptPath: receiptPath ? resolvePath(receiptPath) : undefined,
    outputFormat,
  };
}

/**
 * Map CLI arguments and envelope to a CleanupRequest.
 */
export function mapToCleanupRequest(
  envelope: WorkspaceTaskInput,
  args: { repoDir?: string; receiptPath?: string },
): {
  request: CleanupRequest;
  receiptPath?: string;
} {
  const taskSection = envelope.task ?? {};
  const inputsSection = envelope.inputs ?? {};
  const paramsSection = (inputsSection.parameters ?? {}) as Record<string, unknown>;
  const contractSection = envelope.contract ?? {};

  const candidatesRaw = paramsSection.candidates;
  if (!Array.isArray(candidatesRaw)) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      'Cleanup requires inputs.parameters.candidates as an explicit list.',
    );
  }

  const rootIssueId = String(
    taskSection.root_issue_id ?? taskSection.current_issue_id ?? '',
  );
  if (!rootIssueId) {
    throw new WorkspaceError('INVALID_INPUT', 'Cleanup requires root_issue_id.');
  }

  const candidates: CleanupCandidate[] = candidatesRaw.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new WorkspaceError('INVALID_INPUT', `Candidate at index ${idx} must be an object.`);
    }
    const c = item as Record<string, unknown>;
    const branch = c.branch ? String(c.branch) : undefined;
    const worktree = c.worktree ? String(c.worktree) : undefined;
    const commit = c.commit ? String(c.commit) : undefined;
    const isDetached = c.kind === 'detached' || (!branch && commit);

    if (isDetached) {
      return {
        kind: 'detached',
        worktree: worktree ?? '',
        commit: commit ?? '',
        baseBranch: c.baseBranch ? String(c.baseBranch) : undefined,
        deliveryTarget: c.delivery_target ? String(c.delivery_target) : undefined,
        baseRemote: c.base_remote ? String(c.base_remote) : undefined,
        pushRemote: c.push_remote ? String(c.push_remote) : undefined,
        ownershipEvidence: c.ownership_evidence,
        consumersFinished: Boolean(c.consumers_finished),
        verificationCompleted: Boolean(c.verification_completed),
      };
    }

    return {
      kind: 'task_branch',
      worktree,
      branch: branch ?? '',
      commit,
      baseBranch: c.baseBranch ? String(c.baseBranch) : undefined,
      deliveryTarget: c.delivery_target ? String(c.delivery_target) : undefined,
      baseRemote: c.base_remote ? String(c.base_remote) : undefined,
      pushRemote: c.push_remote ? String(c.push_remote) : undefined,
      pr: c.pr as TaskBranchCleanupCandidate['pr'],
      created: Boolean(c.created),
      ownershipEvidence: c.ownership_evidence,
      consumersFinished: Boolean(c.consumers_finished),
    };
  });

  const unresolvedRaw = paramsSection.unresolved;
  const unresolved: string[] = Array.isArray(unresolvedRaw)
    ? unresolvedRaw.map((u) => String(u))
    : [];

  const receiptPath = args.receiptPath ?? contractSection.receipt_path;
  const protectedPaths: string[] = [];
  if (receiptPath) {
    protectedPaths.push(resolvePath(receiptPath));
  }

  const repoDir = args.repoDir || envelope.environment?.working_directory || '.';

  return {
    request: {
      sourceCheckout: resolvePath(repoDir),
      rootIssueId,
      candidates,
      unresolved,
      protectedPaths,
    },
    receiptPath: receiptPath ? resolvePath(receiptPath) : undefined,
  };
}

/**
 * Map PreparedWorkspace to external result dictionary.
 */
export function mapPreparedWorkspaceToResult(
  prepared: PreparedWorkspace,
): Record<string, unknown> {
  return {
    repository: prepared.repository,
    delivery_target: prepared.deliveryTarget,
    base_remote: prepared.baseRemote,
    push_remote: prepared.pushRemote,
    working_directory: prepared.path,
    worktree: prepared.path,
    branch: prepared.branch,
    baseBranch: prepared.baseBranch,
    commit: prepared.commit,
    created: prepared.disposition === 'created',
  };
}

/**
 * Map internal CleanupResult to external 4-list contract.
 */
export function mapCleanupResultToExternalReport(
  result: CleanupResult,
): ExternalCleanupReport {
  const removedPaths: string[] = [];
  const retainedPaths: Array<{ path: string; reason: string }> = [];
  const removedBranches: Array<{
    branch: string | null;
    scope: 'local' | 'remote';
    remote?: string;
    already_absent?: boolean;
  }> = [];
  const retainedBranches: Array<{ branch: string | null; reason: string }> = [];

  for (const item of result.candidates) {
    const cand = item.candidate;
    const worktreePath = cand.worktree;
    const branchName = 'branch' in cand ? cand.branch : null;

    if (item.worktree) {
      if (item.worktree.status === 'removed') {
        if (worktreePath && !removedPaths.includes(worktreePath)) {
          removedPaths.push(worktreePath);
        }
      } else if (item.worktree.status === 'retained') {
        if (worktreePath && !removedPaths.includes(worktreePath)) {
          retainedPaths.push({
            path: worktreePath,
            reason: item.worktree.reason || item.worktree.reasonCode || 'Retained',
          });
        }
      }
    }

    if (item.remoteBranch) {
      if (item.remoteBranch.status === 'removed' || item.remoteBranch.status === 'already_absent') {
        removedBranches.push({
          branch: branchName,
          remote: cand.pushRemote || 'origin',
          scope: 'remote',
          already_absent: item.remoteBranch.status === 'already_absent',
        });
      } else if (item.remoteBranch.status === 'retained') {
        retainedBranches.push({
          branch: branchName,
          reason: item.remoteBranch.reason || item.remoteBranch.reasonCode || 'Remote branch retained',
        });
      }
    }

    if (item.localBranch) {
      if (item.localBranch.status === 'removed' || item.localBranch.status === 'already_absent') {
        removedBranches.push({
          branch: branchName,
          scope: 'local',
          ...(item.localBranch.status === 'already_absent' ? { already_absent: true } : {}),
        });
      } else if (item.localBranch.status === 'retained') {
        if (!retainedBranches.some((b) => b.branch === branchName)) {
          retainedBranches.push({
            branch: branchName,
            reason: item.localBranch.reason || item.localBranch.reasonCode || 'Local branch retained',
          });
        }
      }
    }
  }

  // Include unresolved inventory in retained_branches
  for (const unres of result.unresolved) {
    retainedBranches.push({ branch: null, reason: unres });
  }

  return {
    outcome: result.outcome,
    removed_paths: removedPaths,
    retained_paths: retainedPaths,
    removed_branches: removedBranches,
    retained_branches: retainedBranches,
  };
}

export interface BuildReceiptOptions {
  status: 'succeeded' | 'blocked' | 'failed';
  compactReport: CompactReceiptReport;
  artifacts: Record<string, unknown>;
  created: boolean;
  logicalStage: string;
  isCleanup?: boolean;
  envelope?: WorkspaceTaskInput;
  rootIssueId?: string;
  currentIssueId?: string;
  summary: string;
  errorMessage?: string;
}

/**
 * Generate Markdown receipt strictly matching subagent-receipt.template.md.
 */
export function buildMarkdownReceipt(opts: BuildReceiptOptions): string {
  const env = opts.envelope ?? {};
  const task = env.task ?? {};
  const inputs = env.inputs ?? {};
  const budgets = env.budgets ?? {};

  const receiptPath = opts.compactReport.receipt_path || '';
  const dispatchId = receiptPath ? path.parse(receiptPath).name : 'workspace_prepare';

  const predecessors = inputs.predecessor_receipts ?? [];
  const origDispatchId =
    predecessors.length > 0 ? path.parse(predecessors[predecessors.length - 1]).name : 'N/A';

  const rootIssue = String(opts.rootIssueId ?? task.root_issue_id ?? 'N/A');
  const currentIssue = String(opts.currentIssueId ?? task.current_issue_id ?? 'N/A');
  const logicalStage = opts.logicalStage;
  const attempt = task.attempt ?? 1;
  const delUsed = budgets.delivery_attempts_used ?? 0;
  const repUsed = budgets.replans_used ?? 0;

  const jsonBlock = JSON.stringify(opts.compactReport, null, 2);

  const art = opts.artifacts;
  const workdir = String(art.working_directory ?? 'N/A');
  const repo = String(art.repository ?? 'N/A');
  const deliveryTarget = String(art.delivery_target ?? repo);
  const baseRemote = String(art.base_remote ?? 'origin');
  const pushRemote = String(art.push_remote ?? 'origin');
  const worktree = String(art.worktree ?? 'N/A');
  const baseB = String(art.baseBranch ?? 'N/A');
  const branch = art.branch !== undefined && art.branch !== null ? String(art.branch) : 'null';
  const commit = String(art.commit ?? 'N/A');
  const envReceipt = String(art.environment_receipt ?? (receiptPath || 'N/A'));

  let verificationText: string;
  let taskResultText: string;
  let feedbackText: string;
  let recoveryText: string;

  if (opts.status === 'succeeded') {
    verificationText = `- Git repository root: ${repo}
- Target worktree directory: ${worktree}
- Delivery target: ${deliveryTarget}
- Base remote: ${baseRemote}
- Push remote: ${pushRemote}
- Cleanliness verified: Source repository and target worktree verified clean (no uncommitted or untracked files).
- Branch and revision: Pinned to commit ${commit} (branch: ${branch !== 'null' ? branch : 'detached HEAD'}).
- Worktree ownership: ${opts.created ? 'created fresh feature worktree' : 'reused existing registered worktree'}.`;

    taskResultText = `Successfully ${opts.created ? 'created' : 'validated and reused'} Git execution environment at \`${worktree}\`.
- Repository: \`${repo}\`
- Delivery target: \`${deliveryTarget}\`
- Base remote: \`${baseRemote}\`
- Push remote: \`${pushRemote}\`
- Worktree path: \`${worktree}\`
- Base branch: \`${baseB}\`
- Branch: \`${branch}\`
- Commit SHA: \`${commit}\``;

    feedbackText = `Workspace is clean and ready for domain task execution.
Subsequent stage tasks must bind execution to \`${worktree}\` and adhere to the environment contract.`;

    recoveryText = `- Dispatch ID: ${dispatchId}
- Origin stage: ${logicalStage}
- Attempt: ${attempt}
- Delivery attempts used: ${delUsed}
- Replans used: ${repUsed}
- Recovery note: For rework, supply --expected-head ${commit !== 'N/A' ? commit : '<commit>'} to require this exact environment.`;
  } else {
    const err = opts.errorMessage || opts.summary;
    verificationText = `Workspace preparation blocked: ${err}`;
    taskResultText = `Workspace preparation blocked: ${err}`;
    feedbackText = `Preparation halted: ${err}
Remediation required before retrying workspace preparation.`;
    recoveryText = `- Dispatch ID: ${dispatchId}
- Origin stage: ${logicalStage}
- Attempt: ${attempt}
- Delivery attempts used: ${delUsed}
- Replans used: ${repUsed}
- Recovery note: Resolve reported blocker before retrying workspace preparation.`;
  }

  if (opts.isCleanup) {
    verificationText =
      'Candidate checks and per-resource cleanup results are recorded in the compact report.';
    taskResultText = opts.summary;
    feedbackText =
      'Retained resources and reasons are recorded in the compact report. Retry with the same candidates after resolving conflicts.';
    recoveryText = `- Origin stage: workspace_cleanup\n- Attempt: ${attempt}`;
  }

  return `# Subagent Receipt

- root_issue_id: ${rootIssue}
- current_issue_id: ${currentIssue}
- task_type: ${logicalStage}
- dispatch_id: ${dispatchId}
- original_dispatch_id: ${origDispatchId}
- origin_stage: ${logicalStage}
- attempt: ${attempt}
- delivery_attempts_used: ${delUsed}
- replans_used: ${repUsed}
- execution_status: ${opts.status}

## Compact Report

\`\`\`json
${jsonBlock}
\`\`\`

## Artifacts

- working_directory: ${workdir}
- repository: ${repo}
- delivery_target: ${deliveryTarget}
- base_remote: ${baseRemote}
- push_remote: ${pushRemote}
- worktree: ${worktree}
- baseBranch: ${baseB}
- branch: ${branch}
- commit: ${commit}
- environment_receipt: ${envReceipt}
- research_entry: N/A
- artifact_locations: N/A
- pr: N/A

## Verification

${verificationText}

## Task Result

${taskResultText}

## Current State and Feedback

${feedbackText}

## Recovery and Budgets

${recoveryText}
`;
}
