/**
 * @fileoverview RepositoryManager: unified entrypoint for repository, issue, and PR operations.
 */

import { inspectGitHubIssue } from './repository/issue.js';
import { inspectGitHubPR } from './repository/pr.js';
import type { IssueCheckResult, MergeStatusResult } from './types.js';

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
}

/**
 * RepositoryManager provides a unified entrypoint for repository operations,
 * managing issue verification and PR merge status checks.
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

  constructor(options?: RepositoryManagerOptions) {
    this.repository = options?.repository;
    this.cwd = options?.cwd;
    this.issueInspector = options?.issueInspector ?? inspectGitHubIssue;
    this.prInspector = options?.prInspector ?? inspectGitHubPR;
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
}
