import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadWorkspaceConfig,
  normalizeRelativePathList,
} from '../../workspace-config/src/index.js';
import { isParentDir, resolvePath, runGit } from './git.js';
import { type SharedPathStatus, WorkspaceError } from './types.js';

/**
 * Default regenerable runtime/tool cache patterns safe to remove during
 * verified worktree cleanup. Real `.venv` directories are intentionally
 * excluded unless configured via `shared_paths` (symlink) or `cleanable_ignored`.
 */
export const DEFAULT_CLEANABLE_IGNORED: readonly string[] = [
  '.pytest_cache',
  '__pycache__',
  '*.pyc',
  '*.pyo',
  '.ruff_cache',
  '.mypy_cache',
  '.snakemake',
  '.coverage',
  '.coverage.*',
  '.hypothesis',
  '.nox',
  '.tox',
  '.tsbuildinfo',
  '*.tsbuildinfo',
  '.eslintcache',
  '.vite',
  '.turbo',
  'coverage',
  'node_modules',
];

export interface IgnoredCleanupPolicy {
  sharedPaths: string[];
  cleanableIgnored: string[];
  protectedIgnored: string[];
}

export interface WorktreeStatusEntries {
  nonIgnored: string[];
  ignored: string[];
}

export interface IgnoredCleanupPlan {
  safe: boolean;
  symlinksToUnlink: string[];
  pathsToRemove: string[];
  blockingPaths: string[];
}

function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexBody = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexBody}$`);
}

function hasGlobChars(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/**
 * Match a normalized repository-relative path against a normalized rule pattern.
 * Returns the deepest matched relative root path (for collapsing cleanable dirs),
 * or null if the rule does not match.
 */
function matchPatternRoot(relPath: string, pattern: string): string | null {
  const norm = toPosix(relPath);
  if (!norm) return null;

  if (pattern.includes('/')) {
    if (!hasGlobChars(pattern)) {
      if (norm === pattern || norm.startsWith(`${pattern}/`)) {
        return pattern;
      }
      return null;
    }
    return globToRegex(pattern).test(norm) ? norm : null;
  }

  const segments = norm.split('/');
  if (!hasGlobChars(pattern)) {
    const idx = segments.indexOf(pattern);
    if (idx !== -1) {
      return segments.slice(0, idx + 1).join('/');
    }
    return null;
  }

  const regex = globToRegex(pattern);
  for (let idx = 0; idx < segments.length; idx += 1) {
    if (regex.test(segments[idx])) {
      return segments.slice(0, idx + 1).join('/');
    }
  }
  return null;
}

function matchesAnyPattern(relPath: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    const root = matchPatternRoot(relPath, pattern);
    if (root !== null) return root;
  }
  return null;
}

function resolveSymlinkTarget(absLink: string): string | null {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(absLink);
  } catch {
    return null;
  }
  if (!lstat.isSymbolicLink()) return null;
  try {
    const rawTarget = fs.readlinkSync(absLink);
    const absTarget = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(path.dirname(absLink), rawTarget);
    return resolvePath(absTarget);
  } catch {
    return null;
  }
}

/**
 * Check if `relPath` in `worktreeDir` is a managed `shared_paths` symlink
 * pointing to its exact counterpart inside `primaryCheckout`.
 */
export function isManagedSharedSymlink(
  worktreeDir: string,
  primaryCheckout: string,
  relPath: string,
  sharedPaths: readonly string[],
): boolean {
  const norm = toPosix(relPath);
  if (!sharedPaths.includes(norm)) return false;

  const absLink = path.join(worktreeDir, ...norm.split('/'));
  const resolvedTarget = resolveSymlinkTarget(absLink);
  if (!resolvedTarget) return false;

  const expectedTarget = resolvePath(path.join(primaryCheckout, ...norm.split('/')));
  return resolvedTarget === expectedTarget && isParentDir(primaryCheckout, resolvedTarget);
}

/**
 * Load optional `shared_paths`, `cleanable_ignored`, and `protected_ignored`
 * policy from `.paper-craft/workspace-config.json` when present.
 */
export function loadIgnoredCleanupPolicy(repoDir: string): IgnoredCleanupPolicy {
  const loaded = loadWorkspaceConfig({ repoDir });
  if (!loaded) {
    return {
      sharedPaths: [],
      cleanableIgnored: [],
      protectedIgnored: [],
    };
  }
  const parseField = (
    key: 'shared_paths' | 'cleanable_ignored' | 'protected_ignored',
    allowGlobs: boolean,
  ): string[] => {
    const raw = loaded.data[key];
    if (raw === undefined) return [];
    const { items, errors } = normalizeRelativePathList(raw, key, { allowGlobs });
    if (errors.length) {
      throw new WorkspaceError('CONFIG_INVALID', errors.join('; '));
    }
    return items;
  };
  return {
    sharedPaths: parseField('shared_paths', false),
    cleanableIgnored: parseField('cleanable_ignored', true),
    protectedIgnored: parseField('protected_ignored', true),
  };
}

/**
 * List non-ignored and ignored paths from `git status --porcelain=v1 -z`.
 */
export function listWorktreeStatus(worktreeDir: string): WorktreeStatusEntries {
  const res = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignored', '-z'],
    { cwd: worktreeDir, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || '').trim() || `git status failed (${res.status})`;
    throw new WorkspaceError('COMMAND_FAILED', msg, { directory: worktreeDir });
  }

  const nonIgnored: string[] = [];
  const ignored: string[] = [];
  const records = (res.stdout ?? '').split('\0');

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const xy = record.slice(0, 2);
    const entryPath = toPosix(record.slice(3));
    if (xy === '!!') {
      ignored.push(entryPath);
    } else {
      nonIgnored.push(entryPath);
      if (xy[0] === 'R' || xy[0] === 'C') {
        i += 1;
      }
    }
  }

  return { nonIgnored, ignored };
}

/**
 * Classify ignored worktree entries into managed symlinks, safe caches, and
 * blocking entries without mutating the filesystem.
 */
export function planIgnoredCleanup(
  worktreeDir: string,
  primaryCheckout: string,
  ignoredEntries: readonly string[],
  policy: IgnoredCleanupPolicy,
): IgnoredCleanupPlan {
  const symlinks = new Set<string>();
  const removeRoots = new Set<string>();
  const blockingPaths: string[] = [];
  const cleanablePatterns = [...DEFAULT_CLEANABLE_IGNORED, ...policy.cleanableIgnored];

  for (const rawEntry of ignoredEntries) {
    const entry = toPosix(rawEntry);
    if (!entry) continue;

    if (matchesAnyPattern(entry, policy.protectedIgnored) !== null) {
      blockingPaths.push(entry);
      continue;
    }

    if (isManagedSharedSymlink(worktreeDir, primaryCheckout, entry, policy.sharedPaths)) {
      symlinks.add(entry);
      continue;
    }

    const matchedRoot = matchesAnyPattern(entry, cleanablePatterns);
    if (matchedRoot !== null) {
      removeRoots.add(matchedRoot);
    } else {
      blockingPaths.push(entry);
    }
  }

  const sortedRoots = [...removeRoots].sort((a, b) => a.length - b.length);
  const dedupedRoots: string[] = [];
  for (const root of sortedRoots) {
    if (!dedupedRoots.some((parent) => root === parent || root.startsWith(`${parent}/`))) {
      dedupedRoots.push(root);
    }
  }

  return {
    safe: blockingPaths.length === 0,
    symlinksToUnlink: [...symlinks],
    pathsToRemove: dedupedRoots,
    blockingPaths,
  };
}

/**
 * Remove only pre-validated managed symlinks and safe cleanable cache paths.
 */
export function executeIgnoredCleanupPlan(
  worktreeDir: string,
  plan: IgnoredCleanupPlan,
): void {
  if (!plan.safe) {
    throw new WorkspaceError(
      'UNCLEAN_CHECKOUT',
      'Refusing to execute unsafe ignored cleanup plan.',
    );
  }
  for (const relLink of plan.symlinksToUnlink) {
    const absLink = path.join(worktreeDir, ...relLink.split('/'));
    if (fs.lstatSync(absLink).isSymbolicLink()) {
      fs.unlinkSync(absLink);
    }
  }
  for (const relPath of plan.pathsToRemove) {
    const absTarget = path.join(worktreeDir, ...relPath.split('/'));
    try {
      fs.lstatSync(absTarget);
      fs.rmSync(absTarget, { recursive: true, force: true });
    } catch {
      // Path already absent
    }
  }
}

/**
 * Ensure configured `shared_paths` symlinks exist in `targetPath`, verifying
 * each entry is git-ignored and not tracked before linking to `primaryCheckout`.
 */
export function syncSharedPathsInWorktree(
  primaryCheckout: string,
  targetPath: string,
  sharedPaths: readonly string[],
): SharedPathStatus[] {
  const statuses: SharedPathStatus[] = [];

  for (const relPath of sharedPaths) {
    const segments = relPath.split('/');
    const primaryTarget = path.join(primaryCheckout, ...segments);
    const worktreeLink = path.join(targetPath, ...segments);

    if (!isParentDir(primaryCheckout, primaryTarget) || !isParentDir(targetPath, worktreeLink)) {
      throw new WorkspaceError(
        'CONFIG_INVALID',
        `Shared path '${relPath}' resolves outside the repository boundary.`,
      );
    }

    const trackedCheck = runGit(targetPath, 'ls-files', '--error-unmatch', '--', relPath);
    if (trackedCheck.code === 0) {
      throw new WorkspaceError(
        'WORKTREE_CONFLICT',
        `Shared path '${relPath}' is tracked by Git and cannot be symlinked.`,
      );
    }

    const exactIgnored = runGit(targetPath, 'check-ignore', '-q', '--', relPath).code === 0;
    const dirIgnored = runGit(targetPath, 'check-ignore', '-q', '--', `${relPath}/`).code === 0;
    if (!exactIgnored && !dirIgnored) {
      throw new WorkspaceError(
        'CONFIG_INVALID',
        `Shared path '${relPath}' is not ignored by Git. Add '${relPath}' (without trailing slash) to .gitignore.`,
      );
    }

    if (!fs.existsSync(primaryTarget)) {
      statuses.push({ path: relPath, status: 'skipped_absent' });
      continue;
    }

    if (fs.statSync(primaryTarget).isDirectory() && !exactIgnored) {
      throw new WorkspaceError(
        'CONFIG_INVALID',
        `Shared path '${relPath}' is ignored only with a trailing slash ('${relPath}/'), which Git does not apply to symlinks. Add '${relPath}' without a trailing slash to .gitignore.`,
      );
    }

    let existingStat: fs.Stats | null;
    try {
      existingStat = fs.lstatSync(worktreeLink);
    } catch {
      existingStat = null;
    }

    if (existingStat) {
      if (!existingStat.isSymbolicLink()) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Cannot link shared path '${relPath}': a non-symlink already exists at ${worktreeLink}.`,
        );
      }
      const actualTarget = resolveSymlinkTarget(worktreeLink);
      const expectedTarget = resolvePath(primaryTarget);
      if (actualTarget !== expectedTarget) {
        throw new WorkspaceError(
          'WORKTREE_CONFLICT',
          `Existing symlink at '${relPath}' points to '${actualTarget ?? 'invalid'}', expected '${expectedTarget}'.`,
        );
      }
      statuses.push({ path: relPath, status: 'reused' });
      continue;
    }

    fs.mkdirSync(path.dirname(worktreeLink), { recursive: true });
    fs.symlinkSync(primaryTarget, worktreeLink);
    statuses.push({ path: relPath, status: 'linked' });
  }

  return statuses;
}
