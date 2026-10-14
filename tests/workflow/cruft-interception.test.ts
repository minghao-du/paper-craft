/**
 * Cruft Interception Test.
 *
 * Verifies that the workflow readiness check defensively categorizes uncommitted
 * files, intercepts artifact cruft (output/*, results/*, *.joblib, *.pt, *.tsv,
 * *.csv, *.png), refuses to prompt for commit when cruft is present, and blocks
 * gate passage with an actionable warning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  checkWorktreeReadiness,
  categorizeGitStatus,
  isCruftFile,
  runReadinessCheck,
} from '../../src/workflow/readiness.js';

describe('Cruft Interception and Worktree Readiness Check', () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await mkdtemp(join(tmpdir(), 'pc-cruft-test-'));
    // Initialize temporary git repository
    execSync('git init -b main', { cwd: tempRepo, stdio: 'ignore' });
    execSync('git config user.name "Test Committer"', { cwd: tempRepo, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempRepo, stdio: 'ignore' });

    // Create an initial commit so git status has a valid HEAD
    await writeFile(join(tempRepo, 'README.md'), '# Test Project\nInitial readme content.\n');
    execSync('git add README.md && git commit -m "initial commit"', {
      cwd: tempRepo,
      stdio: 'ignore',
    });
  });

  afterEach(async () => {
    await rm(tempRepo, { recursive: true, force: true });
  });

  it('fails with non-zero exit code, categorizes cruft, and refuses to prompt commit when artifacts exist', async () => {
    // 1. Create transient cruft and output artifacts
    await mkdir(join(tempRepo, 'output'), { recursive: true });
    await writeFile(join(tempRepo, 'output', 'model.joblib'), 'binary model data');

    await mkdir(join(tempRepo, 'results'), { recursive: true });
    await writeFile(join(tempRepo, 'results', 'predictions.tsv'), 'id\tscore\n1\t0.95\n');

    // 2. Create legitimate modified source file
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await writeFile(join(tempRepo, 'src', 'index.ts'), 'export const answer = 42;\n');

    // 3. Run readiness check against the simulated workspace
    const result = checkWorktreeReadiness({ cwd: tempRepo });

    // Assert: gate fails and exits non-zero
    expect(result.clean).toBe(false);
    expect(result.hasCruft).toBe(true);
    expect(result.exitCode).toBe(1);

    // Assert: files are correctly categorized
    expect(result.cruftFiles).toContain('output/model.joblib');
    expect(result.cruftFiles).toContain('results/predictions.tsv');
    expect(result.legitimateFiles).toContain('src/index.ts');

    // Assert: gate strictly REFUSES to prompt for commit while cruft exists
    expect(result.shouldPromptCommit).toBe(false);

    // Assert: actionable warning instructs user/agent on remediation options
    expect(result.message).toContain('🚨 Cruft / transient output artifacts detected');
    expect(result.message).toContain('.gitignore');
    expect(result.message).toContain('_ignore/');
    expect(result.message).toContain('output/model.joblib');
    expect(result.message).toContain('results/predictions.tsv');
  });

  it('passes cleanly when worktree contains zero uncommitted changes', async () => {
    const result = checkWorktreeReadiness({ cwd: tempRepo });

    expect(result.clean).toBe(true);
    expect(result.hasCruft).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.cruftFiles).toHaveLength(0);
    expect(result.legitimateFiles).toHaveLength(0);
    expect(result.shouldPromptCommit).toBe(false);
    expect(result.message).toBe('Worktree is clean.');
  });

  it('prompts staging for legitimate files when no cruft is present', async () => {
    // Modify existing tracked file
    await writeFile(join(tempRepo, 'README.md'), '# Updated Readme\n');

    // Add new legitimate source file
    await mkdir(join(tempRepo, 'src'), { recursive: true });
    await writeFile(join(tempRepo, 'src', 'utils.ts'), 'export function helper() {}\n');

    const result = checkWorktreeReadiness({ cwd: tempRepo });

    expect(result.clean).toBe(false);
    expect(result.hasCruft).toBe(false);
    expect(result.cruftFiles).toHaveLength(0);
    expect(result.legitimateFiles).toContain('README.md');
    expect(result.legitimateFiles).toContain('src/utils.ts');

    // Prompt staging for legitimate changes
    expect(result.shouldPromptCommit).toBe(true);
    expect(result.message).toContain('Uncommitted legitimate changes detected:');
    expect(result.message).toContain('git add <file>');
  });

  it('permits gate passage after cruft is quarantined in .gitignore', async () => {
    // Create cruft in output directory
    await mkdir(join(tempRepo, 'output'), { recursive: true });
    await writeFile(join(tempRepo, 'output', 'model.joblib'), 'weights');

    // Initial check blocks
    const initialResult = checkWorktreeReadiness({ cwd: tempRepo });
    expect(initialResult.hasCruft).toBe(true);
    expect(initialResult.shouldPromptCommit).toBe(false);

    // Remediate by ignoring output/ in .gitignore
    await writeFile(join(tempRepo, '.gitignore'), 'output/\n');
    execSync('git add .gitignore && git commit -m "chore: ignore output directory"', {
      cwd: tempRepo,
      stdio: 'ignore',
    });

    // Re-check: output/ is now ignored by git and no longer appears in git status
    const remediatedResult = checkWorktreeReadiness({ cwd: tempRepo });
    expect(remediatedResult.hasCruft).toBe(false);
    expect(remediatedResult.clean).toBe(true);
    expect(remediatedResult.exitCode).toBe(0);
  });

  it('correctly classifies varied cruft patterns across model weights, tables, plots, and caches', () => {
    expect(isCruftFile('output/eval.json')).toBe(true);
    expect(isCruftFile('results/benchmark.txt')).toBe(true);
    expect(isCruftFile('model.joblib')).toBe(true);
    expect(isCruftFile('checkpoint.pt')).toBe(true);
    expect(isCruftFile('weights.pth')).toBe(true);
    expect(isCruftFile('export.onnx')).toBe(true);
    expect(isCruftFile('data/predictions.tsv')).toBe(true);
    expect(isCruftFile('measurements.csv')).toBe(true);
    expect(isCruftFile('features.parquet')).toBe(true);
    expect(isCruftFile('embeddings.npy')).toBe(true);
    expect(isCruftFile('plot.png')).toBe(true);
    expect(isCruftFile('figure.svg')).toBe(true);
    expect(isCruftFile('chart.pdf')).toBe(true);
    expect(isCruftFile('__pycache__/mod.cpython-310.pyc')).toBe(true);

    // Legitimate files outside cruft patterns
    expect(isCruftFile('src/index.ts')).toBe(false);
    expect(isCruftFile('package.json')).toBe(false);
    expect(isCruftFile('README.md')).toBe(false);
    expect(isCruftFile('.gitignore')).toBe(false);

    // Exempt directory paths
    expect(isCruftFile('docs/architecture.png')).toBe(false);
    expect(isCruftFile('assets/logo.svg')).toBe(false);
    expect(isCruftFile('tests/fixtures/sample.csv')).toBe(false);
    expect(isCruftFile('testdata/mock.tsv')).toBe(false);
  });

  it('correctly categorizes raw git status output lines', () => {
    const gitStatusOutput = [
      '?? output/model.joblib',
      '?? results/predictions.tsv',
      '?? plot.png',
      ' M src/workflow/readiness.ts',
      '?? tests/workflow/cruft.test.ts',
      '?? docs/diagram.png',
      ' M README.md',
    ].join('\n');

    const categorized = categorizeGitStatus(gitStatusOutput);

    expect(categorized.cruft).toEqual([
      'output/model.joblib',
      'results/predictions.tsv',
      'plot.png',
    ]);
    expect(categorized.legitimate).toEqual([
      'src/workflow/readiness.ts',
      'tests/workflow/cruft.test.ts',
      'docs/diagram.png',
      'README.md',
    ]);
  });

  it('intercepts cruft when executed via runReadinessCheck helper', async () => {
    await mkdir(join(tempRepo, 'output'), { recursive: true });
    await writeFile(join(tempRepo, 'output', 'model.joblib'), 'binary');

    const result = runReadinessCheck(tempRepo);

    expect(result.exitCode).toBe(1);
    expect(result.hasCruft).toBe(true);
    expect(result.shouldPromptCommit).toBe(false);
  });
});
