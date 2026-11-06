/**
 * @fileoverview Tests for RepositoryManager unified repository, issue, and PR operations.
 */

import { describe, expect, it } from 'vitest';
import { RepositoryManager } from '../../packages/core/src/workflow/repository.js';

describe('RepositoryManager', () => {
  describe('checkIssue', () => {
    it('requires repository to be specified either in options or constructor', async () => {
      const manager = new RepositoryManager();
      const result = await manager.checkIssue(1);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('Repository must be specified');
    });

    it('uses constructor repository when not provided in method call', async () => {
      let inspectedRepo = '';
      let inspectedIssue = 0;
      const manager = new RepositoryManager({
        repository: 'owner/default-repo',
        issueInspector: async (repo, issue) => {
          inspectedRepo = repo;
          inspectedIssue = issue;
          return { exists: true, open: true, title: 'Test Issue' };
        },
      });

      const result = await manager.checkIssue(42);
      expect(inspectedRepo).toBe('owner/default-repo');
      expect(inspectedIssue).toBe(42);
      expect(result.exists).toBe(true);
      expect(result.open).toBe(true);
      expect(result.title).toBe('Test Issue');
    });

    it('allows overriding repository via options or string argument', async () => {
      let inspectedRepo = '';
      const manager = new RepositoryManager({
        repository: 'owner/default-repo',
        issueInspector: async (repo, _issue) => {
          inspectedRepo = repo;
          return { exists: true, open: false, title: 'Closed Issue' };
        },
      });

      await manager.checkIssue(10, 'owner/override-repo-1');
      expect(inspectedRepo).toBe('owner/override-repo-1');

      await manager.checkIssue(10, { repository: 'owner/override-repo-2' });
      expect(inspectedRepo).toBe('owner/override-repo-2');
    });

    it('returns error result when issue inspection reports failure', async () => {
      const manager = new RepositoryManager({
        repository: 'owner/repo',
        issueInspector: async (_repo, issue) => ({
          exists: false,
          error: `Issue #${issue} not found in repository "owner/repo".`,
        }),
      });

      const result = await manager.checkIssue(999);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('Issue #999 not found');
    });
  });

  describe('checkMergeStatus', () => {
    it('requires repository to be specified either in options or constructor', async () => {
      const manager = new RepositoryManager();
      const result = await manager.checkMergeStatus(10);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('Repository must be specified');
    });

    it('returns merge status and verifies expectedHeadSha consistency when matching', async () => {
      const manager = new RepositoryManager({
        repository: 'owner/repo',
        prInspector: async (_repo, _pr) => ({
          exists: true,
          headSha: 'commit-approved-abc',
          state: 'OPEN',
          merged: false,
        }),
      });

      const result = await manager.checkMergeStatus(15, 'commit-approved-abc');
      expect(result.exists).toBe(true);
      expect(result.headSha).toBe('commit-approved-abc');
      expect(result.matchesExpectedHead).toBe(true);
    });

    it('detects mismatched expectedHeadSha when head SHA has moved', async () => {
      const manager = new RepositoryManager({
        repository: 'owner/repo',
        prInspector: async (_repo, _pr) => ({
          exists: true,
          headSha: 'commit-new-def',
          state: 'OPEN',
          merged: false,
        }),
      });

      const result = await manager.checkMergeStatus(15, 'commit-approved-abc');
      expect(result.exists).toBe(true);
      expect(result.headSha).toBe('commit-new-def');
      expect(result.matchesExpectedHead).toBe(false);
    });

    it('accepts options object with expectedHeadSha, repository, and worktreePath', async () => {
      let inspectedRepo = '';
      let inspectedWorktree = '';
      const manager = new RepositoryManager({
        repository: 'owner/default',
        cwd: '/work/default',
        prInspector: async (repo, _pr, worktreePath) => {
          inspectedRepo = repo;
          inspectedWorktree = worktreePath || '';
          return {
            exists: true,
            headSha: 'sha-xyz',
            state: 'MERGED',
            merged: true,
            mergeCommitSha: 'sha-merge-xyz',
          };
        },
      });

      const result = await manager.checkMergeStatus(20, {
        repository: 'owner/custom-repo',
        worktreePath: '/custom/worktree',
        expectedHeadSha: 'sha-xyz',
      });

      expect(inspectedRepo).toBe('owner/custom-repo');
      expect(inspectedWorktree).toBe('/custom/worktree');
      expect(result.merged).toBe(true);
      expect(result.matchesExpectedHead).toBe(true);
    });

    it('handles inspection error cleanly without throwing', async () => {
      const manager = new RepositoryManager({
        repository: 'owner/repo',
        prInspector: async (_repo, pr) => ({
          exists: false,
          error: `Pull request "${pr}" not found in repository "owner/repo".`,
        }),
      });

      const result = await manager.checkMergeStatus(404);
      expect(result.exists).toBe(false);
      expect(result.error).toContain('Pull request "404" not found');
    });
  });
});
