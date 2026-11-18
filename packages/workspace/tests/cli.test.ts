import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { resolvePath } from '../src/git.js';

// Failure mode: lenient parsing (parseInt('12abc'), ignored unknown flags, last-wins
// duplicates) lets malformed invocations reach Git/receipt side effects.
describe('workspace CLI strict argument parsing', () => {
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cli-test-'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const bad: string[][] = [
    ['bogus'],
    ['prepare', 'extra'],
    ['prepare', '--nope'],
    ['prepare', '--issue'],
    ['prepare', '--issue', '--branch', 'x'],
    ['prepare', '--issue', '12abc'],
    ['prepare', '--issue', '0'],
    ['prepare', '--issue', '-1'],
    ['prepare', '--issue', '1.5'],
    ['prepare', '--issue', ''],
    ['prepare', '--issue', '99999999999999999999'],
    ['prepare', '--output-format', 'xml'],
    ['prepare', '--branch', 'a', '--branch', 'b'],
    ['prepare', '--input', 'a.json', '--input-envelope', 'b.json'],
    ['prepare', '--cleanup'],
  ];

  it.each(bad)('rejects %j with no side effects', async (...argv) => {
    const receipt = path.join(tmp, 'receipt.md');
    const code = await main([...argv, '--repo-dir', path.join(tmp, 'missing'), '--receipt-path', receipt]);
    expect(code).not.toBe(0);
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
  });

  it('help returns 0 without receipts', async () => {
    const receipt = path.join(tmp, 'receipt.md');
    expect(await main(['prepare', '--receipt-path', receipt, '--help'])).toBe(0);
    expect(logSpy).toHaveBeenCalled();
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it('cleanup CLI with malformed candidate flag exits non-zero with no side effects', async () => {
    const envelopePath = path.join(tmp, 'bad-cleanup-envelope.json');
    const receiptPath = path.join(tmp, 'receipt.md');
    const envelope = {
      schema_version: '1.0',
      task: { logical_stage: 'workspace_cleanup', root_issue_id: '99' },
      environment: { working_directory: tmp },
      inputs: {
        parameters: {
          candidates: [
            {
              branch: 'issue-99',
              created: 'false',
            },
          ],
        },
      },
      contract: { receipt_path: receiptPath },
    };
    fs.writeFileSync(envelopePath, JSON.stringify(envelope));

    const code = await main([
      'cleanup',
      '--input-envelope',
      envelopePath,
      '--repo-dir',
      tmp,
      '--receipt-path',
      receiptPath,
    ]);

    expect(code).not.toBe(0);
    expect(errSpy).toHaveBeenCalled();
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  function setupTempGitRepo(repoDir: string): string {
    const git = (...args: string[]) => {
      const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
      if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
      }
      return res.stdout.trim();
    };
    fs.mkdirSync(repoDir, { recursive: true });
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'CLI Tester');
    git('config', 'user.email', 'cli@example.com');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repoDir, '.gitignore'), '.paper-craft/\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# CLI Test Repo\n');
    git('add', '.gitignore', 'README.md');
    git('commit', '-m', 'Initial commit');
    git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    return git('rev-parse', 'HEAD');
  }

  it('prepares detached orchestrator envelope end-to-end and retains issue audit metadata', async () => {
    const repoDir = path.join(tmp, 'repo');
    const sha = setupTempGitRepo(repoDir);
    const wtDir = path.join(tmp, 'verify-wt');
    const envelopePath = path.join(tmp, '05-input.json');
    const receiptPath = path.join(tmp, '05-receipt.md');

    const envelope = {
      schema_version: '1.0',
      task: {
        logical_stage: 'workspace_prepare',
        step_index: 5,
        attempt: 1,
        root_issue_id: '150',
        current_issue_id: '150',
      },
      provider: { type: 'skill', target: 'pc-workspace' },
      environment: {
        working_directory: repoDir,
        repository: 'owner/repo',
        base_branch: 'main',
        branch: null,
        commit: sha,
      },
      inputs: {
        objective: 'Prepare detached verification worktree',
        parameters: {
          worktree: wtDir,
        },
      },
      contract: {
        receipt_path: receiptPath,
      },
      budgets: {},
    };
    fs.writeFileSync(envelopePath, JSON.stringify(envelope, null, 2));

    const code = await main(['prepare', '--input-envelope', envelopePath]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const report = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(report.execution_status).toBe('succeeded');
    expect(report.result.branch).toBeNull();
    expect(report.result.commit).toBe(sha);
    expect(report.result.worktree).toBe(resolvePath(wtDir));
    expect(report.summary).toBe(
      `Prepared detached worktree at ${resolvePath(wtDir)} pinned to commit ${sha}`,
    );

    const receipt = fs.readFileSync(receiptPath, 'utf8');
    expect(receipt).toContain('- root_issue_id: 150');
    expect(receipt).toContain('- current_issue_id: 150');
    expect(receipt).toContain('- Worktree ownership: created fresh detached worktree.');
  });

  it('preserves envelope and request artifacts in blocked receipt when execution fails', async () => {
    const repoDir = path.join(tmp, 'repo');
    setupTempGitRepo(repoDir);
    const wtDir = path.join(tmp, 'verify-wt');
    const missingSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const envelopePath = path.join(tmp, '06-input.json');
    const receiptPath = path.join(tmp, '06-receipt.md');

    const envelope = {
      schema_version: '1.0',
      task: {
        logical_stage: 'workspace_prepare',
        step_index: 6,
        attempt: 1,
        root_issue_id: '150',
        current_issue_id: '150',
      },
      provider: { type: 'skill', target: 'pc-workspace' },
      environment: {
        working_directory: repoDir,
        repository: 'owner/repo',
        delivery_target: 'owner/repo',
        base_remote: 'upstream',
        push_remote: 'origin',
        base_branch: 'main',
        branch: null,
        commit: missingSha,
      },
      inputs: {
        objective: 'Attempt detached worktree on missing commit',
        parameters: {
          worktree: wtDir,
        },
      },
      contract: {
        receipt_path: receiptPath,
      },
      budgets: {},
    };
    fs.writeFileSync(envelopePath, JSON.stringify(envelope, null, 2));

    const code = await main(['prepare', '--input-envelope', envelopePath]);
    expect(code).toBe(1);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const report = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(report.execution_status).toBe('blocked');

    const receipt = fs.readFileSync(receiptPath, 'utf8');
    expect(receipt).toContain(`- working_directory: ${resolvePath(wtDir)}`);
    expect(receipt).toContain('- repository: owner/repo');
    expect(receipt).toContain('- delivery_target: owner/repo');
    expect(receipt).toContain('- base_remote: upstream');
    expect(receipt).toContain('- push_remote: origin');
    expect(receipt).toContain(`- worktree: ${resolvePath(wtDir)}`);
    expect(receipt).toContain('- baseBranch: main');
    expect(receipt).toContain('- branch: null');
    expect(receipt).toContain(`- commit: ${missingSha}`);
  });
});
