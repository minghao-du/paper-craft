import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepare } from '../../packages/workspace/src/prepare.js';
import { WorkspaceError } from '../../packages/workspace/src/types.js';
import { resolvePath } from '../../packages/workspace/src/git.js';

interface TestContext {
  tempDir: string;
  repoDir: string;
  originBare: string;
  cleanup: () => void;
}

function runGit(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git command failed (${args.join(' ')}):\n${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? '').trim();
}

function setupTestEnvironment(): TestContext {
  const rawTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-prepare-test-'));
  const tempDir = resolvePath(rawTempDir);
  const originBare = path.join(tempDir, 'origin.git');
  const repoDir = path.join(tempDir, 'repo');

  // Initialize bare origin repository
  runGit(tempDir, 'init', '--bare', '--initial-branch=main', 'origin.git');

  // Initialize primary checkout
  fs.mkdirSync(repoDir, { recursive: true });
  runGit(repoDir, 'init', '--initial-branch=main');
  runGit(repoDir, 'config', 'user.name', 'Prepare Tester');
  runGit(repoDir, 'config', 'user.email', 'tester@example.com');
  runGit(repoDir, 'config', 'commit.gpgsign', 'false');

  // Commit initial files
  fs.writeFileSync(path.join(repoDir, '.gitignore'), '.paper-craft/\n', 'utf-8');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf-8');
  runGit(repoDir, 'add', '.gitignore', 'README.md');
  runGit(repoDir, 'commit', '-m', 'Initial commit');

  // Set up origin remote and push
  runGit(repoDir, 'remote', 'add', 'origin', originBare);
  runGit(repoDir, 'push', '-u', 'origin', 'main');

  // Set up workspace config
  const configDir = path.join(repoDir, '.paper-craft');
  fs.mkdirSync(configDir, { recursive: true });
  const configContent = {
    schema_version: '1.0',
    delivery_target: 'owner/test-repo',
    base_remote: 'origin',
    push_remote: 'origin',
    base_branch: 'main',
    worktree_container: '../worktrees',
    default_workflow: 'default',
    delivery_attempts_max: 3,
    replans_max: 2,
  };
  fs.writeFileSync(
    path.join(configDir, 'workspace-config.json'),
    JSON.stringify(configContent, null, 2),
    'utf-8',
  );

  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignored
    }
  };

  return { tempDir, repoDir, originBare, cleanup };
}

describe('Workspace Preparation (prepare)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestEnvironment();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('should successfully create an issue workspace', () => {
    const startTime = Date.now();
    const result = prepare({
      sourceCheckout: ctx.repoDir,
      target: { kind: 'issue', issue: 42 },
    });

    const elapsedSeconds = (Date.now() - startTime) / 1000;
    expect(elapsedSeconds).toBeLessThan(120);

    expect(result.disposition).toBe('created');
    expect(result.branch).toBe('issue-42');
    expect(result.baseBranch).toBe('main');
    expect(result.baseRemote).toBe('origin');
    expect(result.pushRemote).toBe('origin');
    expect(result.deliveryTarget).toBe('owner/test-repo');
    expect(result.sourceCheckout).toBe(ctx.repoDir);

    const expectedWorktreePath = resolvePath(path.join(ctx.tempDir, 'worktrees', 'issue-42'));
    expect(result.path).toBe(expectedWorktreePath);
    expect(fs.existsSync(result.path)).toBe(true);

    // Verify git branch inside worktree
    const currentBranch = runGit(result.path, 'branch', '--show-current');
    expect(currentBranch).toBe('issue-42');
  });

  it('should return reused disposition on subsequent calls without destroying existing content', () => {
    const res1 = prepare({
      sourceCheckout: ctx.repoDir,
      target: { kind: 'issue', issue: 101 },
    });
    expect(res1.disposition).toBe('created');

    // Add a custom file to the worktree
    const customFilePath = path.join(res1.path, 'task-notes.txt');
    fs.writeFileSync(customFilePath, 'task progress notes', 'utf-8');
    runGit(res1.path, 'add', 'task-notes.txt');
    runGit(res1.path, 'commit', '-m', 'Add task notes');
    const newHead = runGit(res1.path, 'rev-parse', 'HEAD');

    // Call prepare again
    const res2 = prepare({
      sourceCheckout: ctx.repoDir,
      target: { kind: 'issue', issue: 101 },
    });

    expect(res2.disposition).toBe('reused');
    expect(res2.path).toBe(res1.path);
    expect(res2.commit).toBe(newHead);
    expect(fs.existsSync(customFilePath)).toBe(true);
    expect(fs.readFileSync(customFilePath, 'utf-8')).toBe('task progress notes');
  });

  it('should reuse workspace when expectedHead matches, and throw HEAD_MISMATCH when it does not', () => {
    const res1 = prepare({
      sourceCheckout: ctx.repoDir,
      target: { kind: 'issue', issue: 202 },
    });
    const headCommit = res1.commit;

    // Successful reuse with matching expectedHead
    const reused = prepare({
      sourceCheckout: ctx.repoDir,
      target: { kind: 'issue', issue: 202, expectedHead: headCommit },
    });
    expect(reused.disposition).toBe('reused');
    expect(reused.commit).toBe(headCommit);

    // Fails with HEAD_MISMATCH when expectedHead differs
    const mismatchedSha = '1111111111111111111111111111111111111111';
    expect(() => {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 202, expectedHead: mismatchedSha },
      });
    }).toThrowError(WorkspaceError);

    try {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 202, expectedHead: mismatchedSha },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe('HEAD_MISMATCH');
    }
  });

  it('should throw WORKTREE_CONFLICT when expectedHead is specified but workspace does not exist', () => {
    expect(() => {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: {
          kind: 'issue',
          issue: 303,
          expectedHead: '1234567890abcdef1234567890abcdef12345678',
        },
      });
    }).toThrowError(WorkspaceError);

    try {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: {
          kind: 'issue',
          issue: 303,
          expectedHead: '1234567890abcdef1234567890abcdef12345678',
        },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe('WORKTREE_CONFLICT');
      expect((err as WorkspaceError).message).toContain(
        'Cannot create new worktree when expectedHead is specified',
      );
    }
  });

  it('should support detached worktree creation and reuse', () => {
    const mainHead = runGit(ctx.repoDir, 'rev-parse', 'HEAD');
    const detachedPath = path.join(ctx.tempDir, 'detached-verification');

    // Create detached worktree
    const created = prepare({
      sourceCheckout: ctx.repoDir,
      target: { kind: 'detached', commit: mainHead, path: detachedPath },
    });

    expect(created.disposition).toBe('created');
    expect(created.branch).toBeNull();
    expect(created.commit).toBe(mainHead);
    expect(created.path).toBe(resolvePath(detachedPath));

    // Verify it is detached
    const currentBranch = runGit(detachedPath, 'branch', '--show-current');
    expect(currentBranch).toBe('');

    // Reuse detached worktree
    const reused = prepare({
      sourceCheckout: ctx.repoDir,
      target: { kind: 'detached', commit: mainHead, path: detachedPath },
    });
    expect(reused.disposition).toBe('reused');
    expect(reused.branch).toBeNull();
    expect(reused.commit).toBe(mainHead);
  });

  it('should throw UNCLEAN_CHECKOUT when sourceCheckout contains uncommitted changes', () => {
    // Add untracked dirty file to source checkout
    fs.writeFileSync(path.join(ctx.repoDir, 'uncommitted.txt'), 'dirty work', 'utf-8');

    expect(() => {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 404 },
      });
    }).toThrowError(WorkspaceError);

    try {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 404 },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe('UNCLEAN_CHECKOUT');
    }
  });

  it('should throw WORKTREE_CONFLICT when target path is occupied by an unregistered directory', () => {
    const targetDir = path.join(ctx.tempDir, 'worktrees', 'issue-505');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'existing-file.txt'), 'blocking content', 'utf-8');

    expect(() => {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 505 },
      });
    }).toThrowError(WorkspaceError);

    try {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 505 },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe('WORKTREE_CONFLICT');
      expect((err as WorkspaceError).message).toContain(
        'Target directory already exists and is not a registered worktree',
      );
    }
  });

  it('should reject protected base branch when passed as issue branch', () => {
    expect(() => {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 606, branch: 'main' },
      });
    }).toThrowError(WorkspaceError);

    try {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'issue', issue: 606, branch: 'main' },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe('INVALID_INPUT');
      expect((err as WorkspaceError).message).toContain('protected base branch');
    }
  });

  it('should reject target path inside or occupying primary checkout', () => {
    const insidePrimary = path.join(ctx.repoDir, 'nested-forbidden');
    expect(() => {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'branch', branch: 'feat-nested', path: insidePrimary },
      });
    }).toThrowError(WorkspaceError);

    try {
      prepare({
        sourceCheckout: ctx.repoDir,
        target: { kind: 'branch', branch: 'feat-nested', path: insidePrimary },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceError);
      expect((err as WorkspaceError).code).toBe('WORKTREE_CONFLICT');
    }
  });
});
