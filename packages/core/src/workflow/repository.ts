/**
 * @fileoverview RepositoryManager: unified entrypoint for repository, issue, PR, and Git worktree operations.
 */

import { inspectGitHubIssue } from './repository/issue.js';
import { inspectGitHubPR } from './repository/pr.js';
import {
  createGitWorktree,
  releaseGitWorktree,
  readWorktreeOwner,
  writeWorktreeOwner,
  WorkflowOwnershipError,
  WorkflowCleanupError,
  type CreateWorktreeOptions,
  type ReleaseWorktreeOptions,
  type ReleaseWorktreeResult,
  type WorktreeCreationResult,
  type WorktreeOwnerMarker,
} from './repository/worktree.js';
import type { IssueCheckResult, MergeStatusResult } from './types.js';

export {
  WorkflowOwnershipError,
  WorkflowCleanupError,
  type CreateWorktreeOptions,
  type ReleaseWorktreeOptions,
  type ReleaseWorktreeResult,
  type WorktreeCreationResult,
  type WorktreeOwnerMarker,
};

/**
 * Options for checking a GitHub issue.
 */
export interface CheckIssueOptions {
  /** Target repository in owner/repo format. */
  repository?: string;
}

/**
 * Options for checking pull request merge status and head consistency.
 */
export interface CheckMergeStatusOptions {
  /** Target repository in owner/repo format. */
  repository?: string;
  /** Path to local worktree directory for fallback resolution. */
  worktreePath?: string;
  /** Expected head commit SHA for consistency check against approved review commit. */
  expectedHeadSha?: string;
}

/**
 * Options for initializing RepositoryManager.
 */
export interface RepositoryManagerOptions {
  /** Default repository in owner/repo format. */
  repository?: string;
  /** Default working directory context. */
  cwd?: string;
  /**
   * Internal hook for inspecting issues. Used primarily for testing.
   * @internal
   */
  issueInspector?: (repository: string, issue: number) => Promise<IssueCheckResult>;
  /**
   * Internal hook for inspecting PR merge status. Used primarily for testing.
   * @internal
   */
  prInspector?: (
    repository: string,
    prOrIssue: number | string,
    worktreePath?: string,
  ) => Promise<MergeStatusResult>;
  /**
   * Internal hook for creating worktrees. Used primarily for testing.
   * @internal
   */
  worktreeCreator?: (
    runId: string,
    options?: CreateWorktreeOptions,
  ) => Promise<WorktreeCreationResult>;
  /**
   * Internal hook for releasing worktrees. Used primarily for testing.
   * @internal
   */
  worktreeReleaser?: (
    worktreePath: string,
    expectedRunId: string,
    options?: ReleaseWorktreeOptions,
  ) => Promise<ReleaseWorktreeResult>;
}

/**
 * RepositoryManager provides a unified entrypoint for repository operations,
 * managing issue verification, PR merge status checks, and Git worktree lifecycles.
 */
export class RepositoryManager {
  public readonly repository?: string;
  public readonly cwd?: string;
  private readonly issueInspector: (repository: string, issue: number) => Promise<IssueCheckResult>;
  private readonly prInspector: (
    repository: string,
    prOrIssue: number | string,
    worktreePath?: string,
  ) => Promise<MergeStatusResult>;
  private readonly worktreeCreator: (
    runId: string,
    options?: CreateWorktreeOptions,
  ) => Promise<WorktreeCreationResult>;
  private readonly worktreeReleaser: (
    worktreePath: string,
    expectedRunId: string,
    options?: ReleaseWorktreeOptions,
  ) => Promise<ReleaseWorktreeResult>;

  constructor(options?: RepositoryManagerOptions) {
    this.repository = options?.repository;
    this.cwd = options?.cwd;
    this.issueInspector = options?.issueInspector ?? inspectGitHubIssue;
    this.prInspector = options?.prInspector ?? inspectGitHubPR;
    this.worktreeCreator = options?.worktreeCreator ?? createGitWorktree;
    this.worktreeReleaser = options?.worktreeReleaser ?? releaseGitWorktree;
  }

  /**
   * Checks issue existence, open state, and title.
   * @param issue The issue number.
   * @param options Optional options including repository override, or repository string.
   */
  async checkIssue(
    issue: number,
    options?: CheckIssueOptions | string,
  ): Promise<IssueCheckResult> {
    const repo =
      typeof options === 'string'
        ? options
        : options?.repository ?? this.repository;

    if (!repo) {
      return {
        exists: false,
        error: `Repository must be specified to inspect Issue #${issue}.`,
      };
    }

    return this.issueInspector(repo, issue);
  }

  /**
   * Checks pull request merge status and optional expected head SHA consistency.
   * @param prOrIssue The pull request number, issue number, or branch.
   * @param expectedHeadShaOrOptions Optional expected head SHA string or CheckMergeStatusOptions object.
   * @param maybeOptions Optional CheckMergeStatusOptions when expectedHeadSha is provided as second argument.
   */
  async checkMergeStatus(
    prOrIssue: number | string,
    expectedHeadShaOrOptions?: string | CheckMergeStatusOptions,
    maybeOptions?: CheckMergeStatusOptions,
  ): Promise<MergeStatusResult> {
    let expectedHeadSha: string | undefined;
    let options: CheckMergeStatusOptions | undefined;

    if (typeof expectedHeadShaOrOptions === 'string') {
      expectedHeadSha = expectedHeadShaOrOptions;
      options = maybeOptions;
    } else if (typeof expectedHeadShaOrOptions === 'object') {
      options = expectedHeadShaOrOptions;
      expectedHeadSha = options.expectedHeadSha;
    }

    const repo = options?.repository ?? this.repository;
    if (!repo) {
      return {
        exists: false,
        error: `Repository must be specified to inspect merge status for "${prOrIssue}".`,
      };
    }

    const worktreePath = options?.worktreePath ?? this.cwd;
    const result = await this.prInspector(repo, prOrIssue, worktreePath);

    if (expectedHeadSha !== undefined) {
      const matchesExpectedHead = Boolean(result.headSha && result.headSha === expectedHeadSha);
      return {
        ...result,
        matchesExpectedHead,
      };
    }

    return result;
  }

  /**
   * Creates a dedicated Git worktree for a Run from HEAD on a new codex/ branch.
   * Fails explicitly if directory or branch already exists; does not overwrite or auto-takeover.
   *
   * @param runId Unique Run identifier.
   * @param options Optional creation options including worktreePath, worktreeRoot, branchName, and repository.
   */
  async createWorktree(
    runId: string,
    options?: CreateWorktreeOptions,
  ): Promise<WorktreeCreationResult> {
    const effectiveOptions: CreateWorktreeOptions = {
      cwd: this.cwd,
      repository: this.repository,
      ...options,
    };
    return this.worktreeCreator(runId, effectiveOptions);
  }

  /**
   * Validates run ownership and Git worktree registration, confirms clean working state,
   * and removes the worktree using non-force git worktree remove. Preserves the branch.
   *
   * @param worktreePath Path to the worktree to release.
   * @param expectedRunId Run identifier expected to own the worktree.
   * @param options Optional release options.
   */
  async releaseWorktree(
    worktreePath: string,
    expectedRunId: string,
    options?: ReleaseWorktreeOptions,
  ): Promise<ReleaseWorktreeResult> {
    const effectiveOptions: ReleaseWorktreeOptions = {
      cwd: this.cwd,
      ...options,
    };
    return this.worktreeReleaser(worktreePath, expectedRunId, effectiveOptions);
  }

  /**
   * Reads and parses the .pc-execution-owner marker from a worktree directory.
   * Returns null if missing; throws WorkflowOwnershipError if corrupt or legacy format.
   *
   * @param worktreePath Path to the worktree directory.
   */
  async readWorktreeOwner(worktreePath: string): Promise<WorktreeOwnerMarker | null> {
    return readWorktreeOwner(worktreePath);
  }

  /**
   * Writes the version 1.0 .pc-execution-owner marker to a worktree directory.
   *
   * @param worktreePath Path to the worktree directory.
   * @param marker Version 1.0 ownership marker.
   */
  async writeWorktreeOwner(worktreePath: string, marker: WorktreeOwnerMarker): Promise<void> {
    return writeWorktreeOwner(worktreePath, marker);
  }
}
