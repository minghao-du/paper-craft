/**
 * @fileoverview Internal Git worktree management submodule for RepositoryManager.
 * Handles Git worktree creation, run ownership verification, dirty state checking,
 * and safe non-force release without destroying branches.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Marker file name recorded in a worktree root to claim run authority.
 */
export const EXECUTION_OWNER_FILE = '.pc-execution-owner';

/**
 * Task initialization file name written into a worktree.
 */
export const TASK_INITIALIZATION_FILE = 'initialization.json';

/**
 * Custom error raised when a worktree has a conflicting or invalid ownership claim.
 */
export class WorkflowOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowOwnershipError';
  }
}

/**
 * Custom error raised when resource cleanup or preservation verification fails.
 */
export class WorkflowCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowCleanupError';
  }
}

/**
 * Versioned ownership marker recorded in `.pc-execution-owner`.
 * Strictly contains format version, unique run ID, and source repository.
 */
export interface WorktreeOwnerMarker {
  /** Format version (currently strictly "1.0"). */
  version: '1.0';
  /** Unique Run identifier owning this worktree. */
  run_id: string;
  /** Repository in owner/repo format. */
  repository: string;
}

/**
 * Result returned after creating a Git worktree.
 */
export interface WorktreeCreationResult {
  /** Absolute path to the allocated worktree directory. */
  worktreePath: string;
  /** Name of the created Git branch (under codex/). */
  branch: string;
  /** Run ID bound to the worktree. */
  runId: string;
  /** Target repository identifier. */
  repository: string;
}

/**
 * Result returned after releasing a Git worktree.
 */
export interface ReleaseWorktreeResult {
  /** Whether release verification and cleanup completed successfully. */
  released: boolean;
  /** Whether the worktree directory was removed from disk. */
  worktreeRemoved: boolean;
  /** Target worktree directory path. */
  worktreePath: string;
  /** Error message if cleanup was rejected or failed. */
  error?: string;
}

/**
 * Options for creating a Git worktree.
 */
export interface CreateWorktreeOptions {
  /** Root directory for placing worktrees if worktreePath is not provided. */
  worktreeRoot?: string;
  /** Explicit path to target worktree directory. */
  worktreePath?: string;
  /** Target branch name (defaults to codex/<runId>). */
  branchName?: string;
  /** Target repository in owner/repo format. */
  repository?: string;
  /** Base git repository directory (defaults to cwd). */
  cwd?: string;
}

/**
 * Options for releasing a Git worktree.
 */
export interface ReleaseWorktreeOptions {
  /** Base git repository directory (defaults to cwd). */
  cwd?: string;
}

/**
 * Reads and validates the .pc-execution-owner marker from a worktree directory.
 * Strictly verifies version 1.0 format; rejects old or invalid markers without migration.
 *
 * @param worktreePath Path to the worktree directory.
 * @returns Parsed WorktreeOwnerMarker, or null if the file does not exist.
 */
export async function readWorktreeOwner(worktreePath: string): Promise<WorktreeOwnerMarker | null> {
  const markerPath = path.join(worktreePath, EXECUTION_OWNER_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, 'utf8');
  } catch {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new WorkflowOwnershipError(
      `Execution owner marker at "${markerPath}" is corrupted or contains invalid JSON.`,
    );
  }

  if (typeof data !== 'object' || data === null) {
    throw new WorkflowOwnershipError(
      `Execution owner marker at "${markerPath}" is not a valid JSON object.`,
    );
  }

  if (data.version !== '1.0') {
    throw new WorkflowOwnershipError(
      `Unsupported or legacy owner marker version "${String(data.version)}". Version "1.0" is strictly required. Old markers are rejected without migration.`,
    );
  }

  if (typeof data.run_id !== 'string' || !data.run_id.trim()) {
    throw new WorkflowOwnershipError(
      `Execution owner marker at "${markerPath}" is missing a valid "run_id".`,
    );
  }

  if (typeof data.repository !== 'string' || !data.repository.trim()) {
    throw new WorkflowOwnershipError(
      `Execution owner marker at "${markerPath}" is missing a valid "repository".`,
    );
  }

  return {
    version: '1.0',
    run_id: data.run_id,
    repository: data.repository,
  };
}

/**
 * Writes the version 1.0 .pc-execution-owner marker to claim worktree authority.
 *
 * @param worktreePath Path to the worktree directory.
 * @param marker WorktreeOwnerMarker payload.
 */
export async function writeWorktreeOwner(
  worktreePath: string,
  marker: WorktreeOwnerMarker,
): Promise<void> {
  if (marker.version !== '1.0') {
    throw new WorkflowOwnershipError(
      `Cannot write owner marker with version "${marker.version}". Only version "1.0" is supported.`,
    );
  }
  await fs.mkdir(worktreePath, { recursive: true });
  const markerPath = path.join(worktreePath, EXECUTION_OWNER_FILE);
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8');
}

/**
 * Inspects whether a Git branch already exists in local references.
 */
async function gitBranchExists(branch: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely resolves a path to its real path, handling symlinks (e.g. macOS /var -> /private/var).
 */
async function toRealPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Lists all registered Git worktrees for a repository.
 */
async function listRegisteredWorktrees(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd });
    const worktrees: string[] = [];
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const wtPath = line.slice('worktree '.length).trim();
        if (wtPath) {
          const realWt = await toRealPath(wtPath);
          worktrees.push(realWt);
        }
      }
    }
    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Checks if a worktree directory has uncommitted tracked changes or untracked user files.
 * Ignores tool-managed metadata files (.pc-execution-owner and initialization.json).
 */
export async function checkWorktreeDirty(worktreePath: string): Promise<{ dirty: boolean; details?: string }> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
      cwd: worktreePath,
    });
    const lines = stdout.split('\n').filter(Boolean);
    const nonToolChanges: string[] = [];

    for (const line of lines) {
      const filePath = line.slice(3).trim();
      if (filePath === EXECUTION_OWNER_FILE || filePath === TASK_INITIALIZATION_FILE) {
        continue;
      }
      nonToolChanges.push(line);
    }

    if (nonToolChanges.length > 0) {
      return {
        dirty: true,
        details: nonToolChanges.join('; '),
      };
    }
    return { dirty: false };
  } catch (err) {
    return {
      dirty: true,
      details: `Failed to inspect git status: ${(err as Error).message}`,
    };
  }
}

/**
 * Creates a dedicated Git worktree for a Run.
 * - Checks that branch and directory do not already exist; refuses to overwrite or auto-takeover.
 * - Creates a new branch under codex/ from creation HEAD.
 * - Writes version 1.0 owner marker.
 * - Cleans up only what was confirmed created in this step if mid-creation failure occurs.
 *
 * @param runId Unique Run identifier.
 * @param options Worktree creation options.
 */
export async function createGitWorktree(
  runId: string,
  options?: CreateWorktreeOptions,
): Promise<WorktreeCreationResult> {
  const cwd = options?.cwd ?? process.cwd();
  const repository = options?.repository ?? '';

  // Determine branch name (defaults to codex/<runId>)
  const branchName = options?.branchName ?? `codex/${runId}`;

  // Determine target worktree path
  let targetPath: string;
  if (options?.worktreePath) {
    targetPath = path.resolve(options.worktreePath);
  } else if (options?.worktreeRoot) {
    targetPath = path.resolve(options.worktreeRoot, runId);
  } else {
    targetPath = path.resolve(cwd, '.worktrees', runId);
  }

  // Check 1: Directory already exists on disk
  let dirExists: boolean;
  try {
    await fs.access(targetPath);
    dirExists = true;
  } catch {
    dirExists = false;
  }
  if (dirExists) {
    throw new WorkflowOwnershipError(
      `Worktree directory "${targetPath}" already exists. Refusing to overwrite or auto-takeover existing directory.`,
    );
  }

  // Check 2: Branch already exists in Git
  const branchExists = await gitBranchExists(branchName, cwd);
  if (branchExists) {
    throw new WorkflowOwnershipError(
      `Git branch "${branchName}" already exists. Refusing to overwrite or auto-takeover existing branch.`,
    );
  }

  // Check 3: Already registered in git worktree list
  const realTargetPath = await toRealPath(targetPath);
  const registered = await listRegisteredWorktrees(cwd);
  if (registered.includes(realTargetPath)) {
    throw new WorkflowOwnershipError(
      `Worktree path "${targetPath}" is already registered in Git. Refusing to overwrite or auto-takeover existing worktree.`,
    );
  }

  // Track created resources for clean rollback on mid-creation failure
  let gitWorktreeCreated = false;
  let gitBranchCreated = false;

  try {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Execute git worktree add -b <branchName> <targetPath> HEAD
    await execFileAsync('git', ['worktree', 'add', '-b', branchName, targetPath, 'HEAD'], { cwd });
    gitWorktreeCreated = true;
    gitBranchCreated = true;

    // Write version 1.0 ownership marker
    const marker: WorktreeOwnerMarker = {
      version: '1.0',
      run_id: runId,
      repository,
    };
    await writeWorktreeOwner(targetPath, marker);

    return {
      worktreePath: targetPath,
      branch: branchName,
      runId,
      repository,
    };
  } catch (err) {
    // Rollback only resources confirmed created in this step
    if (gitWorktreeCreated) {
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', targetPath], { cwd });
      } catch {
        // Ignore secondary cleanup error
      }
    }
    if (gitBranchCreated) {
      try {
        await execFileAsync('git', ['branch', '-D', branchName], { cwd });
      } catch {
        // Ignore secondary cleanup error
      }
    }
    throw err;
  }
}

/**
 * Releases a Git worktree:
 * - Validates version 1.0 ownership marker (.pc-execution-owner).
 * - Validates Git worktree registration.
 * - Checks for uncommitted user changes (dirty check); blocks release if dirty.
 * - Removes tool metadata files so they do not obstruct non-force remove.
 * - Invokes non-force `git worktree remove`.
 * - Preserves branch (never deletes branch, never runs global prune, never uses fs.rm).
 *
 * @param worktreePath Path to the worktree to release.
 * @param expectedRunId Run ID expected to own the worktree.
 * @param options Release options.
 */
export async function releaseGitWorktree(
  worktreePath: string,
  expectedRunId: string,
  options?: ReleaseWorktreeOptions,
): Promise<ReleaseWorktreeResult> {
  const cwd = options?.cwd ?? process.cwd();
  const resolvedPath = path.resolve(worktreePath);

  // Check 1: Check directory existence
  let dirExists: boolean;
  try {
    const st = await fs.stat(resolvedPath);
    dirExists = st.isDirectory();
  } catch {
    dirExists = false;
  }

  const realResolvedPath = await toRealPath(resolvedPath);

  if (!dirExists) {
    // Directory is already gone from disk
    const registered = await listRegisteredWorktrees(cwd);
    if (!registered.includes(realResolvedPath)) {
      return {
        released: true,
        worktreeRemoved: false,
        worktreePath: resolvedPath,
      };
    }
  }

  // Check 2: Ownership verification
  let marker: WorktreeOwnerMarker | null;
  try {
    marker = await readWorktreeOwner(resolvedPath);
  } catch (err) {
    return {
      released: false,
      worktreeRemoved: false,
      worktreePath: resolvedPath,
      error: `Cannot release worktree: ${(err as Error).message}`,
    };
  }

  if (!marker) {
    return {
      released: false,
      worktreeRemoved: false,
      worktreePath: resolvedPath,
      error: `Cannot release worktree: ${EXECUTION_OWNER_FILE} marker is missing at "${resolvedPath}". Refusing to release unverified directory.`,
    };
  }

  if (marker.run_id !== expectedRunId) {
    return {
      released: false,
      worktreeRemoved: false,
      worktreePath: resolvedPath,
      error: `Cannot release worktree: ownership mismatch. Worktree belongs to run "${marker.run_id}", not "${expectedRunId}". Refusing to release foreign worktree.`,
    };
  }

  // Check 3: Git registration check
  const registered = await listRegisteredWorktrees(cwd);
  if (!registered.includes(realResolvedPath)) {
    return {
      released: false,
      worktreeRemoved: false,
      worktreePath: resolvedPath,
      error: `Directory "${resolvedPath}" is not registered as a Git worktree. Refusing to remove.`,
    };
  }

  // Check 4: Dirty check (uncommitted user changes or untracked user files)
  const dirtyCheck = await checkWorktreeDirty(resolvedPath);
  if (dirtyCheck.dirty) {
    return {
      released: false,
      worktreeRemoved: false,
      worktreePath: resolvedPath,
      error: `Cannot release worktree: worktree contains uncommitted changes or untracked user files: ${dirtyCheck.details}. Refusing to release dirty directory.`,
    };
  }

  // Clean up tool metadata files so non-force git worktree remove is not blocked by them
  try {
    await fs.unlink(path.join(resolvedPath, EXECUTION_OWNER_FILE));
  } catch {
    // Ignore if already removed
  }
  try {
    await fs.unlink(path.join(resolvedPath, TASK_INITIALIZATION_FILE));
  } catch {
    // Ignore if not present
  }

  // Check 5: Execute non-force git worktree remove
  try {
    await execFileAsync('git', ['worktree', 'remove', resolvedPath], { cwd });
    return {
      released: true,
      worktreeRemoved: true,
      worktreePath: resolvedPath,
    };
  } catch (err) {
    return {
      released: false,
      worktreeRemoved: false,
      worktreePath: resolvedPath,
      error: `Failed to remove Git worktree at "${resolvedPath}": ${(err as Error).message}.`,
    };
  }
}
