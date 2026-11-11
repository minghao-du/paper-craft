import fs from 'node:fs';
import path from 'node:path';
import {
  branchExists,
  checkRefFormat,
  fetchRef,
  findPrimaryCheckout,
  findRepoRoot,
  getCommitSha,
  getGitCommonDir,
  getHeadCommit,
  getRemoteUrl,
  isParentDir,
  isValidCommitSha,
  listRemotes,
  listWorktrees,
  requireClean,
  resolvePath,
  git,
  type WorktreeEntry,
} from './git.js';
import {
  WorkspaceError,
  type PrepareRequest,
  type PreparedWorkspace,
  type WorkspaceOverrides,
} from './types.js';
import {
  resolveWorkspaceConfig,
  parseRepoFromUrl,
  type ResolvedWorkspaceConfig,
} from '../../workspace-config/src/config.js';

interface ResolveOptions {
  repoDir: string;
  configPath?: string;
  requireFile?: boolean;
  overrides?: Record<string, unknown>;
}

/**
 * Invoke resolveWorkspaceConfig, supporting both options object and legacy signature.
 */
function invokeResolveConfig(options: ResolveOptions): ResolvedWorkspaceConfig {
  const resolveFn = resolveWorkspaceConfig as unknown as (
    optionsOrRepoDir: ResolveOptions | string,
    overrides?: Record<string, unknown>,
    requireFile?: boolean,
  ) => ResolvedWorkspaceConfig;

  try {
    return resolveFn(options);
  } catch (err: unknown) {
    if (
      err instanceof TypeError &&
      typeof err.message === 'string' &&
      err.message.includes('cwd')
    ) {
      return resolveFn(options.repoDir, options.overrides, options.requireFile ?? false);
    }
    throw err;
  }
}

/**
 * Map WorkspaceOverrides (camelCase) to workspace-config format (snake_case).
 */
function mapOverrides(overrides?: WorkspaceOverrides): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!overrides) return result;
  if (overrides.deliveryTarget) result.delivery_target = overrides.deliveryTarget;
  if (overrides.baseRemote) result.base_remote = overrides.baseRemote;
  if (overrides.pushRemote) result.push_remote = overrides.pushRemote;
  if (overrides.baseBranch) result.base_branch = overrides.baseBranch;
  if (overrides.worktreeContainer) result.worktree_container = overrides.worktreeContainer;
  return result;
}

/**
 * Prepare, create, or validate and reuse a git worktree.
 *
 * Implements Section 6.1 of WORKSPACE_TYPESCRIPT_REFACTOR_PLAN.md.
 */
export function prepare(request: PrepareRequest): PreparedWorkspace {
  if (!request || !request.sourceCheckout) {
    throw new WorkspaceError('INVALID_INPUT', 'sourceCheckout is required');
  }
  if (!request.target) {
    throw new WorkspaceError('INVALID_INPUT', 'target is required');
  }

  const rawSource = request.sourceCheckout;
  if (!fs.existsSync(rawSource) || !fs.statSync(rawSource).isDirectory()) {
    throw new WorkspaceError('REPOSITORY_NOT_FOUND', `Source checkout directory does not exist: ${rawSource}`);
  }

  // Validate git repository
  let source: string;
  try {
    source = findRepoRoot(rawSource);
  } catch {
    throw new WorkspaceError('REPOSITORY_NOT_FOUND', `Source directory is not a git repository: ${rawSource}`);
  }

  // Validate cleanliness of source checkout
  requireClean(source);

  // Validate target input
  const { target } = request;
  let targetBranch: string | null = null;
  let targetExplicitPath: string | undefined;
  let expectedHead: string | undefined;

  if (target.kind === 'issue') {
    if (!Number.isInteger(target.issue) || target.issue <= 0) {
      throw new WorkspaceError('INVALID_INPUT', `Issue number must be a positive integer, received: ${target.issue}`);
    }
    if (target.branch !== undefined) {
      if (typeof target.branch !== 'string' || !target.branch.trim()) {
        throw new WorkspaceError('INVALID_INPUT', 'Explicit branch must be a non-empty string');
      }
      if (!checkRefFormat(source, target.branch, { branch: true })) {
        throw new WorkspaceError('INVALID_INPUT', `Invalid branch format: '${target.branch}'`);
      }
      targetBranch = target.branch;
    } else {
      targetBranch = `issue-${target.issue}`;
    }
    targetExplicitPath = target.path;
    expectedHead = target.expectedHead;
  } else if (target.kind === 'branch') {
    if (typeof target.branch !== 'string' || !target.branch.trim()) {
      throw new WorkspaceError('INVALID_INPUT', 'Branch is required for branch target');
    }
    if (!checkRefFormat(source, target.branch, { branch: true })) {
      throw new WorkspaceError('INVALID_INPUT', `Invalid branch format: '${target.branch}'`);
    }
    if (typeof target.path !== 'string' || !target.path.trim()) {
      throw new WorkspaceError('INVALID_INPUT', 'Path is required for branch target');
    }
    targetBranch = target.branch;
    targetExplicitPath = target.path;
    expectedHead = target.expectedHead;
  } else if (target.kind === 'detached') {
    if (typeof target.commit !== 'string' || !isValidCommitSha(target.commit)) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Commit must be a 40-character or 64-character hex SHA, received: '${target.commit}'`,
      );
    }
    if (typeof target.path !== 'string' || !target.path.trim()) {
      throw new WorkspaceError('INVALID_INPUT', 'Path is required for detached target');
    }
    targetBranch = null;
    targetExplicitPath = target.path;
  } else {
    const unknownKind = (target as { kind?: unknown }).kind;
    throw new WorkspaceError('INVALID_INPUT', `Unknown target kind: '${String(unknownKind)}'`);
  }

  // Resolve configuration
  let config: ResolvedWorkspaceConfig;
  try {
    config = invokeResolveConfig({
      repoDir: source,
      configPath: request.configPath,
      overrides: mapOverrides(request.overrides),
    });
  } catch (err: unknown) {
    if (err instanceof WorkspaceError) throw err;
    throw new WorkspaceError('CONFIG_INVALID', (err as Error).message);
  }

  // Validate expected repository if specified
  if (request.expectedRepository && request.expectedRepository !== 'local/repo') {
    let matched = request.expectedRepository === config.delivery_target;
    if (!matched) {
      const remotes = listRemotes(source);
      for (const r of remotes) {
        try {
          const rUrl = getRemoteUrl(source, r);
          const parsed = parseRepoFromUrl(rUrl);
          if (parsed === request.expectedRepository) {
            matched = true;
            break;
          }
        } catch {
          // Ignore remote lookup failure
        }
      }
    }
    if (!matched) {
      throw new WorkspaceError(
        'REPOSITORY_NOT_FOUND',
        `Expected repository '${request.expectedRepository}', observed '${config.delivery_target}'.`,
        { expected: request.expectedRepository, observed: config.delivery_target },
      );
    }
  }

  // Determine final target path
  let targetPath: string;
  if (targetExplicitPath) {
    targetPath = resolvePath(targetExplicitPath);
  } else if (target.kind === 'issue') {
    targetPath = resolvePath(path.join(config.worktree_container_resolved, `issue-${target.issue}`));
  } else {
    throw new WorkspaceError('INVALID_INPUT', 'Target path could not be resolved');
  }

  // Check protected base branch constraint
  if (targetBranch !== null) {
    if (targetBranch === config.base_branch) {
      throw new WorkspaceError(
        'INVALID_INPUT',
        `Expected an issue branch, received protected base branch '${targetBranch}'.`,
      );
    }
    if (!checkRefFormat(source, `refs/heads/${targetBranch}`)) {
      throw new WorkspaceError('INVALID_INPUT', `Invalid branch reference format: 'refs/heads/${targetBranch}'`);
    }
  }

  // Query existing registered worktrees
  const worktrees = listWorktrees(source);
  const primary = findPrimaryCheckout(source);

  // Match existing worktree
  let matchedEntry: WorktreeEntry | undefined;
  if (targetBranch === null) {
    // Detached mode: match by worktree path
    matchedEntry = worktrees.find((w) => resolvePath(w.worktree) === targetPath);
  } else {
    // Branch mode
    const matchingByBranch = worktrees.filter((w) => w.branch === `refs/heads/${targetBranch}`);
    if (matchingByBranch.length > 1) {
      throw new WorkspaceError(
        'WORKTREE_CONFLICT',
        `Branch '${targetBranch}' is registered in multiple worktrees. Resolve the ambiguity first.`,
      );
    }
    const matchingByPath = worktrees.find((w) => resolvePath(w.worktree) === targetPath);

    if (matchingByBranch.length === 1) {
      const existingBranchPath = resolvePath(matchingByBranch[0].worktree);
      if (existingBranchPath !== targetPath) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Branch '${targetBranch}' is already checked out at ${existingBranchPath}.`,
          { branch: targetBranch, existingPath: existingBranchPath, requestedPath: targetPath },
        );
      }
      matchedEntry = matchingByBranch[0];
    } else if (matchingByPath) {
      if (matchingByPath.branch !== `refs/heads/${targetBranch}`) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Worktree at ${targetPath} is registered for branch '${matchingByPath.branch ?? 'detached'}', expected 'refs/heads/${targetBranch}'.`,
        );
      }
      matchedEntry = matchingByPath;
    }
  }

  const isExisting = Boolean(matchedEntry);

  // Directory safety constraints
  if (targetPath === primary || isParentDir(primary, targetPath) || isParentDir(targetPath, primary)) {
    throw new WorkspaceError(
      'WORKTREE_CONFLICT',
      `Target path cannot be primary checkout or inside/containing it: ${targetPath}`,
      { targetPath, primary },
    );
  }
  if (isParentDir(source, targetPath) || isParentDir(targetPath, source) || (targetPath === source && !isExisting)) {
    throw new WorkspaceError(
      'WORKTREE_CONFLICT',
      `Target path cannot occupy or contain source checkout: ${targetPath}`,
      { targetPath, sourceCheckout: source },
    );
  }

  let disposition: 'created' | 'reused';
  let finalCommit: string;

  if (isExisting) {
    // REUSE existing registered worktree
    if (!fs.existsSync(targetPath)) {
      throw new WorkspaceError(
        'WORKTREE_CONFLICT',
        `Registered worktree is missing at ${targetPath}. Restore it before retrying.`,
        { targetPath },
      );
    }

    // Verify common git directory matches
    const sourceCommon = getGitCommonDir(source);
    const targetCommon = getGitCommonDir(targetPath);
    if (sourceCommon !== targetCommon) {
      throw new WorkspaceError(
        'WORKTREE_CONFLICT',
        `Worktree ${targetPath} belongs to another repository.`,
        { sourceCommon, targetCommon },
      );
    }

    // Verify worktree cleanliness
    requireClean(targetPath);

    // Verify branch or commit
    if (target.kind === 'detached') {
      const currentCommit = getHeadCommit(targetPath);
      if (currentCommit !== target.commit) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Worktree ${targetPath} HEAD does not match expected commit '${target.commit}'. Found: '${currentCommit}'.`,
        );
      }
    } else {
      const currentBranch = git(targetPath, 'branch', '--show-current');
      if (currentBranch !== targetBranch) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Worktree ${targetPath} is on unexpected branch '${currentBranch}', expected '${targetBranch}'.`,
        );
      }
    }

    // Verify expectedHead if specified
    finalCommit = getHeadCommit(targetPath);
    if (expectedHead) {
      let expectedSha = expectedHead;
      try {
        expectedSha = getCommitSha(targetPath, expectedHead);
      } catch {
        // Fall back to literal string comparison if revision cannot be parsed
      }
      if (finalCommit !== expectedSha && finalCommit !== expectedHead) {
        throw new WorkspaceError(
          'HEAD_MISMATCH',
          `Expected predecessor HEAD ${expectedHead}, found ${finalCommit}.`,
          { expectedHead, actualHead: finalCommit, targetPath },
        );
      }
    }

    disposition = 'reused';
  } else {
    // CREATE new worktree
    if (expectedHead) {
      throw new WorkspaceError(
        'WORKTREE_CONFLICT',
        'Cannot create new worktree when expectedHead is specified; expectedHead requires reusing an existing worktree',
      );
    }

    // Check if target directory already exists and is non-empty
    if (fs.existsSync(targetPath)) {
      const isDir = fs.statSync(targetPath).isDirectory();
      const isEmpty = isDir && fs.readdirSync(targetPath).length === 0;
      if (!isEmpty) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Target directory already exists and is not a registered worktree: ${targetPath}`,
          { targetPath },
        );
      }
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (targetBranch !== null) {
      const localBranchExists = branchExists(source, targetBranch);
      if (localBranchExists) {
        const isCheckedOut = worktrees.some((w) => w.branch === `refs/heads/${targetBranch}`);
        if (isCheckedOut) {
          throw new WorkspaceError(
            'WORKTREE_CONFLICT',
            `Branch '${targetBranch}' exists and is already checked out in another worktree.`,
          );
        }
        git(source, 'worktree', 'add', targetPath, targetBranch);
      } else {
        try {
          fetchRef(
            source,
            config.base_remote,
            `+refs/heads/${config.base_branch}:refs/remotes/${config.base_remote}/${config.base_branch}`,
          );
        } catch {
          // May be offline or local bare repo without active fetch; proceed
        }
        const startPoint = `${config.base_remote}/${config.base_branch}`;
        git(source, 'worktree', 'add', '--no-track', '-b', targetBranch, targetPath, startPoint);
      }
    } else if (target.kind === 'detached') {
      // Detached mode
      try {
        getCommitSha(source, target.commit);
      } catch {
        throw new WorkspaceError(
          'INVALID_INPUT',
          `Commit '${target.commit}' is not accessible in repository.`,
          { commit: target.commit },
        );
      }
      git(source, 'worktree', 'add', '--detach', targetPath, target.commit);
    }

    // Post-creation checks
    const targetCommon = getGitCommonDir(targetPath);
    const sourceCommon = getGitCommonDir(source);
    if (targetCommon !== sourceCommon) {
      throw new WorkspaceError(
        'WORKTREE_CONFLICT',
        `Worktree ${targetPath} belongs to another repository.`,
      );
    }

    requireClean(targetPath);

    if (targetBranch !== null) {
      const currentBranch = git(targetPath, 'branch', '--show-current');
      if (currentBranch !== targetBranch) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Worktree ${targetPath} is on unexpected branch '${currentBranch}', expected '${targetBranch}'.`,
        );
      }
    }

    finalCommit = getHeadCommit(targetPath);
    disposition = 'created';
  }

  return {
    repository: config.delivery_target,
    deliveryTarget: config.delivery_target,
    sourceCheckout: source,
    path: targetPath,
    branch: targetBranch,
    commit: finalCommit,
    baseBranch: config.base_branch,
    baseRemote: config.base_remote,
    pushRemote: config.push_remote,
    disposition,
  };
}
