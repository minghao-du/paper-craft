import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '../../packages/workspace/src/cleanup.js';
import { resolvePath } from '../../packages/workspace/src/git.js';
import { WorkspaceError } from '../../packages/workspace/src/types.js';

interface TestContext {
  tempDir: string;
  repoDir: string;
  originBare: string;
  cleanupEnv: () => void;
}

function runGit(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git command failed (${args.join(' ')}):\n${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? '').trim();
}

function setupTestEnvironment(): TestContext {
  const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cleanup-test-'));
  const tempDir = resolvePath(rawTempDir);
  const originBare = path.join(tempDir, 'origin.git');
  const repoDir = path.join(tempDir, 'repo');

  // Initialize bare origin repository
  runGit(tempDir, 'init', '--bare', '--initial-branch=main', 'origin.git');

  // Initialize primary checkout
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, 'init', '--initial-branch=main');
  runGit(repoDir, 'config', 'user.name', 'Cleanup Tester');
  runGit(repoDir, 'config', 'user.email', 'cleanup@example.com');
  runGit(repoDir, 'config', 'commit.gpgsign', 'false');

  // Commit initial files
  fs.writeFileSync(path.join(repoDir, '.gitignore'), '.paper-craft/\n', 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf-8');
  runGit(repoDir, 'add', '.gitignore', 'README.md');
  runGit(repoDir, 'commit', '-m', 'Initial commit');

  // Set up origin remote and push main
  runGit(repoDir, 'remote', 'add', 'origin', originBare);
  runGit(repoDir, 'push', '-u', 'origin', 'main');

  const cleanupEnv = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  };

  return { tempDir, repoDir, originBare, cleanupEnv };
}

describe('Workspace Cleanup (cleanup)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestEnvironment();
  });

  afterEach(() => {
    ctx.cleanupEnv();
  });

  it('should successfully clean delivered task branch, worktree, and remote branch', () => {
    const startTime = Date.now();

    // 1. Create task branch and commit
    runGit(ctx.repoDir, 'checkout', '-b', 'issue-42');
    fs.writeFileSync(path.join(ctx.repoDir, 'issue-42.txt'), 'content 42\n', 'utf-8');
    runGit(ctx.repoDir, 'add', 'issue-42.txt');
    runGit(ctx.repoDir, 'commit', '-m', 'Task 42 commit');
    const taskCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', '-u', 'origin', 'issue-42');

    // 2. Create worktree for issue-42
    const worktreeDir = path.join(ctx.tempDir, 'worktrees', 'issue-42');
    runGit(ctx.repoDir, 'checkout', 'main');
    runGit(ctx.repoDir, 'worktree', 'add', worktreeDir, 'issue-42');

    expect(fs.existsSync(worktreeDir)).toBe(true);

    // 3. Simulate PR merge into main on origin
    runGit(ctx.repoDir, 'merge', '--no-ff', 'issue-42', '-m', 'Merge PR #42');
    const mergeCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', 'origin', 'main');

    // 4. Mock GitHub CLI runner
    const ghRunner = (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          state: 'MERGED',
          headRefName: 'issue-42',
          headRefOid: taskCommit,
          baseRefName: 'main',
          mergeCommit: { oid: mergeCommit },
          headRepository: { name: 'test-repo' },
          headRepositoryOwner: { login: 'owner' },
        });
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return JSON.stringify({
          nameWithOwner: 'owner/test-repo',
          defaultBranchRef: { name: 'main' },
        });
      }
      throw new Error(`Unexpected gh invocation: ${args.join(' ')}`);
    };

    const receiptPath = path.join(ctx.tempDir, 'receipt.json');
    fs.writeFileSync(receiptPath, '{}', 'utf-8');

    // 5. Execute cleanup
    const result = cleanup(
      {
        sourceCheckout: ctx.repoDir,
        rootIssueId: '42',
        candidates: [
          {
            kind: 'task_branch',
            worktree: worktreeDir,
            branch: 'issue-42',
            commit: taskCommit,
            baseBranch: 'main',
            deliveryTarget: 'owner/test-repo',
            baseRemote: 'origin',
            pushRemote: 'origin',
            pr: 42,
            created: true,
            consumersFinished: true,
          },
        ],
        protectedPaths: [receiptPath],
      },
      { ghRunner },
    );

    expect(result.outcome).toBe('cleaned');
    expect(result.candidates).toHaveLength(1);

    const candRes = result.candidates[0];
    expect(candRes.worktree?.status).toBe('removed');
    expect(candRes.remoteBranch?.status).toBe('removed');
    expect(candRes.localBranch?.status).toBe('removed');

    // Verify disk and git states
    expect(fs.existsSync(worktreeDir)).toBe(false);

    const worktreeList = runGit(ctx.repoDir, 'worktree', 'list', '--porcelain');
    expect(worktreeList).not.toContain(worktreeDir);

    const localBranchCheck = spawnSync('git', ['show-ref', '--verify', 'refs/heads/issue-42'], {
      cwd: ctx.repoDir,
    });
    expect(localBranchCheck.status).not.toBe(0);

    const remoteBranchCheck = runGit(ctx.repoDir, 'ls-remote', '--refs', 'origin', 'refs/heads/issue-42');
    expect(remoteBranchCheck).toBe('');

    expect(Date.now() - startTime).toBeLessThan(10000);
  });

  it('should be idempotent and report already_absent when re-running on deleted resources', () => {
    // 1. Create and merge task branch
    runGit(ctx.repoDir, 'checkout', '-b', 'issue-43');
    fs.writeFileSync(path.join(ctx.repoDir, 'issue-43.txt'), 'content 43\n', 'utf-8');
    runGit(ctx.repoDir, 'add', 'issue-43.txt');
    runGit(ctx.repoDir, 'commit', '-m', 'Task 43 commit');
    const taskCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', '-u', 'origin', 'issue-43');

    const worktreeDir = path.join(ctx.tempDir, 'worktrees', 'issue-43');
    runGit(ctx.repoDir, 'checkout', 'main');
    runGit(ctx.repoDir, 'worktree', 'add', worktreeDir, 'issue-43');

    runGit(ctx.repoDir, 'merge', '--no-ff', 'issue-43', '-m', 'Merge PR #43');
    const mergeCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', 'origin', 'main');

    const ghRunner = (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          state: 'MERGED',
          headRefName: 'issue-43',
          headRefOid: taskCommit,
          baseRefName: 'main',
          mergeCommit: { oid: mergeCommit },
          headRepository: { name: 'test-repo' },
          headRepositoryOwner: { login: 'owner' },
        });
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return JSON.stringify({
          nameWithOwner: 'owner/test-repo',
          defaultBranchRef: { name: 'main' },
        });
      }
      throw new Error(`Unexpected gh invocation: ${args.join(' ')}`);
    };

    const request = {
      sourceCheckout: ctx.repoDir,
      rootIssueId: '43',
      candidates: [
        {
          kind: 'task_branch' as const,
          worktree: worktreeDir,
          branch: 'issue-43',
          commit: taskCommit,
          baseBranch: 'main',
          deliveryTarget: 'owner/test-repo',
          baseRemote: 'origin',
          pushRemote: 'origin',
          pr: 43,
          created: true,
          consumersFinished: true,
        },
      ],
      protectedPaths: [],
    };

    // First cleanup run
    const result1 = cleanup(request, { ghRunner });
    expect(result1.outcome).toBe('cleaned');
    expect(result1.candidates[0].worktree?.status).toBe('removed');
    expect(result1.candidates[0].remoteBranch?.status).toBe('removed');
    expect(result1.candidates[0].localBranch?.status).toBe('removed');

    // Second cleanup run (idempotent)
    const result2 = cleanup(request, { ghRunner });
    expect(result2.outcome).toBe('cleaned');
    expect(result2.candidates[0].worktree?.status).toBe('already_absent');
    expect(result2.candidates[0].remoteBranch?.status).toBe('already_absent');
    expect(result2.candidates[0].localBranch?.status).toBe('already_absent');
  });

  it('should retain dirty worktree with untracked or ignored files and report incomplete', () => {
    runGit(ctx.repoDir, 'checkout', '-b', 'issue-44');
    fs.writeFileSync(path.join(ctx.repoDir, 'issue-44.txt'), 'content 44\n', 'utf-8');
    runGit(ctx.repoDir, 'add', 'issue-44.txt');
    runGit(ctx.repoDir, 'commit', '-m', 'Task 44 commit');
    const taskCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', '-u', 'origin', 'issue-44');

    const worktreeDir = path.join(ctx.tempDir, 'worktrees', 'issue-44');
    runGit(ctx.repoDir, 'checkout', 'main');
    runGit(ctx.repoDir, 'worktree', 'add', worktreeDir, 'issue-44');

    runGit(ctx.repoDir, 'merge', '--no-ff', 'issue-44', '-m', 'Merge PR #44');
    const mergeCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', 'origin', 'main');

    // Introduce an uncommitted untracked file into worktree
    fs.writeFileSync(path.join(worktreeDir, 'untracked.txt'), 'uncommitted changes', 'utf-8');

    const ghRunner = (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          state: 'MERGED',
          headRefName: 'issue-44',
          headRefOid: taskCommit,
          baseRefName: 'main',
          mergeCommit: { oid: mergeCommit },
          headRepository: { name: 'test-repo' },
          headRepositoryOwner: { login: 'owner' },
        });
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return JSON.stringify({
          nameWithOwner: 'owner/test-repo',
          defaultBranchRef: { name: 'main' },
        });
      }
      throw new Error(`Unexpected gh: ${args.join(' ')}`);
    };

    const result = cleanup(
      {
        sourceCheckout: ctx.repoDir,
        rootIssueId: '44',
        candidates: [
          {
            kind: 'task_branch',
            worktree: worktreeDir,
            branch: 'issue-44',
            commit: taskCommit,
            baseBranch: 'main',
            deliveryTarget: 'owner/test-repo',
            baseRemote: 'origin',
            pushRemote: 'origin',
            pr: 44,
            created: true,
            consumersFinished: true,
          },
        ],
        protectedPaths: [],
      },
      { ghRunner },
    );

    expect(result.outcome).toBe('incomplete');
    expect(result.candidates[0].worktree?.status).toBe('retained');
    expect(result.candidates[0].worktree?.reasonCode).toBe('DIRTY_WORKTREE');
    expect(result.candidates[0].remoteBranch?.status).toBe('retained');
    expect(result.candidates[0].localBranch?.status).toBe('retained');

    // Ensure worktree is preserved on disk
    expect(fs.existsSync(worktreeDir)).toBe(true);
  });

  it('should retain locked worktree and report incomplete', () => {
    runGit(ctx.repoDir, 'checkout', '-b', 'issue-45');
    fs.writeFileSync(path.join(ctx.repoDir, 'issue-45.txt'), 'content 45\n', 'utf-8');
    runGit(ctx.repoDir, 'add', 'issue-45.txt');
    runGit(ctx.repoDir, 'commit', '-m', 'Task 45 commit');
    const taskCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', '-u', 'origin', 'issue-45');

    const worktreeDir = path.join(ctx.tempDir, 'worktrees', 'issue-45');
    runGit(ctx.repoDir, 'checkout', 'main');
    runGit(ctx.repoDir, 'worktree', 'add', worktreeDir, 'issue-45');

    // Lock the worktree
    runGit(ctx.repoDir, 'worktree', 'lock', worktreeDir, '--reason', 'Active testing');

    const result = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '45',
      candidates: [
        {
          kind: 'task_branch',
          worktree: worktreeDir,
          branch: 'issue-45',
          commit: taskCommit,
          baseBranch: 'main',
          deliveryTarget: 'owner/test-repo',
          pr: 45,
          created: true,
          consumersFinished: true,
        },
      ],
      protectedPaths: [],
    });

    expect(result.outcome).toBe('incomplete');
    expect(result.candidates[0].worktree?.status).toBe('retained');
    expect(result.candidates[0].worktree?.reasonCode).toBe('LOCKED_WORKTREE');
  });

  it('should retain resources when ownership or consumer finished verification fails', () => {
    const worktreeDir = path.join(ctx.tempDir, 'worktrees', 'issue-46');
    const fakeCommit = '0123456789abcdef0123456789abcdef01234567';

    // 1. created=false and no valid historical ownership
    const res1 = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '46',
      candidates: [
        {
          kind: 'task_branch',
          worktree: worktreeDir,
          branch: 'issue-46',
          commit: fakeCommit,
          created: false,
          consumersFinished: true,
        },
      ],
      protectedPaths: [],
    });

    expect(res1.outcome).toBe('incomplete');
    expect(res1.candidates[0].worktree?.status).toBe('retained');
    expect(res1.candidates[0].worktree?.reasonCode).toBe('OWNERSHIP_UNVERIFIED');

    // 2. consumersFinished=false
    const res2 = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '46',
      candidates: [
        {
          kind: 'task_branch',
          worktree: worktreeDir,
          branch: 'issue-46',
          commit: fakeCommit,
          created: true,
          consumersFinished: false,
        },
      ],
      protectedPaths: [],
    });

    expect(res2.outcome).toBe('incomplete');
    expect(res2.candidates[0].worktree?.status).toBe('retained');
    expect(res2.candidates[0].worktree?.reasonCode).toBe('CONSUMERS_NOT_FINISHED');

    // 3. valid historical ownership evidence
    const res3 = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '46',
      candidates: [
        {
          kind: 'task_branch',
          worktree: worktreeDir,
          branch: 'issue-46',
          commit: fakeCommit,
          created: false,
          ownershipEvidence: {
            issue: 46,
            source: 'test',
            root_issue_id: '46',
          },
          consumersFinished: true,
        },
      ],
      protectedPaths: [],
    });

    // Ownership check passes, so it proceeds to next checks (e.g. unregistered directory or path check)
    expect(res3.candidates[0].worktree?.reasonCode).not.toBe('OWNERSHIP_UNVERIFIED');
  });

  it('should protect sourceCheckout, primaryCheckout, and protectedPaths', () => {
    const fakeCommit = '0123456789abcdef0123456789abcdef01234567';
    const receiptDir = path.join(ctx.tempDir, 'receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
    const receiptFile = path.join(receiptDir, 'cleanup-receipt.json');
    fs.writeFileSync(receiptFile, '{}', 'utf-8');

    // 1. Try to delete source checkout
    const resSource = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '47',
      candidates: [
        {
          kind: 'task_branch',
          worktree: ctx.repoDir,
          branch: 'issue-47',
          commit: fakeCommit,
          created: true,
          consumersFinished: true,
        },
      ],
      protectedPaths: [receiptFile],
    });

    expect(resSource.outcome).toBe('incomplete');
    expect(resSource.candidates[0].worktree?.status).toBe('retained');
    expect(resSource.candidates[0].worktree?.reasonCode).toBe('PROTECTED_RESOURCE');

    // 2. Try to delete directory overlapping protected path
    const resProtected = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '47',
      candidates: [
        {
          kind: 'task_branch',
          worktree: receiptDir,
          branch: 'issue-47',
          commit: fakeCommit,
          created: true,
          consumersFinished: true,
        },
      ],
      protectedPaths: [receiptFile],
    });

    expect(resProtected.outcome).toBe('incomplete');
    expect(resProtected.candidates[0].worktree?.status).toBe('retained');
    expect(resProtected.candidates[0].worktree?.reasonCode).toBe('PROTECTED_RESOURCE');
  });

  it('should clean detached worktrees when verificationCompleted is confirmed', () => {
    const initialCommit = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    const detachedDir = path.join(ctx.tempDir, 'worktrees', 'detached-1');

    runGit(ctx.repoDir, 'worktree', 'add', '--detach', detachedDir, initialCommit);
    expect(fs.existsSync(detachedDir)).toBe(true);

    // 1. Without verificationCompleted -> retained
    const res1 = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '48',
      candidates: [
        {
          kind: 'detached',
          worktree: detachedDir,
          commit: initialCommit,
          ownershipEvidence: {
            issue: 48,
            source: 'test',
            root_issue_id: '48',
          },
          consumersFinished: true,
          verificationCompleted: false,
        },
      ],
      protectedPaths: [],
    });

    expect(res1.outcome).toBe('incomplete');
    expect(res1.candidates[0].worktree?.status).toBe('retained');
    expect(res1.candidates[0].worktree?.reasonCode).toBe('VERIFICATION_NOT_COMPLETED');
    expect(fs.existsSync(detachedDir)).toBe(true);

    // 2. With verificationCompleted -> removed
    const res2 = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '48',
      candidates: [
        {
          kind: 'detached',
          worktree: detachedDir,
          commit: initialCommit,
          ownershipEvidence: {
            issue: 48,
            source: 'test',
            root_issue_id: '48',
          },
          consumersFinished: true,
          verificationCompleted: true,
        },
      ],
      protectedPaths: [],
    });

    expect(res2.outcome).toBe('cleaned');
    expect(res2.candidates[0].worktree?.status).toBe('removed');
    expect(res2.candidates[0].localBranch).toBeUndefined();
    expect(res2.candidates[0].remoteBranch).toBeUndefined();
    expect(fs.existsSync(detachedDir)).toBe(false);
  });

  it('should preserve partial progress when Candidate A succeeds and Candidate B is retained', () => {
    // Set up Candidate A
    runGit(ctx.repoDir, 'checkout', '-b', 'issue-50');
    fs.writeFileSync(path.join(ctx.repoDir, 'issue-50.txt'), 'content 50\n', 'utf-8');
    runGit(ctx.repoDir, 'add', 'issue-50.txt');
    runGit(ctx.repoDir, 'commit', '-m', 'Task 50 commit');
    const commitA = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', '-u', 'origin', 'issue-50');

    const worktreeA = path.join(ctx.tempDir, 'worktrees', 'issue-50');
    runGit(ctx.repoDir, 'checkout', 'main');
    runGit(ctx.repoDir, 'worktree', 'add', worktreeA, 'issue-50');

    runGit(ctx.repoDir, 'merge', '--no-ff', 'issue-50', '-m', 'Merge PR #50');
    const mergeCommitA = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', 'origin', 'main');

    // Set up Candidate B with dirty worktree
    runGit(ctx.repoDir, 'checkout', '-b', 'issue-51');
    fs.writeFileSync(path.join(ctx.repoDir, 'issue-51.txt'), 'content 51\n', 'utf-8');
    runGit(ctx.repoDir, 'add', 'issue-51.txt');
    runGit(ctx.repoDir, 'commit', '-m', 'Task 51 commit');
    const commitB = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    runGit(ctx.repoDir, 'push', '-u', 'origin', 'issue-51');

    const worktreeB = path.join(ctx.tempDir, 'worktrees', 'issue-51');
    runGit(ctx.repoDir, 'checkout', 'main');
    runGit(ctx.repoDir, 'worktree', 'add', worktreeB, 'issue-51');

    // Make worktree B dirty
    fs.writeFileSync(path.join(worktreeB, 'uncommitted.txt'), 'dirty\n', 'utf-8');

    const ghRunner = (args: string[]) => {
      const prId = args[2];
      if (prId === '50') {
        return JSON.stringify({
          state: 'MERGED',
          headRefName: 'issue-50',
          headRefOid: commitA,
          baseRefName: 'main',
          mergeCommit: { oid: mergeCommitA },
          headRepository: { name: 'test-repo' },
          headRepositoryOwner: { login: 'owner' },
        });
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return JSON.stringify({
          nameWithOwner: 'owner/test-repo',
          defaultBranchRef: { name: 'main' },
        });
      }
      throw new Error(`Unexpected call for PR ${prId}`);
    };

    const result = cleanup(
      {
        sourceCheckout: ctx.repoDir,
        rootIssueId: '50',
        candidates: [
          {
            kind: 'task_branch',
            worktree: worktreeA,
            branch: 'issue-50',
            commit: commitA,
            baseBranch: 'main',
            deliveryTarget: 'owner/test-repo',
            baseRemote: 'origin',
            pushRemote: 'origin',
            pr: 50,
            created: true,
            consumersFinished: true,
          },
          {
            kind: 'task_branch',
            worktree: worktreeB,
            branch: 'issue-51',
            commit: commitB,
            baseBranch: 'main',
            deliveryTarget: 'owner/test-repo',
            baseRemote: 'origin',
            pushRemote: 'origin',
            pr: 51,
            created: true,
            consumersFinished: true,
          },
        ],
        protectedPaths: [],
      },
      { ghRunner },
    );

    expect(result.outcome).toBe('incomplete');
    expect(result.candidates).toHaveLength(2);

    // Candidate A successfully removed!
    const candA = result.candidates[0];
    expect(candA.worktree?.status).toBe('removed');
    expect(candA.remoteBranch?.status).toBe('removed');
    expect(candA.localBranch?.status).toBe('removed');
    expect(fs.existsSync(worktreeA)).toBe(false);

    // Candidate B retained!
    const candB = result.candidates[1];
    expect(candB.worktree?.status).toBe('retained');
    expect(candB.worktree?.reasonCode).toBe('DIRTY_WORKTREE');
    expect(fs.existsSync(worktreeB)).toBe(true);
  });

  it('should validate request inputs and throw WorkspaceError on invalid root options', () => {
    // 1. Missing sourceCheckout
    expect(() =>
      cleanup({
        sourceCheckout: '',
        rootIssueId: '99',
        candidates: [],
        protectedPaths: [],
      }),
    ).toThrow(WorkspaceError);

    // 2. Non-existent sourceCheckout
    expect(() =>
      cleanup({
        sourceCheckout: path.join(ctx.tempDir, 'non-existent'),
        rootIssueId: '99',
        candidates: [],
        protectedPaths: [],
      }),
    ).toThrow(WorkspaceError);

    // 3. Missing rootIssueId
    expect(() =>
      cleanup({
        sourceCheckout: ctx.repoDir,
        rootIssueId: '',
        candidates: [],
        protectedPaths: [],
      }),
    ).toThrow(WorkspaceError);

    // 4. Non-array candidates
    expect(() =>
      cleanup({
        sourceCheckout: ctx.repoDir,
        rootIssueId: '99',
        candidates: null as unknown as [],
        protectedPaths: [],
      }),
    ).toThrow(WorkspaceError);
  });

  it('should mark outcome incomplete when unresolved inventory is present', () => {
    const result = cleanup({
      sourceCheckout: ctx.repoDir,
      rootIssueId: '99',
      candidates: [],
      unresolved: ['stale-worktree-outside-scope'],
      protectedPaths: [],
    });

    expect(result.outcome).toBe('incomplete');
    expect(result.unresolved).toEqual(['stale-worktree-outside-scope']);
  });
});
