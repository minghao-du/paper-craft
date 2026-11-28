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
  OwnershipEvidence,
  PreparedWorkspace,
  PreparedWorkspaceResult,
  PrepareRequest,
  PrepareTarget,
  PrDeliveryEvidence,
  TaskBranchCleanupCandidate,
  WorkspaceError,
  WorkspaceOverrides,
} from './types.js';
import { resolvePath } from './git.js';
import { validateCleanupCandidate } from './cleanup.js';
import {
  parseTaskInputEnvelope,
  type TaskInputEnvelope as ProtocolTaskInputEnvelope,
} from '../../orchestrator/src/protocol/index.js';

export type { PreparedWorkspaceResult } from './types.js';

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
    primary_checkout?: string;
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

function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Field '${fieldName}' must be a string if provided; received ${typeof value}.`,
    );
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNonEmptyId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

  // 1. Issue extraction (audit metadata vs target intent decoupled below)
  const envIssue = normalizeIssue(taskSection.current_issue_id ?? taskSection.root_issue_id);
  if (args.issue !== undefined && envIssue !== null) {
    if (args.issue !== envIssue) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Conflicting issue: CLI specified '${args.issue}' but envelope has '${envIssue}'.`,
      );
    }
  }

  // 2. Base branch
  const argsBase = readOptionalString(args.base, 'base');
  const envBase = readOptionalString(envSection.base_branch, 'environment.base_branch');
  assertNoConflict('base', argsBase, envBase);
  const base = argsBase ?? envBase;

  // 3. Worktree, Expected Head, & Config Path
  const argsWorktree = readOptionalString(args.worktree, 'worktree');
  const envWorktree = readOptionalString(paramsSection.worktree, 'inputs.parameters.worktree');
  assertNoConflict('worktree', argsWorktree, envWorktree, true);
  const explicitWorktree = argsWorktree ?? envWorktree;

  const argsExpectedHead = readOptionalString(args.expectedHead, 'expected_head');
  const envExpectedHead = readOptionalString(
    paramsSection.expected_head,
    'inputs.parameters.expected_head',
  );
  assertNoConflict('expected_head', argsExpectedHead, envExpectedHead);
  let expectedHead = argsExpectedHead ?? envExpectedHead;

  const argsConfigPath = readOptionalString(args.workspaceConfig, 'workspace_config');
  const envConfigPath = readOptionalString(
    paramsSection.workspace_config,
    'inputs.parameters.workspace_config',
  );
  assertNoConflict('workspace_config', argsConfigPath, envConfigPath, true);
  const configPath = argsConfigPath ?? envConfigPath;

  // 4. Branch & Commit normalization and conflict verification
  const envBranchIsNull = envSection.branch === null;
  const argsBranch = readOptionalString(args.branch, 'branch');
  const envBranch = readOptionalString(envSection.branch, 'environment.branch');
  assertNoConflict('branch', argsBranch, envBranch);

  const argsCommit = readOptionalString(args.commit, 'commit');
  const envCommit = readOptionalString(envSection.commit, 'environment.commit');
  assertNoConflict('commit', argsCommit, envCommit);

  if (envBranchIsNull && argsBranch !== undefined) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Conflicting 'branch' specified: CLI provided '${argsBranch}' but envelope specified null${envCommit ? ' (detached)' : ''}.`,
    );
  }

  const branch = argsBranch ?? envBranch;
  const rawCommit = argsCommit ?? envCommit;
  let commit: string | undefined;

  if (envBranch && envCommit) {
    // Envelope describes branch + commit: commit is the expected HEAD of that branch.
    // Repeating identical branch/commit via CLI preserves this branch intent.
    if (expectedHead && expectedHead !== envCommit) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Conflicting 'expected_head' and envelope 'commit': expected_head is '${expectedHead}' but envelope commit is '${envCommit}'.`,
      );
    }
    expectedHead = expectedHead ?? envCommit;
    commit = undefined;
  } else if (rawCommit !== undefined) {
    if (branch !== undefined) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Contradictory branch and detached commit declarations: branch '${branch}' cannot be combined with commit '${rawCommit}' unless envelope specifies both branch and commit.`,
      );
    }
    if (args.issue !== undefined) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Contradictory issue and detached commit declarations: issue '${args.issue}' cannot be combined with commit '${rawCommit}' unless envelope specifies both branch and commit.`,
      );
    }
    if (expectedHead && expectedHead !== rawCommit) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Conflicting 'expected_head' and 'commit': expected_head is '${expectedHead}' but commit is '${rawCommit}'.`,
      );
    }
    commit = rawCommit;
  }

  // Detached mode keeps envelope issue IDs as audit metadata instead of a feature-branch target.
  const issue = commit ? undefined : (args.issue ?? envIssue ?? undefined);

  // 5. Deterministic directory interpretation (source checkout vs target worktree)
  const explicitRepoDirRaw = readOptionalString(args.repoDir, 'repo_dir');
  const explicitRepoDir = explicitRepoDirRaw ? resolvePath(explicitRepoDirRaw) : undefined;
  const envWorkdirRaw = readOptionalString(
    envSection.working_directory,
    'environment.working_directory',
  );
  const envWorkdir = envWorkdirRaw ? resolvePath(envWorkdirRaw) : undefined;
  const envPrimaryCheckoutRaw = readOptionalString(
    envSection.primary_checkout,
    'environment.primary_checkout',
  );
  const envPrimaryCheckout = envPrimaryCheckoutRaw
    ? resolvePath(envPrimaryCheckoutRaw)
    : undefined;

  let worktree = explicitWorktree ? resolvePath(explicitWorktree) : undefined;
  let repoDir: string;

  if (worktree || issue !== undefined) {
    repoDir = explicitRepoDir ?? envWorkdir ?? envPrimaryCheckout ?? resolvePath('.');
  } else {
    repoDir = explicitRepoDir ?? envPrimaryCheckout ?? resolvePath('.');
    if (envWorkdir && envWorkdir !== repoDir) {
      worktree = envWorkdir;
    }
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

  // 9. Choose target purely from normalized intent
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
      branch,
      path: worktree,
      expectedHead,
    };
  } else if (branch && worktree) {
    target = {
      kind: 'branch',
      branch,
      path: worktree,
      expectedHead,
    };
  } else {
    throw new WorkspaceError(
      'INVALID_INPUT',
      'Insufficient parameters: supply issue number, or worktree with branch or commit.',
    );
  }

  return {
    request: {
      sourceCheckout: repoDir,
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
 * Strict boolean parser for task parameters.
 * - true -> true
 * - false -> false
 * - undefined / omitted -> undefined
 * - anything else (string "true", string "false", number, object, null) -> throws INVALID_INPUT.
 */
function parseStrictBoolean(
  value: unknown,
  fieldName: string,
  candidateIdx: number,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new WorkspaceError(
    'INVALID_INPUT',
    `Candidate at index ${candidateIdx} field '${fieldName}' must be a boolean or omitted; received ${
      value === null ? 'null' : typeof value
    } (${JSON.stringify(value)}).`,
  );
}

/**
 * Normalizes an external/raw candidate entry into a typed CleanupCandidate.
 * - Resolves legacy candidates without explicit 'kind'
 * - Strictly parses boolean flags
 * - Normalizes ownership evidence structure
 * - Rejects contradictory fields/kinds
 */
function normalizeTransportCandidate(
  item: unknown,
  idx: number,
): CleanupCandidate {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new WorkspaceError('INVALID_INPUT', `Candidate at index ${idx} must be an object.`);
  }
  const c = item as Record<string, unknown>;

  // Strict boolean parsing
  const created = parseStrictBoolean(c.created, 'created', idx);

  if (
    c.consumers_finished !== undefined &&
    c.consumersFinished !== undefined &&
    c.consumers_finished !== c.consumersFinished
  ) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} has conflicting values for consumers_finished and consumersFinished.`,
    );
  }
  const rawConsumersFinished =
    c.consumers_finished !== undefined ? c.consumers_finished : c.consumersFinished;
  const consumersFinished = parseStrictBoolean(rawConsumersFinished, 'consumers_finished', idx);

  if (
    c.verification_completed !== undefined &&
    c.verificationCompleted !== undefined &&
    c.verification_completed !== c.verificationCompleted
  ) {
    throw new WorkspaceError(
      'INVALID_INPUT',
      `Candidate at index ${idx} has conflicting values for verification_completed and verificationCompleted.`,
    );
  }
  const rawVerificationCompleted =
    c.verification_completed !== undefined
      ? c.verification_completed
      : c.verificationCompleted;
  const verificationCompleted = parseStrictBoolean(
    rawVerificationCompleted,
    'verification_completed',
    idx,
  );

  // Validate string property types if present
  const checkOptionalString = (val: unknown, name: string) => {
    if (val !== undefined && typeof val !== 'string') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} '${name}' must be a string if provided; received ${typeof val}.`,
      );
    }
  };

  checkOptionalString(c.branch, 'branch');
  checkOptionalString(c.worktree, 'worktree');
  checkOptionalString(c.commit, 'commit');
  checkOptionalString(c.baseBranch, 'baseBranch');
  checkOptionalString(c.base_branch, 'base_branch');
  checkOptionalString(c.deliveryTarget, 'deliveryTarget');
  checkOptionalString(c.delivery_target, 'delivery_target');
  checkOptionalString(c.baseRemote, 'baseRemote');
  checkOptionalString(c.base_remote, 'base_remote');
  checkOptionalString(c.pushRemote, 'pushRemote');
  checkOptionalString(c.push_remote, 'push_remote');

  const rawBranch = c.branch as string | undefined;
  const rawWorktree = c.worktree as string | undefined;
  const rawCommit = c.commit as string | undefined;

  const branch = rawBranch && rawBranch.trim() ? rawBranch.trim() : undefined;
  const worktree = rawWorktree && rawWorktree.trim() ? rawWorktree.trim() : undefined;
  const commit = rawCommit && rawCommit.trim() ? rawCommit.trim() : undefined;

  // Ownership evidence normalization
  let ownershipEvidence: OwnershipEvidence | undefined;
  const rawEvidence = c.ownership_evidence ?? c.ownershipEvidence;
  if (rawEvidence !== undefined) {
    if (typeof rawEvidence !== 'object' || rawEvidence === null || Array.isArray(rawEvidence)) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} 'ownership_evidence' must be an object if provided; received ${
          rawEvidence === null ? 'null' : typeof rawEvidence
        }.`,
      );
    }
    const ev = rawEvidence as Record<string, unknown>;
    const rootIssue = ev.rootIssueId ?? ev.root_issue_id;
    const issue = ev.issue ?? ev.issue_id ?? ev.issueId;
    const source = ev.source;
    const pushedRepository = ev.pushed_repository ?? ev.pushedRepository;

    if (rootIssue !== undefined && typeof rootIssue !== 'string' && typeof rootIssue !== 'number') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} ownership evidence root_issue_id must be a string or number.`,
      );
    }
    if (issue !== undefined && typeof issue !== 'string' && typeof issue !== 'number') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} ownership evidence issue must be a string or number.`,
      );
    }
    if (source !== undefined && typeof source !== 'string') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} ownership evidence source must be a string.`,
      );
    }

    if (pushedRepository !== undefined && typeof pushedRepository !== 'string') {
      throw new WorkspaceError('INVALID_INPUT', `Candidate at index ${idx} ownership evidence pushed_repository must be a string.`);
    }
    ownershipEvidence = {
      ...(pushedRepository === undefined ? {} : { pushedRepository }),
      rootIssueId: rootIssue !== undefined ? rootIssue : undefined,
      root_issue_id: rootIssue !== undefined ? rootIssue : undefined,
      issue: issue !== undefined ? issue : undefined,
      source: source !== undefined ? String(source) : undefined,
    };
  }

  // PR normalization
  let pr: TaskBranchCleanupCandidate['pr'];
  if (c.pr !== undefined && c.pr !== null) {
    if (typeof c.pr === 'number' || typeof c.pr === 'string') {
      pr = c.pr;
    } else if (typeof c.pr === 'object' && !Array.isArray(c.pr)) {
      pr = c.pr as PrDeliveryEvidence;
    } else {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} 'pr' must be a number, string, or PR delivery evidence object.`,
      );
    }
  }

  // Determine kind
  let kind: 'task_branch' | 'detached';
  if (c.kind !== undefined) {
    if (c.kind !== 'task_branch' && c.kind !== 'detached') {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} has invalid kind '${String(c.kind)}'. Expected 'task_branch' or 'detached'.`,
      );
    }
    kind = c.kind;
    if (kind === 'task_branch') {
      if (!branch) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} with kind 'task_branch' requires a non-empty branch.`,
        );
      }
      if (verificationCompleted !== undefined) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} with kind 'task_branch' cannot specify 'verification_completed'.`,
        );
      }
    } else {
      // detached
      if (branch !== undefined) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} with kind 'detached' cannot specify a branch.`,
        );
      }
      if (!worktree || !commit) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} with kind 'detached' requires both 'worktree' and 'commit'.`,
        );
      }
      if (created !== undefined) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} with kind 'detached' cannot specify 'created'.`,
        );
      }
      if (pr !== undefined) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} with kind 'detached' cannot specify 'pr'.`,
        );
      }
    }
  } else {
    // Legacy / transport inference:
    // - A branch identifies a task_branch candidate (whether or not worktree is present).
    // - A worktree and commit without a branch identify a detached candidate.
    // - Explicit contradictory kinds/fields are rejected with an error.
    if (branch) {
      if (verificationCompleted !== undefined) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} specifies both a branch and 'verification_completed', which are contradictory.`,
        );
      }
      kind = 'task_branch';
    } else if (worktree && commit) {
      if (created !== undefined) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} without a branch cannot specify 'created'.`,
        );
      }
      if (pr !== undefined) {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Candidate at index ${idx} without a branch cannot specify 'pr'.`,
        );
      }
      kind = 'detached';
    } else {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Candidate at index ${idx} cannot be identified as 'task_branch' or 'detached'. Supply a branch or both worktree and commit.`,
      );
    }
  }

  const baseBranch = (c.baseBranch ?? c.base_branch)
    ? String(c.baseBranch ?? c.base_branch)
    : undefined;
  const deliveryTarget = (c.deliveryTarget ?? c.delivery_target)
    ? String(c.deliveryTarget ?? c.delivery_target)
    : undefined;
  const baseRemote = (c.baseRemote ?? c.base_remote)
    ? String(c.baseRemote ?? c.base_remote)
    : undefined;
  const pushRemote = (c.pushRemote ?? c.push_remote)
    ? String(c.pushRemote ?? c.push_remote)
    : undefined;

  const noChangeBase = c.no_change_base ?? c.noChangeBase;
  if (noChangeBase !== undefined && (kind !== 'task_branch' || typeof noChangeBase !== 'string')) {
    throw new WorkspaceError('INVALID_INPUT', `Candidate at index ${idx} requires a task branch and full SHA for no_change_base.`);
  }
  let candidate: CleanupCandidate;
  if (kind === 'detached') {
    candidate = {
      kind: 'detached',
      worktree: worktree!,
      commit: commit!,
      baseBranch,
      deliveryTarget,
      baseRemote,
      pushRemote,
      ownershipEvidence,
      consumersFinished,
      verificationCompleted,
    };
  } else {
    candidate = {
      kind: 'task_branch',
      worktree,
      branch: branch!,
      commit,
      baseBranch,
      deliveryTarget,
      baseRemote,
      pushRemote,
      pr,
      ...(noChangeBase === undefined ? {} : { noChangeBase }),
      created,
      ownershipEvidence,
      consumersFinished,
    };
  }

  return validateCleanupCandidate(candidate, idx);
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

  // Validate and normalize all candidates up-front before returning the request
  const candidates: CleanupCandidate[] = candidatesRaw.map((item, idx) =>
    normalizeTransportCandidate(item, idx),
  );

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
): PreparedWorkspaceResult {
  return {
    outcome: prepared.disposition === 'created' ? 'prepared' : 'reused',
    repository: prepared.repository,
    delivery_target: prepared.deliveryTarget,
    base_remote: prepared.baseRemote,
    push_remote: prepared.pushRemote,
    working_directory: prepared.path,
    worktree: prepared.path,
    ...(prepared.primaryCheckout ? { primary_checkout: prepared.primaryCheckout } : {}),
    branch: prepared.branch,
    baseBranch: prepared.baseBranch,
    commit: prepared.commit,
    created: prepared.disposition === 'created',
    ...(prepared.sharedPaths?.length ? { shared_paths: prepared.sharedPaths } : {}),
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
      if (item.worktree.status === 'removed' || item.worktree.status === 'already_absent') {
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

export interface PrepareIssueIds {
  rootIssueId?: string;
  currentIssueId: string;
}

/**
 * Extract trimmed, non-empty root and current issue identifiers for receipt metadata.
 */
export function resolvePrepareIssueIds(
  target: PrepareTarget,
  envelope?: WorkspaceTaskInput,
): PrepareIssueIds {
  const taskSection = envelope?.task ?? {};
  const rootIssueId = readNonEmptyId(taskSection.root_issue_id);
  const currentIssueId =
    readNonEmptyId(taskSection.current_issue_id) ??
    (target.kind === 'issue' ? String(target.issue) : 'N/A');
  return { rootIssueId, currentIssueId };
}

/**
 * Format the summary line for a succeeded prepare execution.
 */
export function formatPrepareSummary(
  prepared: PreparedWorkspace,
  target: PrepareTarget,
): string {
  if (prepared.disposition === 'reused') {
    return `Reused existing worktree at ${prepared.path} with commit ${prepared.commit}`;
  }
  if (target.kind === 'detached' || prepared.branch === null) {
    return `Prepared detached worktree at ${prepared.path} pinned to commit ${prepared.commit}`;
  }
  if (target.kind === 'issue') {
    return `Prepared feature worktree for issue ${target.issue} at ${prepared.path}`;
  }
  return `Prepared feature worktree on branch '${prepared.branch}' at ${prepared.path}`;
}

export type BuildPrepareReceiptArtifactsParams =
  | {
      status: 'succeeded';
      prepared: PreparedWorkspace;
      receiptPath?: string;
    }
  | {
      status: 'blocked';
      request: PrepareRequest;
      envelope?: WorkspaceTaskInput;
      receiptPath?: string;
    };

/**
 * Build receipt artifacts map for succeeded or blocked prepare executions.
 */
export function buildPrepareReceiptArtifacts(
  params: BuildPrepareReceiptArtifactsParams,
): Record<string, unknown> {
  if (params.status === 'succeeded') {
    const { prepared, receiptPath } = params;
    return {
      working_directory: prepared.path,
      ...(prepared.primaryCheckout ? { primary_checkout: prepared.primaryCheckout } : {}),
      ...(prepared.sharedPaths?.length ? { shared_paths: prepared.sharedPaths } : {}),
      repository: prepared.repository,
      delivery_target: prepared.deliveryTarget,
      base_remote: prepared.baseRemote,
      push_remote: prepared.pushRemote,
      worktree: prepared.path,
      baseBranch: prepared.baseBranch,
      branch: prepared.branch,
      commit: prepared.commit,
      ...(receiptPath ? { environment_receipt: receiptPath } : {}),
    };
  }

  const { request, envelope, receiptPath } = params;
  const envSection = envelope?.environment ?? {};
  const target = request.target;
  const targetWorktree = target.path ?? 'N/A';

  const deliveryTarget =
    request.overrides?.deliveryTarget ??
    readNonEmptyString(envSection.delivery_target) ??
    request.expectedRepository ??
    readNonEmptyString(envSection.repository) ??
    'N/A';
  const repository =
    request.expectedRepository ??
    readNonEmptyString(envSection.repository) ??
    deliveryTarget;
  const baseRemote =
    request.overrides?.baseRemote ??
    readNonEmptyString(envSection.base_remote) ??
    'origin';
  const pushRemote =
    request.overrides?.pushRemote ??
    readNonEmptyString(envSection.push_remote) ??
    'origin';
  const baseBranch =
    request.overrides?.baseBranch ??
    readNonEmptyString(envSection.base_branch) ??
    'N/A';

  let branch: string | null;
  let commit: string;
  if (target.kind === 'detached') {
    branch = null;
    commit = target.commit;
  } else if (target.kind === 'branch') {
    branch = target.branch;
    commit = target.expectedHead ?? readNonEmptyString(envSection.commit) ?? 'N/A';
  } else {
    branch = target.branch ?? `issue-${target.issue}`;
    commit = target.expectedHead ?? readNonEmptyString(envSection.commit) ?? 'N/A';
  }

  return {
    working_directory: targetWorktree,
    ...(envSection.primary_checkout
      ? { primary_checkout: resolvePath(String(envSection.primary_checkout)) }
      : {}),
    repository,
    delivery_target: deliveryTarget,
    base_remote: baseRemote,
    push_remote: pushRemote,
    worktree: targetWorktree,
    baseBranch,
    branch,
    commit,
    ...(receiptPath ? { environment_receipt: receiptPath } : {}),
  };
}

/**
 * Build receipt artifacts map for cleanup executions from request and envelope metadata.
 */
export function buildCleanupReceiptArtifacts(params: {
  request: CleanupRequest;
  envelope?: WorkspaceTaskInput;
  receiptPath?: string;
}): Record<string, unknown> {
  const { request, envelope, receiptPath } = params;
  const envSection = envelope?.environment ?? {};
  const paramSection = envelope?.inputs?.parameters ?? {};

  const deliveryTarget =
    readNonEmptyString(paramSection.delivery_target) ??
    readNonEmptyString(envSection.delivery_target) ??
    readNonEmptyString(envSection.repository) ??
    'N/A';
  const repository = readNonEmptyString(envSection.repository) ?? deliveryTarget;
  const baseRemote =
    readNonEmptyString(paramSection.base_remote) ??
    readNonEmptyString(envSection.base_remote) ??
    'origin';
  const pushRemote =
    readNonEmptyString(paramSection.push_remote) ??
    readNonEmptyString(envSection.push_remote) ??
    'origin';
  const baseBranch = readNonEmptyString(envSection.base_branch) ?? 'N/A';
  const commit = readNonEmptyString(envSection.commit) ?? 'N/A';

  return {
    working_directory: request.sourceCheckout,
    ...(envSection.primary_checkout
      ? { primary_checkout: resolvePath(String(envSection.primary_checkout)) }
      : {}),
    repository,
    delivery_target: deliveryTarget,
    base_remote: baseRemote,
    push_remote: pushRemote,
    worktree: 'N/A',
    baseBranch,
    branch: null,
    commit,
    ...(receiptPath ? { environment_receipt: receiptPath } : {}),
  };
}

interface CleanupReceiptSections {
  verificationText: string;
  taskResultText: string;
  feedbackText: string;
  recoveryText: string;
}

function formatCleanupReceiptSections(opts: {
  status: 'succeeded' | 'blocked' | 'failed';
  result: Record<string, unknown>;
  workdir: string;
  summary: string;
  errorMessage?: string;
  dispatchId: string;
  logicalStage: string;
  attempt: number;
  delUsed: number;
  repUsed: number;
}): CleanupReceiptSections {
  const { status, result, workdir, summary, errorMessage, dispatchId, logicalStage, attempt, delUsed, repUsed } =
    opts;
  const recoveryBase = `- Dispatch ID: ${dispatchId}
- Origin stage: ${logicalStage}
- Attempt: ${attempt}
- Delivery attempts used: ${delUsed}
- Replans used: ${repUsed}`;

  if (status !== 'succeeded') {
    const err = errorMessage || summary;
    return {
      verificationText: `Workspace cleanup blocked: ${err}`,
      taskResultText: `Workspace cleanup blocked: ${err}`,
      feedbackText: `Cleanup halted: ${err}\nResolve reported blocker before retrying workspace cleanup.`,
      recoveryText: `${recoveryBase}\n- Recovery note: Resolve reported blocker before retrying workspace cleanup.`,
    };
  }

  const removedPaths = Array.isArray(result.removed_paths)
    ? result.removed_paths.map((p) => String(p))
    : [];
  const retainedPaths = Array.isArray(result.retained_paths)
    ? (result.retained_paths as Array<{ path?: unknown; reason?: unknown }>).map((p) => ({
        path: String(p.path ?? 'N/A'),
        reason: String(p.reason ?? 'retained'),
      }))
    : [];
  const removedBranches = Array.isArray(result.removed_branches)
    ? (
        result.removed_branches as Array<{
          branch?: unknown;
          scope?: unknown;
          remote?: unknown;
          already_absent?: unknown;
        }>
      ).map((b) => ({
        branch: b.branch !== undefined && b.branch !== null ? String(b.branch) : 'N/A',
        scope: String(b.scope ?? 'unknown'),
        remote: typeof b.remote === 'string' && b.remote ? b.remote : undefined,
        alreadyAbsent: b.already_absent === true,
      }))
    : [];
  const retainedBranches = Array.isArray(result.retained_branches)
    ? (result.retained_branches as Array<{ branch?: unknown; reason?: unknown }>).map((b) => ({
        branch: b.branch !== undefined && b.branch !== null ? String(b.branch) : '<unresolved>',
        reason: String(b.reason ?? 'retained'),
      }))
    : [];

  const outcome =
    typeof result.outcome === 'string' && result.outcome
      ? result.outcome
      : retainedPaths.length === 0 && retainedBranches.length === 0
        ? 'cleaned'
        : 'incomplete';

  const formatList = (items: string[]): string =>
    items.length > 0 ? items.map((line) => `- ${line}`).join('\n') : '- None';

  const removedBranchesLines = removedBranches.map((b) => {
    const tags = [b.scope];
    if (b.remote) tags.push(`remote: ${b.remote}`);
    if (b.alreadyAbsent) tags.push('already_absent');
    return `\`${b.branch}\` (${tags.join(', ')})`;
  });

  const verificationText = `- Persistent checkout: ${workdir}
- Cleanup outcome: ${outcome}
- Removed worktree paths: ${removedPaths.length}
- Retained worktree paths: ${retainedPaths.length}
- Removed branch refs: ${removedBranches.length}
- Retained branch refs: ${retainedBranches.length}`;

  const taskResultText = `${summary}

### Removed Paths (${removedPaths.length})

${formatList(removedPaths.map((p) => `\`${p}\``))}

### Retained Paths (${retainedPaths.length})

${formatList(retainedPaths.map((p) => `\`${p.path}\`: ${p.reason}`))}

### Removed Branches (${removedBranches.length})

${formatList(removedBranchesLines)}

### Retained Branches (${retainedBranches.length})

${formatList(retainedBranches.map((b) => `\`${b.branch}\`: ${b.reason}`))}`;

  const isClean = outcome === 'cleaned' && retainedPaths.length === 0 && retainedBranches.length === 0;
  const feedbackText = isClean
    ? 'Cleanup complete with zero retained paths or branches. Persistent checkout and durable receipts remain intact.'
    : `Cleanup incomplete: ${retainedPaths.length} path(s) and ${retainedBranches.length} branch(es) retained. Resolve the retention reasons above and retry with the outstanding candidates.`;

  const recoveryNote = isClean
    ? 'No further cleanup retries required.'
    : 'Retry workspace_cleanup with unresolved or retained candidates after resolving conflicts.';

  return {
    verificationText,
    taskResultText,
    feedbackText,
    recoveryText: `${recoveryBase}\n- Recovery note: ${recoveryNote}`,
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

  const rootIssue = readNonEmptyId(opts.rootIssueId) ?? readNonEmptyId(task.root_issue_id) ?? 'N/A';
  const currentIssue =
    readNonEmptyId(opts.currentIssueId) ?? readNonEmptyId(task.current_issue_id) ?? 'N/A';
  const logicalStage = opts.logicalStage;
  const attempt = task.attempt ?? 1;
  const delUsed = budgets.delivery_attempts_used ?? 0;
  const repUsed = budgets.replans_used ?? 0;

  const jsonBlock = JSON.stringify(opts.compactReport, null, 2);

  const art = opts.artifacts;
  const workdir = String(art.working_directory ?? 'N/A');
  const primaryCheckout = art.primary_checkout ? String(art.primary_checkout) : null;
  const sharedPathsSummary = Array.isArray(art.shared_paths) && art.shared_paths.length > 0
    ? art.shared_paths
        .map((s) => {
          const rec = s as { path?: unknown; status?: unknown };
          return `${String(rec.path ?? '')} (${String(rec.status ?? '')})`;
        })
        .join(', ')
    : null;
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
    const worktreeOwnership = opts.created
      ? branch !== 'null'
        ? 'created fresh feature worktree'
        : 'created fresh detached worktree'
      : 'reused existing registered worktree';
    verificationText = `- Git repository root: ${repo}
- Target worktree directory: ${worktree}
- Delivery target: ${deliveryTarget}
- Base remote: ${baseRemote}
- Push remote: ${pushRemote}
- Cleanliness verified: Source repository and target worktree verified clean (no uncommitted or untracked files).
- Branch and revision: Pinned to commit ${commit} (branch: ${branch !== 'null' ? branch : 'detached HEAD'}).
- Worktree ownership: ${worktreeOwnership}.`;

    taskResultText = `Successfully ${opts.created ? 'created' : 'validated and reused'} Git execution environment at \`${worktree}\`.
- Repository: \`${repo}\`
- Delivery target: \`${deliveryTarget}\`
- Base remote: \`${baseRemote}\`
- Push remote: \`${pushRemote}\`
- Worktree path: \`${worktree}\`
${primaryCheckout ? `- Primary checkout: \`${primaryCheckout}\`\n` : ''}${sharedPathsSummary ? `- Shared paths: ${sharedPathsSummary}\n` : ''}- Base branch: \`${baseB}\`
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
    const cleanupSections = formatCleanupReceiptSections({
      status: opts.status,
      result: opts.compactReport.result,
      workdir,
      summary: opts.summary,
      errorMessage: opts.errorMessage,
      dispatchId,
      logicalStage,
      attempt,
      delUsed,
      repUsed,
    });
    verificationText = cleanupSections.verificationText;
    taskResultText = cleanupSections.taskResultText;
    feedbackText = cleanupSections.feedbackText;
    recoveryText = cleanupSections.recoveryText;
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
