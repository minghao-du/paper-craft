/**
 * @fileoverview Tests for RepositoryManager unified repository, issue, and PR operations.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  RepositoryManager,
  WorkflowOwnershipError,
} from '../../packages/core/src/workflow/repository.js';
import { initTestGitRepo } from './test-git-helper.js';

const execFileAsync = promisify(execFile);

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

  describe('createWorktree', () => {
    let tmpDir: string;
    let repoManager: RepositoryManager;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-repo-worktree-test-'));
      await initTestGitRepo(tmpDir);
      repoManager = new RepositoryManager({
        cwd: tmpDir,
        repository: 'owner/test-repo',
      });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates codex/ branch from HEAD and dedicated worktree with version 1.0 owner marker', async () => {
      const runId = 'run-1001';
      const result = await repoManager.createWorktree(runId);

      expect(result.branch).toBe('codex/run-1001');
      expect(result.runId).toBe(runId);
      expect(result.repository).toBe('owner/test-repo');

      // Check directory exists on disk
      const stat = await fs.stat(result.worktreePath);
      expect(stat.isDirectory()).toBe(true);

      // Check .pc-execution-owner marker
      const owner = await repoManager.readWorktreeOwner(result.worktreePath);
      expect(owner).toEqual({
        version: '1.0',
        run_id: runId,
        repository: 'owner/test-repo',
      });

      // Verify Git branch was created
      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--list', 'codex/run-1001'], {
        cwd: tmpDir,
      });
      expect(branchOut).toContain('codex/run-1001');

      // Verify worktree is registered in Git
      const { stdout: wtOut } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: tmpDir,
      });
      expect(wtOut).toContain(result.worktreePath);
    });

    it('fails clearly when target directory already exists without overwriting or taking over', async () => {
      const runId = 'run-conflict-dir';
      const conflictPath = path.join(tmpDir, '.worktrees', runId);
      await fs.mkdir(conflictPath, { recursive: true });
      await fs.writeFile(path.join(conflictPath, 'user-preexisting.txt'), 'do not delete');

      await expect(repoManager.createWorktree(runId)).rejects.toThrow(WorkflowOwnershipError);
      await expect(repoManager.createWorktree(runId)).rejects.toThrow(/already exists/i);

      // Verify directory and files were preserved
      const content = await fs.readFile(path.join(conflictPath, 'user-preexisting.txt'), 'utf8');
      expect(content).toBe('do not delete');
    });

    it('fails clearly when branch already exists without overwriting or taking over', async () => {
      const runId = 'run-conflict-branch';
      // Pre-create branch
      await execFileAsync('git', ['branch', 'codex/run-conflict-branch', 'HEAD'], { cwd: tmpDir });

      await expect(repoManager.createWorktree(runId)).rejects.toThrow(WorkflowOwnershipError);
      await expect(repoManager.createWorktree(runId)).rejects.toThrow(/branch.*already exists/i);
    });
  });

  describe('releaseWorktree', () => {
    let tmpDir: string;
    let repoManager: RepositoryManager;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-repo-release-test-'));
      await initTestGitRepo(tmpDir);
      repoManager = new RepositoryManager({
        cwd: tmpDir,
        repository: 'owner/test-repo',
      });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('safely releases clean worktree using git worktree remove and preserves branch', async () => {
      const runId = 'run-clean-release';
      const wt = await repoManager.createWorktree(runId);

      // Tool files: add initialization.json (should not block release)
      await fs.writeFile(path.join(wt.worktreePath, 'initialization.json'), '{}', 'utf8');

      const releaseResult = await repoManager.releaseWorktree(wt.worktreePath, runId);
      expect(releaseResult.released).toBe(true);
      expect(releaseResult.worktreeRemoved).toBe(true);

      // Worktree directory removed from disk
      const exists = await fs.stat(wt.worktreePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);

      // Worktree unregistered in git
      const { stdout: wtList } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: tmpDir });
      expect(wtList).not.toContain(wt.worktreePath);

      // Branch is PRESERVED!
      const { stdout: branchList } = await execFileAsync('git', ['branch', '--list', 'codex/run-clean-release'], { cwd: tmpDir });
      expect(branchList).toContain('codex/run-clean-release');
    });

    it('rejects release when ownership mismatches and preserves foreign directory', async () => {
      const runId = 'run-owner-test';
      const wt = await repoManager.createWorktree(runId);

      // Attempt release with different run ID
      const releaseResult = await repoManager.releaseWorktree(wt.worktreePath, 'different-run-id');
      expect(releaseResult.released).toBe(false);
      expect(releaseResult.worktreeRemoved).toBe(false);
      expect(releaseResult.error).toContain('ownership mismatch');

      // Directory must NOT be removed
      const exists = await fs.stat(wt.worktreePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('rejects release when owner marker is missing or has legacy format without version 1.0', async () => {
      const runId = 'run-legacy-marker';
      const wt = await repoManager.createWorktree(runId);

      // Overwrite with legacy marker without version
      const markerPath = path.join(wt.worktreePath, '.pc-execution-owner');
      await fs.writeFile(
        markerPath,
        JSON.stringify({ run_id: runId, issue: 123, claimed_at: new Date().toISOString() }),
        'utf8',
      );

      const releaseResult = await repoManager.releaseWorktree(wt.worktreePath, runId);
      expect(releaseResult.released).toBe(false);
      expect(releaseResult.error).toMatch(/unsupported or legacy|rejected/i);

      // Directory must NOT be removed
      const exists = await fs.stat(wt.worktreePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('rejects release when worktree contains uncommitted user modifications (dirty check)', async () => {
      const runId = 'run-dirty-wt';
      const wt = await repoManager.createWorktree(runId);

      // User creates a new untracked source file
      await fs.writeFile(path.join(wt.worktreePath, 'user-work.ts'), 'export const x = 1;', 'utf8');

      const releaseResult = await repoManager.releaseWorktree(wt.worktreePath, runId);
      expect(releaseResult.released).toBe(false);
      expect(releaseResult.worktreeRemoved).toBe(false);
      expect(releaseResult.error).toMatch(/uncommitted changes or untracked user files.*dirty/i);

      // Directory and user modifications must be strictly preserved
      const exists = await fs.stat(path.join(wt.worktreePath, 'user-work.ts')).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });
});
