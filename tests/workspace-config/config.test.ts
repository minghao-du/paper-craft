import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIVERY_ATTEMPTS_MAX,
  DEFAULT_REPLANS_MAX,
  DEFAULT_WORKFLOW,
  DEFAULT_WORKTREE_CONTAINER,
  SCHEMA_VERSION,
  atomicWriteJson,
  findPrimaryCheckout,
  getConfigFilePath,
  parseRepoFromUrl,
  resolveWorkspaceConfig,
} from '../../packages/workspace-config/src/index.js';

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../../packages/workspace-config/src/cli.ts');

describe('workspace-config unit and CLI tests', () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-config-test-')));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempBaseDir)) {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  function git(cwd: string, ...args: string[]): string {
    const res = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10000 });
    if (res.status !== 0) {
      throw new Error(`Git command failed (${args.join(' ')}):\n${res.stderr}`);
    }
    return (res.stdout ?? '').trim();
  }

  function setupStandardRepo(name = 'main-repo'): {
    repoDir: string;
    originBare: string;
  } {
    const originBare = path.join(tempBaseDir, `${name}-origin.git`);
    const repoDir = path.join(tempBaseDir, name);

    git(tempBaseDir, 'init', '--bare', '--initial-branch=main', `${name}-origin.git`);

    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, 'init', '--initial-branch=main');
    git(repoDir, 'config', 'user.name', 'Config Tester');
    git(repoDir, 'config', 'user.email', 'tester@example.invalid');
    git(repoDir, 'config', 'commit.gpgsign', 'false');

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Main Repo\n');
    git(repoDir, 'add', 'README.md');
    git(repoDir, 'commit', '-m', 'Initial commit');
    git(repoDir, 'remote', 'add', 'origin', originBare);
    git(repoDir, 'push', 'origin', 'main');

    return { repoDir, originBare };
  }

  function setupForkRepo(name = 'fork-repo'): {
    repoDir: string;
    originBare: string;
    upstreamBare: string;
  } {
    const originBare = path.join(tempBaseDir, `${name}-origin.git`);
    const upstreamBare = path.join(tempBaseDir, `${name}-upstream.git`);
    const repoDir = path.join(tempBaseDir, name);

    git(tempBaseDir, 'init', '--bare', '--initial-branch=main', `${name}-origin.git`);
    git(tempBaseDir, 'init', '--bare', '--initial-branch=main', `${name}-upstream.git`);

    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, 'init', '--initial-branch=main');
    git(repoDir, 'config', 'user.name', 'Fork Tester');
    git(repoDir, 'config', 'user.email', 'fork@example.invalid');
    git(repoDir, 'config', 'commit.gpgsign', 'false');

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fork Repo\n');
    git(repoDir, 'add', 'README.md');
    git(repoDir, 'commit', '-m', 'Initial commit');
    git(repoDir, 'remote', 'add', 'origin', originBare);
    git(repoDir, 'remote', 'add', 'upstream', upstreamBare);
    git(repoDir, 'push', 'origin', 'main');
    git(repoDir, 'push', 'upstream', 'main');

    return { repoDir, originBare, upstreamBare };
  }

  function runCli(args: string[], cwd: string = tempBaseDir): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const res = spawnSync(process.execPath, [
      '--import', tsxLoader, CLI_PATH, ...args,
    ], {
      cwd,
      encoding: 'utf-8',
      timeout: 15000,
    });
    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  }

  describe('findPrimaryCheckout and Worktree Anchoring', () => {
    it('anchors on primary checkout when resolving from linked worktree', () => {
      const { repoDir } = setupStandardRepo('primary-anchor');
      const linkedDir = path.join(tempBaseDir, 'linked-worktree');

      git(repoDir, 'worktree', 'add', linkedDir, '-b', 'feature-linked');

      const primaryFromSelf = findPrimaryCheckout(repoDir);
      const primaryFromLinked = findPrimaryCheckout(linkedDir);

      expect(primaryFromSelf).toBe(repoDir);
      expect(primaryFromLinked).toBe(repoDir);

      // Initialize config in primary checkout
      const configPath = getConfigFilePath(repoDir);
      atomicWriteJson(configPath, {
        schema_version: SCHEMA_VERSION,
        delivery_target: 'acme/primary-anchor',
        base_remote: 'origin',
        push_remote: 'origin',
        base_branch: 'main',
        worktree_container: '../project-worktrees',
      });

      // Resolving from primary
      const resolvedFromPrimary = resolveWorkspaceConfig({ repoDir });
      expect(resolvedFromPrimary.repo_checkout).toBe(repoDir);
      expect(resolvedFromPrimary.worktree_container_resolved).toBe(
        path.resolve(repoDir, '../project-worktrees'),
      );

      // Resolving from linked worktree should anchor on primary checkout
      const resolvedFromLinked = resolveWorkspaceConfig({ repoDir: linkedDir });
      expect(resolvedFromLinked.repo_checkout).toBe(repoDir);
      expect(resolvedFromLinked.worktree_container_resolved).toBe(
        path.resolve(repoDir, '../project-worktrees'),
      );
      expect(resolvedFromLinked.delivery_target).toBe('acme/primary-anchor');
    });

    it('fails clearly when directory is not a git repository', () => {
      const nonGitDir = path.join(tempBaseDir, 'not-a-git-repo');
      fs.mkdirSync(nonGitDir);

      expect(() => findPrimaryCheckout(nonGitDir)).toThrow(
        /not in a git repository or git command failed/,
      );
      expect(() => resolveWorkspaceConfig({ repoDir: nonGitDir })).toThrow(
        /not in a git repository or git command failed/,
      );
    });
  });

  describe('Explicit configPath and Default Resolution Rules', () => {
    it('uses explicit configPath when it exists', () => {
      const { repoDir } = setupStandardRepo('custom-config-repo');
      const customConfigPath = path.join(repoDir, 'custom-configs', 'workspaces.json');

      atomicWriteJson(customConfigPath, {
        schema_version: SCHEMA_VERSION,
        delivery_target: 'explicit/target',
        base_remote: 'origin',
        push_remote: 'origin',
        base_branch: 'main',
        worktree_container: '../custom-worktrees',
      });

      // Relative configPath resolved against repoDir
      const resolvedRel = resolveWorkspaceConfig({
        repoDir,
        configPath: 'custom-configs/workspaces.json',
      });
      expect(resolvedRel.delivery_target).toBe('explicit/target');
      expect(resolvedRel.worktree_container).toBe('../custom-worktrees');

      // Absolute configPath
      const resolvedAbs = resolveWorkspaceConfig({
        repoDir,
        configPath: customConfigPath,
      });
      expect(resolvedAbs.delivery_target).toBe('explicit/target');
    });

    it('throws error when explicit configPath does not exist and does not silently fall back', () => {
      const { repoDir } = setupStandardRepo('missing-explicit-repo');
      const missingConfig = path.join(repoDir, 'missing.json');

      expect(() =>
        resolveWorkspaceConfig({
          repoDir,
          configPath: missingConfig,
        }),
      ).toThrow(/Specified workspace configuration file does not exist/);
    });

    it('handles default config missing according to requireFile flag', () => {
      const { repoDir } = setupStandardRepo('no-config-repo');

      // requireFile: true throws
      expect(() =>
        resolveWorkspaceConfig({
          repoDir,
          requireFile: true,
        }),
      ).toThrow(/Workspace configuration missing at/);

      // requireFile: false succeeds using Git facts and default container
      const resolved = resolveWorkspaceConfig({
        repoDir,
        requireFile: false,
        overrides: {
          delivery_target: 'org/repo',
        },
      });
      expect(resolved.delivery_target).toBe('org/repo');
      expect(resolved.base_remote).toBe('origin');
      expect(resolved.base_branch).toBe('main');
      expect(resolved.worktree_container).toBe(DEFAULT_WORKTREE_CONTAINER);
    });
  });

  describe('Invalid Configuration Handling', () => {
    it('throws on corrupted JSON in configuration file', () => {
      const { repoDir } = setupStandardRepo('corrupted-json-repo');
      const configPath = getConfigFilePath(repoDir);
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{not-valid-json');

      expect(() => resolveWorkspaceConfig({ repoDir })).toThrow(/Malformed JSON in workspace configuration/);
    });

    it('throws on invalid schema version and missing required fields', () => {
      const { repoDir } = setupStandardRepo('invalid-schema-repo');
      const configPath = getConfigFilePath(repoDir);
      atomicWriteJson(configPath, {
        schema_version: '999.0',
        delivery_target: '',
      });

      expect(() => resolveWorkspaceConfig({ repoDir })).toThrow(/Invalid schema_version/);
    });

    it('throws when config specifies a git remote that does not exist', () => {
      const { repoDir } = setupStandardRepo('nonexistent-remote-repo');
      const configPath = getConfigFilePath(repoDir);
      atomicWriteJson(configPath, {
        schema_version: SCHEMA_VERSION,
        delivery_target: 'acme/repo',
        base_remote: 'nonexistent-remote',
        push_remote: 'origin',
        base_branch: 'main',
        worktree_container: '../worktrees',
      });

      expect(() => resolveWorkspaceConfig({ repoDir })).toThrow(/does not exist in git remotes/);
    });

    it('explicit overrides do not mask an invalid configuration file', () => {
      const { repoDir } = setupStandardRepo('override-mask-repo');
      const configPath = getConfigFilePath(repoDir);
      atomicWriteJson(configPath, {
        schema_version: SCHEMA_VERSION,
        // missing required fields
      });

      expect(() =>
        resolveWorkspaceConfig({
          repoDir,
          overrides: {
            delivery_target: 'valid/target',
            base_remote: 'origin',
            push_remote: 'origin',
            base_branch: 'main',
            worktree_container: '../worktrees',
          },
        }),
      ).toThrow(/Workspace configuration at .* is invalid/);
    });
  });

  describe('Fork Scenario Resolution', () => {
    it('resolves base_remote as upstream and push_remote as origin in fork repo', () => {
      const { repoDir, upstreamBare } = setupForkRepo('fork-resolution-repo');

      const resolved = resolveWorkspaceConfig({
        repoDir,
        requireFile: false,
      });

      expect(resolved.base_remote).toBe('upstream');
      expect(resolved.push_remote).toBe('origin');
      expect(resolved.base_branch).toBe('main');
      expect(resolved.delivery_target).toBe(parseRepoFromUrl(upstreamBare));
    });

    it('allows overriding push_remote and delivery_target in fork repo', () => {
      const { repoDir, upstreamBare } = setupForkRepo('fork-override-repo');
      git(repoDir, 'remote', 'add', 'custom-push', upstreamBare);

      const resolved = resolveWorkspaceConfig({
        repoDir,
        requireFile: false,
        overrides: {
          delivery_target: 'custom-upstream/fork-target',
          push_remote: 'custom-push',
        },
      });

      expect(resolved.delivery_target).toBe('custom-upstream/fork-target');
      expect(resolved.push_remote).toBe('custom-push');
      expect(resolved.base_remote).toBe('upstream');
    });
  });

  describe('Critical Value Fallback Blocking', () => {
    it('blocks and refuses to guess base_remote when repo has no remotes', () => {
      const noRemoteDir = path.join(tempBaseDir, 'no-remotes');
      fs.mkdirSync(noRemoteDir);
      git(noRemoteDir, 'init', '--initial-branch=main');

      expect(() =>
        resolveWorkspaceConfig({
          repoDir: noRemoteDir,
          requireFile: false,
        }),
      ).toThrow(/Cannot determine base_remote/);
    });

    it('blocks and refuses to guess delivery_target when undetectable', () => {
      const bareLocal = path.join(tempBaseDir, 'empty.git');
      git(tempBaseDir, 'init', '--bare', 'empty.git');
      const localRepo = path.join(tempBaseDir, 'local-repo');
      fs.mkdirSync(localRepo);
      git(localRepo, 'init', '--initial-branch=main');
      git(localRepo, 'remote', 'add', 'origin', bareLocal);
      fs.writeFileSync(path.join(localRepo, 'file.txt'), 'hi');
      git(localRepo, 'add', 'file.txt');
      git(localRepo, 'config', 'user.name', 'Tester');
      git(localRepo, 'config', 'user.email', 'tester@example.com');
      git(localRepo, 'commit', '-m', 'init');

      // delivery_target undetectable if remote is empty name without slash/stem
      // When explicitly specified, it succeeds:
      const resolved = resolveWorkspaceConfig({
        repoDir: localRepo,
        overrides: {
          delivery_target: 'org/project',
        },
      });
      expect(resolved.delivery_target).toBe('org/project');
    });
  });

  describe('CLI Subcommands: init, show, validate', () => {
    it('init --defaults initializes standard repo and writes config to primary checkout', () => {
      const { repoDir } = setupStandardRepo('cli-init-standard');

      const res = runCli(['init', '--repo-dir', repoDir, '--defaults']);
      expect(res.status).toBe(0);

      const configPath = getConfigFilePath(repoDir);
      expect(fs.existsSync(configPath)).toBe(true);

      const parsedStdout = JSON.parse(res.stdout);
      expect(parsedStdout.schema_version).toBe('1.0');
      expect(parsedStdout.base_remote).toBe('origin');
      expect(parsedStdout.push_remote).toBe('origin');
      expect(parsedStdout.base_branch).toBe('main');
      expect(parsedStdout.worktree_container).toBe(DEFAULT_WORKTREE_CONTAINER);
      expect(parsedStdout.workflow).toBe(DEFAULT_WORKFLOW);
      expect(parsedStdout.delivery_attempts_max).toBe(DEFAULT_DELIVERY_ATTEMPTS_MAX);
      expect(parsedStdout.replans_max).toBe(DEFAULT_REPLANS_MAX);
    });

    it('init with explicit arguments records custom configuration', () => {
      const { repoDir } = setupStandardRepo('cli-init-custom');

      const res = runCli([
        'init',
        '--repo-dir', repoDir,
        '--delivery-target', 'custom-org/custom-repo',
        '--worktree-container', '../custom-worktrees',
        '--workflow', 'custom-workflow',
        '--delivery-attempts-max', '5',
        '--replans-max', '4',
        '--defaults',
      ]);
      expect(res.status).toBe(0);

      const config = JSON.parse(fs.readFileSync(getConfigFilePath(repoDir), 'utf8'));
      expect(config.delivery_target).toBe('custom-org/custom-repo');
      expect(config.worktree_container).toBe('../custom-worktrees');
      expect(config.workflow).toBe('custom-workflow');
      expect(config.delivery_attempts_max).toBe(5);
      expect(config.replans_max).toBe(4);
    });

    it('init from a linked worktree writes config to primary checkout', () => {
      const { repoDir } = setupStandardRepo('cli-init-linked');
      const linkedDir = path.join(tempBaseDir, 'linked-for-cli');
      git(repoDir, 'worktree', 'add', linkedDir, '-b', 'feature-cli');

      const res = runCli(['init', '--repo-dir', linkedDir, '--defaults']);
      expect(res.status).toBe(0);

      const primaryConfig = getConfigFilePath(repoDir);
      expect(fs.existsSync(primaryConfig)).toBe(true);

      const linkedConfig = getConfigFilePath(linkedDir);
      expect(fs.existsSync(linkedConfig)).toBe(false);
    });

    it('init fails when remote is undetectable and not explicitly provided', () => {
      const noRemoteDir = path.join(tempBaseDir, 'cli-no-remote');
      fs.mkdirSync(noRemoteDir);
      git(noRemoteDir, 'init', '--initial-branch=main');

      const res = runCli(['init', '--repo-dir', noRemoteDir, '--defaults']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('No git remotes configured');
    });

    it('show displays config in JSON format and fails when missing', () => {
      const { repoDir } = setupStandardRepo('cli-show-repo');

      // Unconfigured
      const resUnconfigured = runCli(['show', '--repo-dir', repoDir]);
      expect(resUnconfigured.status).toBe(1);
      expect(resUnconfigured.stderr).toContain('Workspace configuration missing');

      // Initialize
      runCli(['init', '--repo-dir', repoDir, '--defaults']);

      // Show configured
      const resConfigured = runCli(['show', '--repo-dir', repoDir]);
      expect(resConfigured.status).toBe(0);
      const data = JSON.parse(resConfigured.stdout);
      expect(data.schema_version).toBe('1.0');
      expect(data.base_remote).toBe('origin');
    });

    it('validate passes on valid config and fails on missing or invalid config', () => {
      const { repoDir } = setupStandardRepo('cli-validate-repo');

      // Missing
      const resMissing = runCli(['validate', '--repo-dir', repoDir]);
      expect(resMissing.status).toBe(1);
      expect(resMissing.stderr).toContain('Workspace configuration is missing');

      // Initialize
      runCli(['init', '--repo-dir', repoDir, '--defaults']);

      // Valid
      const resValid = runCli(['validate', '--repo-dir', repoDir]);
      expect(resValid.status).toBe(0);
      expect(resValid.stdout).toContain('Workspace configuration is valid');

      // Corrupt file
      const configPath = getConfigFilePath(repoDir);
      fs.writeFileSync(configPath, '{corrupted-json');
      const resCorrupt = runCli(['validate', '--repo-dir', repoDir]);
      expect(resCorrupt.status).toBe(1);
      expect(resCorrupt.stderr).toContain('invalid');
    });

    it('invocation without subcommand runs show if configured or exits 1 if missing', () => {
      const { repoDir } = setupStandardRepo('cli-no-subcommand-repo');

      // Missing
      const resMissing = runCli(['--repo-dir', repoDir]);
      expect(resMissing.status).toBe(1);
      expect(resMissing.stderr).toContain('Workspace configuration is missing');

      // Initialize
      runCli(['init', '--repo-dir', repoDir, '--defaults']);

      // Present
      const resPresent = runCli(['--repo-dir', repoDir]);
      expect(resPresent.status).toBe(0);
      const parsed = JSON.parse(resPresent.stdout);
      expect(parsed.schema_version).toBe('1.0');
    });

    it('rejects obsolete aliases (--show, --init, --validate) with exit code 1', () => {
      const { repoDir } = setupStandardRepo('cli-aliases-repo');

      const resShow = runCli(['--show', '--repo-dir', repoDir]);
      expect(resShow.status).toBe(1);
      expect(resShow.stderr).toContain('Unknown option');

      const resInit = runCli(['--init', '--repo-dir', repoDir]);
      expect(resInit.status).toBe(1);
      expect(resInit.stderr).toContain('Unknown option');

      const resValidate = runCli(['--validate', '--repo-dir', repoDir]);
      expect(resValidate.status).toBe(1);
      expect(resValidate.stderr).toContain('Unknown option');
    });
  });

  describe('atomicWriteJson', () => {
    it('atomically writes formatted JSON with parent directory creation', () => {
      const targetFile = path.join(tempBaseDir, 'nested', 'subdir', 'data.json');
      const testData = { name: 'paper-craft', active: true, count: 42 };

      atomicWriteJson(targetFile, testData);

      expect(fs.existsSync(targetFile)).toBe(true);
      const content = fs.readFileSync(targetFile, 'utf8');
      expect(JSON.parse(content)).toEqual(testData);
      expect(content.endsWith('\n')).toBe(true);

      // Verify no temporary files remain
      const files = fs.readdirSync(path.dirname(targetFile));
      expect(files).toEqual(['data.json']);
    });
  });
});
