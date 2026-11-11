import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceError } from './types.js';

export interface WorktreeEntry {
  worktree: string;
  HEAD: string;
  branch?: string;
  locked?: boolean;
  prunable?: boolean;
}

/**
 * Resolve symlink prefixes and return canonical absolute path,
 * matching pathlib.resolve(strict=False).
 */
export function resolvePath(value: string): string {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) {
    try {
      return fs.realpathSync(absolute);
    } catch {
      return absolute;
    }
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(resolvePath(parent), path.basename(absolute));
}

/**
 * Check if parent path is equal to or an ancestor of child path.
 */
export function isParentDir(parent: string, child: string): boolean {
  const p = resolvePath(parent);
  const c = resolvePath(child);
  if (p === c) return true;
  const rel = path.relative(p, c);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Execute a git command and return status code, trimmed stdout and stderr.
 */
export function runGit(
  directory: string,
  ...args: string[]
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? String(result.error ?? ''),
  };
}

/**
 * Execute a git command, returning stdout if successful or throwing WorkspaceError('COMMAND_FAILED').
 */
export function git(directory: string, ...args: string[]): string {
  const { code, stdout, stderr } = runGit(directory, ...args);
  if (code !== 0) {
    const errorMsg = stderr || stdout || `git ${args.join(' ')} failed with exit code ${code}`;
    throw new WorkspaceError('COMMAND_FAILED', errorMsg, {
      directory,
      command: args,
      code,
      stdout,
      stderr,
    });
  }
  return stdout;
}

/**
 * Verify repository is clean. Throws WorkspaceError('UNCLEAN_CHECKOUT') if untracked or modified files exist.
 */
export function requireClean(directory: string): void {
  const { code, stdout, stderr } = runGit(directory, 'status', '--porcelain', '--untracked-files=all');
  if (code !== 0) {
    throw new WorkspaceError('COMMAND_FAILED', stderr || stdout || 'git status failed', {
      directory,
      code,
    });
  }
  if (stdout.length > 0) {
    throw new WorkspaceError(
      'UNCLEAN_CHECKOUT',
      `Uncommitted changes in ${directory}. Preserve them and resolve before retrying.`,
      { directory, status: stdout },
    );
  }
}

/**
 * Check if repository is clean without throwing.
 */
export function isClean(
  directory: string,
  options?: { includeIgnored?: boolean },
): boolean {
  const args = ['status', '--porcelain', '--untracked-files=all'];
  if (options?.includeIgnored) {
    args.push('--ignored');
  }
  const { code, stdout } = runGit(directory, ...args);
  return code === 0 && stdout.trim() === '';
}

/**
 * Parse `git worktree list --porcelain` output (supporting both newline and -z formats).
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  if (!output || !output.trim()) return [];
  const entries: WorktreeEntry[] = [];

  const rawRecords = output.includes('\0')
    ? output.split(/\0\0+/).map((r) => r.split('\0').filter(Boolean))
    : output.split(/\r?\n\r?\n+/).map((r) => r.split(/\r?\n/).filter(Boolean));

  for (const lines of rawRecords) {
    if (lines.length === 0) continue;
    let worktree = '';
    let head = '';
    let branch: string | undefined;
    let locked = false;
    let prunable = false;

    for (const line of lines) {
      const spaceIdx = line.indexOf(' ');
      const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
      const val = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);

      if (key === 'worktree') {
        worktree = resolvePath(val);
      } else if (key === 'HEAD') {
        head = val;
      } else if (key === 'branch') {
        branch = val;
      } else if (key === 'locked') {
        locked = true;
      } else if (key === 'prunable') {
        prunable = true;
      }
    }

    if (worktree) {
      entries.push({
        worktree,
        HEAD: head,
        ...(branch !== undefined ? { branch } : {}),
        ...(locked ? { locked: true } : {}),
        ...(prunable ? { prunable: true } : {}),
      });
    }
  }

  return entries;
}

/**
 * List all registered worktrees for a repository checkout.
 */
export function listWorktrees(directory: string): WorktreeEntry[] {
  const output = git(directory, 'worktree', 'list', '--porcelain', '-z');
  return parseWorktreeList(output);
}

/**
 * Find top-level root directory of git repository.
 */
export function findRepoRoot(directory: string): string {
  const { code, stdout } = runGit(directory, 'rev-parse', '--show-toplevel');
  if (code !== 0 || !stdout) {
    throw new WorkspaceError('REPOSITORY_NOT_FOUND', `Directory is not a git repository: ${directory}`);
  }
  return resolvePath(stdout);
}

/**
 * Find primary checkout from `git worktree list --porcelain`.
 */
export function findPrimaryCheckout(directory: string): string {
  const output = git(directory, 'worktree', 'list', '--porcelain');
  const entries = parseWorktreeList(output);
  if (entries.length === 0) {
    throw new WorkspaceError('REPOSITORY_NOT_FOUND', `Cannot determine primary checkout for repository at ${directory}`);
  }
  return entries[0].worktree;
}

/**
 * Get git common dir (`git rev-parse --path-format=absolute --git-common-dir`).
 */
export function getGitCommonDir(directory: string): string {
  const { code, stdout } = runGit(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (code === 0 && stdout) {
    return resolvePath(stdout);
  }
  const fallback = git(directory, 'rev-parse', '--git-common-dir');
  return resolvePath(path.isAbsolute(fallback) ? fallback : path.resolve(directory, fallback));
}

/**
 * Check if ancestor is an ancestor of descendant commit.
 */
export function isAncestor(directory: string, ancestor: string, descendant: string): boolean {
  const { code } = runGit(directory, 'merge-base', '--is-ancestor', ancestor, descendant);
  return code === 0;
}

/**
 * Check if ref format is valid according to git rules.
 */
export function checkRefFormat(
  directory: string,
  ref: string,
  options?: { branch?: boolean },
): boolean {
  const args = options?.branch
    ? ['check-ref-format', '--branch', ref]
    : ['check-ref-format', ref];
  const { code } = runGit(directory, ...args);
  return code === 0;
}

/**
 * Check if a local branch exists (`refs/heads/<branch>`).
 */
export function branchExists(directory: string, branch: string): boolean {
  const { code } = runGit(directory, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
  return code === 0;
}

/**
 * Get current HEAD commit SHA of directory.
 */
export function getHeadCommit(directory: string): string {
  return git(directory, 'rev-parse', 'HEAD');
}

/**
 * Resolve commit SHA from revision expression.
 */
export function getCommitSha(directory: string, rev: string): string {
  return git(directory, 'rev-parse', '--verify', `${rev}^{commit}`);
}

/**
 * Verify whether string is a 40-character or 64-character hex commit SHA.
 */
export function isValidCommitSha(commit: string): boolean {
  return /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(commit);
}

/**
 * Fetch a ref from remote into local ref namespace.
 */
export function fetchRef(directory: string, remote: string, refspec: string): void {
  git(directory, 'fetch', remote, refspec);
}

/**
 * List git remotes configured in repository.
 */
export function listRemotes(directory: string): string[] {
  const { code, stdout } = runGit(directory, 'remote');
  if (code !== 0 || !stdout) return [];
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Get remote URL.
 */
export function getRemoteUrl(directory: string, remote: string): string {
  return git(directory, 'remote', 'get-url', remote);
}

/**
 * Remove a registered worktree.
 */
export function removeWorktree(
  directory: string,
  worktreePath: string,
  options?: { force?: boolean },
): void {
  const args = ['worktree', 'remove'];
  if (options?.force) args.push('--force');
  args.push(worktreePath);
  git(directory, ...args);
}

/**
 * Delete a local branch.
 */
export function deleteBranch(
  directory: string,
  branch: string,
  options?: { force?: boolean },
): void {
  const flag = options?.force ? '-D' : '-d';
  git(directory, 'branch', flag, branch);
}

/**
 * Delete a ref directly via git update-ref -d.
 */
export function updateRefDelete(directory: string, ref: string, oldSha?: string): void {
  const args = ['update-ref', '-d', ref];
  if (oldSha) args.push(oldSha);
  git(directory, ...args);
}

/**
 * Remove a local git configuration section for a branch.
 */
export function removeBranchConfig(directory: string, branch: string): void {
  const { code, stdout } = runGit(directory, 'config', '--local', '--list');
  if (code === 0 && stdout) {
    const sectionPrefix = `branch.${branch}.`;
    if (stdout.split(/\r?\n/).some((line) => line.startsWith(sectionPrefix))) {
      runGit(directory, 'config', '--local', '--remove-section', `branch.${branch}`);
    }
  }
}
