/**
 * @fileoverview Worktree submodule for Run.
 * Encapsulates Git worktree operations, checks version 1.0 owner marker,
 * inspects dirty status, and enforces non-force safe retirement.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createGitWorktree,
  releaseGitWorktree,
  readWorktreeOwner,
  checkWorktreeDirty,
  WorkflowOwnershipError,
  WorkflowCleanupError,
} from './repository/worktree.js';

export { WorkflowOwnershipError, WorkflowCleanupError };

/**
 * Information about a prepared worktree.
 */
export interface WorktreeInfo {
  /** Absolute path to the allocated worktree directory. */
  worktreePath: string;
  /** Created or bound Git branch name. */
  branch: string;
  /** Owning Run identifier. */
  runId: string;
  /** Target repository in owner/repo format. */
  repository?: string;
}

/**
 * Inspection facts for a worktree.
 */
export interface WorktreeInspection {
  /** Whether the directory exists on disk. */
  exists: boolean;
  /** Whether the worktree has a valid version 1.0 marker owned by the expected Run. */
  ownedByRun: boolean;
  /** Owner marker version found in .pc-execution-owner. */
  markerVersion?: string;
  /** Whether the worktree has uncommitted or untracked non-tool files. */
  isDirty: boolean;
  /** Description of uncommitted or untracked changes if dirty. */
  dirtyDetails?: string;
}

/**
 * Result of retiring a worktree.
 */
export interface WorktreeRetireResult {
  /** Whether release verification and cleanup completed successfully. */
  retired: boolean;
  /** Target worktree directory path. */
  worktreePath: string;
  /** Error message if retirement was rejected or failed. */
  error?: string;
}

/**
 * Worktree submodule encapsulating isolated Git worktree management for a Run.
 */
export class Worktree {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
  }

  /**
   * Prepares a dedicated Git worktree for the Run.
   * If worktreePath already exists with a valid 1.0 owner marker matching runId, attaches to it.
   * Otherwise allocates a new worktree and branch under codex/<runId>.
   */
  async prepare(
    runId: string,
    options?: {
      worktreePath?: string;
      worktreeRoot?: string;
      branchName?: string;
      repository?: string;
    },
  ): Promise<WorktreeInfo> {
    const candidatePath = path.resolve(
      options?.worktreePath ??
        path.join(options?.worktreeRoot ?? path.join(this.repoRoot, '.worktrees'), runId),
    );
    const existingOwner = await readWorktreeOwner(candidatePath);
    if (existingOwner) {
      if (existingOwner.version !== '1.0') {
        throw new WorkflowOwnershipError(
          `Unsupported owner marker version "${existingOwner.version}". Version "1.0" is strictly required.`,
        );
      }
      if (existingOwner.run_id !== runId) {
        throw new WorkflowOwnershipError(
          `Worktree at "${candidatePath}" is owned by Run "${existingOwner.run_id}", not "${runId}".`,
        );
      }
      return {
        worktreePath: candidatePath,
        branch: options?.branchName ?? `codex/${runId}`,
        runId,
        repository: existingOwner.repository,
      };
    }

    const created = await createGitWorktree(runId, {
      cwd: this.repoRoot,
      worktreePath: options?.worktreePath,
      worktreeRoot: options?.worktreeRoot ?? path.join(this.repoRoot, '.worktrees'),
      branchName: options?.branchName,
      repository: options?.repository,
    });

    return {
      worktreePath: created.worktreePath,
      branch: created.branch,
      runId: created.runId,
      repository: created.repository,
    };
  }

  /**
   * Inspects a worktree path: checks existence, 1.0 owner marker, and dirty state.
   */
  async inspect(worktreePath: string, expectedRunId: string): Promise<WorktreeInspection> {
    try {
      await fs.access(worktreePath);
    } catch {
      return {
        exists: false,
        ownedByRun: false,
        isDirty: false,
      };
    }

    const owner = await readWorktreeOwner(worktreePath);
    if (!owner) {
      return {
        exists: true,
        ownedByRun: false,
        isDirty: false,
      };
    }

    const ownedByRun = owner.run_id === expectedRunId && owner.version === '1.0';
    const dirtyCheck = await checkWorktreeDirty(worktreePath);

    return {
      exists: true,
      ownedByRun,
      markerVersion: owner.version,
      isDirty: dirtyCheck.dirty,
      dirtyDetails: dirtyCheck.details,
    };
  }

  /**
   * Retires a worktree safely without force.
   * Rejects removal if worktree is dirty or foreign-owned.
   */
  async retire(worktreePath: string, expectedRunId: string): Promise<WorktreeRetireResult> {
    const inspection = await this.inspect(worktreePath, expectedRunId);
    if (!inspection.exists) {
      return { retired: true, worktreePath };
    }

    if (!inspection.ownedByRun) {
      throw new WorkflowOwnershipError(
        `Cannot retire worktree "${worktreePath}": not owned by Run "${expectedRunId}" or invalid marker version.`,
      );
    }

    if (inspection.isDirty) {
      throw new WorkflowCleanupError(
        `Cannot retire worktree "${worktreePath}": worktree contains uncommitted or untracked changes: ${inspection.dirtyDetails}`,
      );
    }

    const released = await releaseGitWorktree(worktreePath, expectedRunId, { cwd: this.repoRoot });
    return {
      retired: released.released,
      worktreePath,
      error: released.error,
    };
  }
}
