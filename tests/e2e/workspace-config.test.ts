/**
 * E2E tests for Issue #38: Project Workspace Configuration & Worktree Preparation.
 *
 * Verifies:
 * 1. Normal project default config — temporary repo with only origin, init config with defaults,
 *    prepare-worktree creates worktree in default container using config without repetitive environment parameters.
 * 2. Missing/invalid config error handling — clear explanation, guidance to init, no worktree created.
 * 3. Custom container specification and receipt persistence outside disposable worktrees.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDir,
  PREPARE_WORKTREE_SCRIPT,
  runLifecycleKernelCli,
  runPrepareTaskCli,
  runPrepareWorktreeCli,
  runWorkspaceConfigCli,
  type CompactReceiptReport,
  type TaskInputEnvelope,
} from './test-helpers.js';

describe('Issue #38: Workspace Config E2E', () => {
  let testEnv: { dir: string; cleanup: () => void };

  beforeEach(() => {
    testEnv = createTestDir('issue-38-workspace-config-');
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  function git(cwd: string, ...args: string[]): string {
    const res = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    if (res.status !== 0) {
      throw new Error(`git command failed (${args.join(' ')}):\n${res.stderr}`);
    }
    return (res.stdout ?? '').trim();
  }

  function setupGitRepo(repoName = 'my-project'): { repoDir: string; originBare: string } {
    const root = testEnv.dir;
    const originBare = path.join(root, 'demo-repo.git');
    const repoDir = path.join(root, repoName);

    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize origin bare repo
    git(root, 'init', '--bare', '--initial-branch=main', 'demo-repo.git');

    // Initialize local repo
    git(repoDir, 'init', '--initial-branch=main');
    git(repoDir, 'config', 'user.name', 'E2E Tester');
    git(repoDir, 'config', 'user.email', 'tester@example.com');
    git(repoDir, 'config', 'commit.gpgsign', 'false');

    // Add .gitignore ignoring .paper-craft/
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.paper-craft/\n', 'utf-8');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf-8');
    git(repoDir, 'add', '.gitignore', 'README.md');
    git(repoDir, 'commit', '-m', 'Initial commit');

    // Add origin remote pointing to local bare repository and push main
    git(repoDir, 'remote', 'add', 'origin', originBare);
    git(repoDir, 'push', 'origin', 'main');

    return { repoDir, originBare };
  }

  function setupForkGitRepo(repoName = 'fork-project'): {
    repoDir: string;
    originBare: string;
    upstreamBare: string;
    upstreamHeadSha: string;
  } {
    const root = testEnv.dir;
    const originBare = path.join(root, 'origin-fork.git');
    const upstreamBare = path.join(root, 'upstream-mainline.git');
    const repoDir = path.join(root, repoName);
    const tempUpstreamDir = path.join(root, 'temp-upstream');

    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize upstream bare repo and seed with unique commit
    git(root, 'init', '--bare', '--initial-branch=main', 'upstream-mainline.git');
    git(root, 'clone', upstreamBare, 'temp-upstream');
    git(tempUpstreamDir, 'config', 'user.name', 'Upstream Dev');
    git(tempUpstreamDir, 'config', 'user.email', 'upstream@example.com');
    git(tempUpstreamDir, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(tempUpstreamDir, 'UPSTREAM_FEATURE.md'), '# Mainline Feature\n', 'utf-8');
    git(tempUpstreamDir, 'add', 'UPSTREAM_FEATURE.md');
    git(tempUpstreamDir, 'commit', '-m', 'Add upstream mainline feature');
    git(tempUpstreamDir, 'push', 'origin', 'main');
    const upstreamHeadSha = git(tempUpstreamDir, 'rev-parse', 'HEAD');

    // Initialize origin bare repo (fork)
    git(root, 'init', '--bare', '--initial-branch=main', 'origin-fork.git');

    // Initialize local repo (the fork checkout)
    git(repoDir, 'init', '--initial-branch=main');
    git(repoDir, 'config', 'user.name', 'Fork Tester');
    git(repoDir, 'config', 'user.email', 'fork@example.com');
    git(repoDir, 'config', 'commit.gpgsign', 'false');

    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.paper-craft/\n', 'utf-8');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fork Project\n', 'utf-8');
    git(repoDir, 'add', '.gitignore', 'README.md');
    git(repoDir, 'commit', '-m', 'Initial fork commit');

    // Add origin remote pointing to fork bare repository and push
    git(repoDir, 'remote', 'add', 'origin', originBare);
    git(repoDir, 'push', 'origin', 'main');

    // Add upstream remote pointing to upstream bare repository
    git(repoDir, 'remote', 'add', 'upstream', upstreamBare);

    return { repoDir, originBare, upstreamBare, upstreamHeadSha };
  }

  it('Test 1: Normal project default config and automated workspace preparation', () => {
    const { repoDir } = setupGitRepo('normal-project');

    // 1. Initialize workspace configuration with defaults
    const initRes = runWorkspaceConfigCli([
      'init',
      '--repo-dir', repoDir,
      '--delivery-target', 'paper-craft/demo-repo',
      '--defaults',
    ]);
    expect(initRes.status).toBe(0);

    const configPath = path.join(repoDir, '.paper-craft', 'workspace-config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.schema_version).toBe('1.0');
    expect(config.delivery_target).toBe('paper-craft/demo-repo');
    expect(config.base_remote).toBe('origin');
    expect(config.push_remote).toBe('origin');
    expect(config.base_branch).toBe('main');
    expect(config.worktree_container).toBe('../project-worktrees');

    // 2. Create Task Input Envelope for workspace preparation via lifecycle kernel
    const receiptRoot = path.join(testEnv.dir, 'receipts', 'issue-38');
    runLifecycleKernelCli([
      'init',
      '--receipt-root', receiptRoot,
      '--root-issue', '38',
      '--repo-dir', repoDir,
    ]);
    const prepResEnvelope = runPrepareTaskCli(receiptRoot, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace for Issue #38',
      provider: {
        type: 'script',
        target: PREPARE_WORKTREE_SCRIPT,
      },
      workdir: repoDir,
    });
    expect(prepResEnvelope.status).toBe(0);
    const envelopePath = path.join(receiptRoot, '01-input.json');

    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(envelope.environment.repository).toBe('paper-craft/demo-repo');
    expect(envelope.environment.base_branch).toBe('main');

    // 3. Prepare workspace using prepare-worktree.py with the envelope
    const prepRes = runPrepareWorktreeCli(['--input-envelope', envelopePath]);
    expect(prepRes.status).toBe(0);

    const report: CompactReceiptReport = JSON.parse(prepRes.stdout);
    const receiptPath = report.receipt_path;
    expect(report.execution_status).toBe('succeeded');
    expect(report.result.repository).toBe('paper-craft/demo-repo');
    expect(report.result.baseBranch).toBe('main');

    // Expected worktree location is in default container: repoDir/../project-worktrees/issue-38
    const expectedContainer = path.resolve(repoDir, '../project-worktrees');
    const expectedWorktree = path.join(expectedContainer, 'issue-38');
    expect(report.result.worktree).toBe(expectedWorktree);
    expect(fs.existsSync(expectedWorktree)).toBe(true);

    // Durable receipt exists and is non-empty outside the disposable worktree
    expect(fs.existsSync(receiptPath)).toBe(true);
    const receiptContent = fs.readFileSync(receiptPath, 'utf-8');
    expect(receiptContent).toContain('# Subagent Receipt');
    expect(receiptContent).toContain('paper-craft/demo-repo');
  });

  it('Test 2: Missing or invalid config error handling and blocker protection', () => {
    const { repoDir } = setupGitRepo('unconfigured-project');
    const receiptRoot = path.join(testEnv.dir, 'receipts', 'issue-99');
    fs.mkdirSync(receiptRoot, { recursive: true });

    // 1. Missing config check via config.py validate
    const checkMissing = runWorkspaceConfigCli(['validate', '--repo-dir', repoDir]);
    expect(checkMissing.status).not.toBe(0);
    expect(checkMissing.stderr).toContain('pc-workspace-config');
    expect(checkMissing.stderr.toLowerCase()).toContain('missing');

    // Lifecycle kernel initialization with --require-config must fail when config is missing
    const initFail = runLifecycleKernelCli([
      'init',
      '--receipt-root', receiptRoot,
      '--root-issue', '99',
      '--require-config',
      '--repo-dir', repoDir,
    ]);
    expect(initFail.status).not.toBe(0);
    expect(initFail.stderr).toContain('pc-workspace-config');

    // Ensure no task worktree was created anywhere in testEnv
    const potentialWorktree = path.join(testEnv.dir, 'project-worktrees');
    expect(fs.existsSync(potentialWorktree)).toBe(false);

    // 2. Corrupted config JSON
    const cfgDir = path.join(repoDir, '.paper-craft');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'workspace-config.json'), '{corrupt-json', 'utf-8');

    const checkCorrupted = runWorkspaceConfigCli(['validate', '--repo-dir', repoDir]);
    expect(checkCorrupted.status).not.toBe(0);
    expect(checkCorrupted.stderr.toLowerCase()).toContain('invalid');

    // 3. Incomplete config (missing required fields)
    fs.writeFileSync(
      path.join(cfgDir, 'workspace-config.json'),
      JSON.stringify({ schema_version: '1.0', delivery_target: 'foo/bar' }),
      'utf-8',
    );
    const checkIncomplete = runWorkspaceConfigCli(['validate', '--repo-dir', repoDir]);
    expect(checkIncomplete.status).not.toBe(0);
    expect(checkIncomplete.stderr).toContain('base_remote');

    // Still no worktree created
    expect(fs.existsSync(potentialWorktree)).toBe(false);
  });

  it('Test 3: Custom worktree container resolution', () => {
    const { repoDir } = setupGitRepo('custom-container-project');

    // Initialize with custom container path
    const initRes = runWorkspaceConfigCli([
      'init',
      '--repo-dir', repoDir,
      '--worktree-container', '../custom-dev-worktrees',
      '--defaults',
    ]);
    expect(initRes.status).toBe(0);

    const receiptRoot = path.join(testEnv.dir, 'receipts', 'issue-50');
    runLifecycleKernelCli([
      'init',
      '--receipt-root', receiptRoot,
      '--root-issue', '50',
      '--repo-dir', repoDir,
    ]);
    const prepResEnvelope = runPrepareTaskCli(receiptRoot, {
      stage: 'workspace_prepare',
      objective: 'Custom container test',
      provider: {
        type: 'script',
        target: PREPARE_WORKTREE_SCRIPT,
      },
      workdir: repoDir,
    });
    expect(prepResEnvelope.status).toBe(0);
    const envelopePath = path.join(receiptRoot, '01-input.json');

    const prepRes = runPrepareWorktreeCli(['--input-envelope', envelopePath]);
    expect(prepRes.status).toBe(0);

    const report: CompactReceiptReport = JSON.parse(prepRes.stdout);
    const expectedContainer = path.resolve(repoDir, '../custom-dev-worktrees');
    const expectedWorktree = path.join(expectedContainer, 'issue-50');
    expect(report.result.worktree).toBe(expectedWorktree);
    expect(fs.existsSync(expectedWorktree)).toBe(true);
  });

  it('Test 4: Fork project with distinct baseline, push, and delivery targets and custom container directory', () => {
    const { repoDir, upstreamHeadSha } = setupForkGitRepo('fork-repo');

    // 1. Initialize workspace config with fork configuration
    const initRes = runWorkspaceConfigCli([
      'init',
      '--repo-dir', repoDir,
      '--delivery-target', 'paper-craft-upstream/demo-repo',
      '--base-remote', 'upstream',
      '--push-remote', 'origin',
      '--base-branch', 'main',
      '--worktree-container', '../custom-fork-worktrees',
      '--defaults',
    ]);
    expect(initRes.status).toBe(0);

    const configPath = path.join(repoDir, '.paper-craft', 'workspace-config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.delivery_target).toBe('paper-craft-upstream/demo-repo');
    expect(config.base_remote).toBe('upstream');
    expect(config.push_remote).toBe('origin');
    expect(config.base_branch).toBe('main');
    expect(config.worktree_container).toBe('../custom-fork-worktrees');

    // 2. Create Task Input Envelope for workspace preparation
    const receiptRoot = path.join(testEnv.dir, 'receipts', 'issue-39');
    runLifecycleKernelCli([
      'init',
      '--receipt-root', receiptRoot,
      '--root-issue', '39',
      '--repo-dir', repoDir,
    ]);
    const prepResEnvelope = runPrepareTaskCli(receiptRoot, {
      stage: 'workspace_prepare',
      objective: 'Prepare workspace for fork issue #39',
      provider: {
        type: 'script',
        target: PREPARE_WORKTREE_SCRIPT,
      },
      workdir: repoDir,
    });
    expect(prepResEnvelope.status).toBe(0);
    const envelopePath = path.join(receiptRoot, '01-input.json');

    const envelope: TaskInputEnvelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    expect(envelope.environment.repository).toBe('paper-craft-upstream/demo-repo');
    expect(envelope.environment.base_branch).toBe('main');
    expect(envelope.inputs.parameters?.delivery_target).toBe('paper-craft-upstream/demo-repo');
    expect(envelope.inputs.parameters?.base_remote).toBe('upstream');
    expect(envelope.inputs.parameters?.push_remote).toBe('origin');
    expect(envelope.inputs.parameters?.worktree_container).toBe('../custom-fork-worktrees');

    // 3. Prepare workspace using prepare-worktree.py with the envelope
    const prepRes = runPrepareWorktreeCli(['--input-envelope', envelopePath]);
    expect(prepRes.status).toBe(0);

    const report: CompactReceiptReport = JSON.parse(prepRes.stdout);
    const receiptPath = report.receipt_path;
    expect(report.execution_status).toBe('succeeded');
    expect(report.result.repository).toBe('paper-craft-upstream/demo-repo');
    expect(report.result.delivery_target).toBe('paper-craft-upstream/demo-repo');
    expect(report.result.base_remote).toBe('upstream');
    expect(report.result.push_remote).toBe('origin');
    expect(report.result.commit).toBe(upstreamHeadSha);

    // Assert worktree is in custom container directory
    const expectedContainer = path.resolve(repoDir, '../custom-fork-worktrees');
    const expectedWorktree = path.join(expectedContainer, 'issue-39');
    expect(report.result.worktree).toBe(expectedWorktree);
    expect(fs.existsSync(expectedWorktree)).toBe(true);

    // Assert worktree contains upstream feature file and its HEAD matches upstream commit
    expect(fs.existsSync(path.join(expectedWorktree, 'UPSTREAM_FEATURE.md'))).toBe(true);
    const worktreeHead = git(expectedWorktree, 'rev-parse', 'HEAD');
    expect(worktreeHead).toBe(upstreamHeadSha);

    // Durable receipt exists and contains fork role information
    expect(fs.existsSync(receiptPath)).toBe(true);
    const receiptContent = fs.readFileSync(receiptPath, 'utf-8');
    expect(receiptContent).toContain('# Subagent Receipt');
    expect(receiptContent).toContain('paper-craft-upstream/demo-repo');
    expect(receiptContent).toContain('upstream');
    expect(receiptContent).toContain('origin');
  });
});
