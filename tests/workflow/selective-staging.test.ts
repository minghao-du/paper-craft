import { runStagedDiffAudit } from '../../packages/cli/src/workflow/staging.js';
/**
 * Selective Staging and Pre-Commit Cached Diff Audit Test.
 *
 * Verifies that:
 * 1. In a workspace with modified source files (src/index.ts) and untracked/staged
 *    output artifacts (output/model.joblib), only source files get staged and
 *    any cached artifact files are un-staged before commit.
 * 2. Pre-commit cached diff audits inspect staged files against forbidden transient patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  auditStagedDiff,
  unstageCruft,
  unstageFiles,
  selectiveStage,
} from '@paper-craft/core/workflow/staging';

describe('Selective Staging & Pre-Commit Cached Diff Audit', () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await mkdtemp(join(tmpdir(), 'pc-staging-test-'));
    // Initialize temporary git repository
    execSync('git init -b main', { cwd: tempRepo, stdio: 'ignore' });
    execSync('git config user.name "Test Committer"', { cwd: tempRepo, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempRepo, stdio: 'ignore' });

    // Create an initial commit so git status and git diff have a valid HEAD
    await writeFile(join(tempRepo, 'README.md'), '# Initial Repository\n');
    execSync('git add README.md && git commit -m "initial commit"', {
      cwd: tempRepo,
      stdio: 'ignore',
    });
  });

  afterEach(async () => {
    await rm(tempRepo, { recursive: true, force: true });
  });

  it('verifies that only source files get staged and cached artifact files are un-staged before commit', async () => {
    // 1. Create a modified source file: src/index.ts
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await writeFile(join(tempRepo, 'src', 'index.ts'), 'export const version = "1.0.0";\n');

    // 2. Create transient output artifacts: output/model.joblib and results/eval.csv
    await mkdir(join(tempRepo, 'output'), { recursive: true });
    await writeFile(join(tempRepo, 'output', 'model.joblib'), 'binary model weights');

    await mkdir(join(tempRepo, 'results'), { recursive: true });
    await writeFile(join(tempRepo, 'results', 'eval.csv'), 'epoch,loss\n1,0.42\n');

    // 3. Simulate an indiscriminate or accidental staging of both source and artifact files
    execSync('git add src/index.ts output/model.joblib results/eval.csv', {
      cwd: tempRepo,
      stdio: 'ignore',
    });

    // 4. Audit staged cache
    const initialAudit = auditStagedDiff({ cwd: tempRepo });
    expect(initialAudit.clean).toBe(false);
    expect(initialAudit.hasCruft).toBe(true);
    expect(initialAudit.cruftFiles).toContain('output/model.joblib');
    expect(initialAudit.cruftFiles).toContain('results/eval.csv');
    expect(initialAudit.legitimateFiles).toContain('src/index.ts');

    // 5. Automatically unstage cruft files before commit
    const unstageResult = unstageCruft({ cwd: tempRepo, auditResult: initialAudit });
    expect(unstageResult.unstaged).toContain('output/model.joblib');
    expect(unstageResult.unstaged).toContain('results/eval.csv');
    expect(unstageResult.audit.clean).toBe(true);
    expect(unstageResult.audit.hasCruft).toBe(false);
    expect(unstageResult.audit.stagedFiles).toEqual(['src/index.ts']);

    // 6. Confirm with git command directly that only src/index.ts remains staged
    const stagedNow = execSync('git diff --cached --name-only', {
      cwd: tempRepo,
      encoding: 'utf-8',
    }).trim();
    expect(stagedNow).toBe('src/index.ts');

    // 7. Commit staged changes cleanly
    execSync('git commit -m "feat: add index entrypoint"', {
      cwd: tempRepo,
      stdio: 'ignore',
    });

    // 8. Verify the committed tree contains only the source file and zero cruft
    const commitFiles = execSync('git show --name-only --format="" HEAD', {
      cwd: tempRepo,
      encoding: 'utf-8',
    }).trim();
    expect(commitFiles).toBe('src/index.ts');

    // 9. Verify the artifact file still exists untracked on disk
    const statusShort = execSync('git status --short', {
      cwd: tempRepo,
      encoding: 'utf-8',
    });
    expect(statusShort).toContain('?? output/');
    expect(statusShort).toContain('?? results/');
  });

  it('selectively stages only legitimate files and skips untracked artifacts when using selectiveStage', async () => {
    // Create source files and untracked artifact files
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await writeFile(join(tempRepo, 'src', 'index.ts'), 'export const active = true;\n');

    await mkdir(join(tempRepo, 'output'), { recursive: true });
    await writeFile(join(tempRepo, 'output', 'model.joblib'), 'weights data');

    await writeFile(join(tempRepo, 'plot.png'), 'image bytes');

    // Run selectiveStage with candidate file list
    const result = selectiveStage(
      ['src/index.ts', 'output/model.joblib', 'plot.png'],
      { cwd: tempRepo }
    );

    expect(result.staged).toEqual(['src/index.ts']);
    expect(result.skippedCruft).toContain('output/model.joblib');
    expect(result.skippedCruft).toContain('plot.png');
    expect(result.audit.clean).toBe(true);
    expect(result.audit.hasCruft).toBe(false);
    expect(result.audit.stagedFiles).toEqual(['src/index.ts']);

    // Staged diff confirms only src/index.ts is staged
    const staged = execSync('git diff --cached --name-only', {
      cwd: tempRepo,
      encoding: 'utf-8',
    }).trim();
    expect(staged).toBe('src/index.ts');
  });

  it('discovers and selectively stages only legitimate uncommitted files when no file list is passed', async () => {
    // Create new source file and documentation
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await writeFile(join(tempRepo, 'src', 'config.ts'), 'export const port = 8080;\n');
    await writeFile(join(tempRepo, 'GUIDE.md'), '# Developer Guide\n');

    // Create untracked transient cruft
    await mkdir(join(tempRepo, 'output'), { recursive: true });
    await writeFile(join(tempRepo, 'output', 'model.pt'), 'pytorch weights');

    // Run selectiveStage with discovery from git status
    const result = selectiveStage({ cwd: tempRepo });

    expect(result.staged).toContain('src/config.ts');
    expect(result.staged).toContain('GUIDE.md');
    expect(result.skippedCruft).toContain('output/model.pt');
    expect(result.audit.clean).toBe(true);
    expect(result.audit.hasCruft).toBe(false);

    const staged = execSync('git diff --cached --name-only', {
      cwd: tempRepo,
      encoding: 'utf-8',
    }).trim().split('\n');

    expect(staged).toContain('src/config.ts');
    expect(staged).toContain('GUIDE.md');
    expect(staged).not.toContain('output/model.pt');
  });

  it('unstageFiles directly unstages targeted files from git index', async () => {
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await writeFile(join(tempRepo, 'src', 'index.ts'), 'export const a = 1;\n');
    await writeFile(join(tempRepo, 'test.csv'), '1,2,3\n');

    execSync('git add src/index.ts test.csv', { cwd: tempRepo, stdio: 'ignore' });

    const unstaged = unstageFiles(['test.csv'], { cwd: tempRepo });
    expect(unstaged).toEqual(['test.csv']);

    const staged = execSync('git diff --cached --name-only', {
      cwd: tempRepo,
      encoding: 'utf-8',
    }).trim();
    expect(staged).toBe('src/index.ts');
  });

  it('audits staged diff from pre-captured string without running git', () => {
    const diffText = [
      'src/workflow/staging.ts',
      'output/model.joblib',
      'results/metrics.tsv',
      'docs/overview.md',
      'figure.png',
    ].join('\n');

    const audit = auditStagedDiff({ diffOutput: diffText });

    expect(audit.clean).toBe(false);
    expect(audit.hasCruft).toBe(true);
    expect(audit.stagedFiles).toHaveLength(5);
    expect(audit.cruftFiles).toEqual([
      'output/model.joblib',
      'results/metrics.tsv',
      'figure.png',
    ]);
    expect(audit.legitimateFiles).toEqual([
      'src/workflow/staging.ts',
      'docs/overview.md',
    ]);
    expect(audit.message).toContain('🚨 Staged diff contains forbidden transient output artifacts.');
  });

  it('returns clean audit when no files are staged', () => {
    const audit = auditStagedDiff({ diffOutput: '' });
    expect(audit.clean).toBe(true);
    expect(audit.hasCruft).toBe(false);
    expect(audit.stagedFiles).toHaveLength(0);
    expect(audit.message).toBe('No changes staged for commit.');
  });


  it('runStagedDiffAudit logs clean audit message to stdout', async () => {
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await writeFile(join(tempRepo, 'src', 'index.ts'), 'export const hello = "world";\n');
    execSync('git add src/index.ts', { cwd: tempRepo, stdio: 'ignore' });

    const audit = runStagedDiffAudit(tempRepo);
    expect(audit.clean).toBe(true);
    expect(audit.hasCruft).toBe(false);
    expect(audit.message).toContain('Staged diff is clean');
  });
});
