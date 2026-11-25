import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { resolvePath, runGit } from '../src/git.js';

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

  it.each(['source', 'target'])('reports every dirty path in the %s checkout', async (checkout) => {
    const repoDir = path.join(tmp, 'repo');
    const sha = setupTempGitRepo(repoDir);
    const wtDir = path.join(tmp, 'verify-wt');
    const receiptPath = path.join(tmp, 'blocked.md');
    if (checkout === 'target') {
      const result = runGit(repoDir, 'worktree', 'add', '--detach', wtDir, sha);
      expect(result.code, result.stderr).toBe(0);
    }
    const dirtyDir = checkout === 'source' ? repoDir : wtDir;
    fs.appendFileSync(path.join(dirtyDir, 'README.md'), 'Unstaged edit\n');
    fs.writeFileSync(path.join(dirtyDir, 'staged.md'), 'Staged addition\n');
    const stage = runGit(dirtyDir, 'add', 'staged.md');
    expect(stage.code, stage.stderr).toBe(0);
    const untracked = ['draft 1.md', 'draft 2.md', 'draft 3.md', 'draft 4.md', 'draft 5.md'];
    for (const name of untracked) {
      fs.writeFileSync(path.join(dirtyDir, name), 'Untracked draft\n');
    }

    const code = await main([
      'prepare', '--repo-dir', repoDir, '--worktree', wtDir,
      '--commit', sha, '--receipt-path', receiptPath,
    ]);

    expect(code).toBe(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(report.execution_status).toBe('blocked');
    expect(report.result).toMatchObject({
      stage: 'workspace_prepare',
      code: 'UNCLEAN_CHECKOUT',
    });
    expect(report.result.details).toEqual({
      directory: resolvePath(dirtyDir),
      status: [' M README.md', 'A  staged.md', ...untracked.map((name) => `?? "${name}"`)].join('\n'),
    });

    const receipt = fs.readFileSync(receiptPath, 'utf8');
    const embeddedReport = receipt.match(/## Compact Report\n\n```json\n([\s\S]*?)\n```/);
    expect(embeddedReport).not.toBeNull();
    expect(JSON.parse(embeddedReport![1])).toEqual(report);
    for (const name of ['README.md', 'staged.md', ...untracked]) {
      expect(receipt.split(name)).toHaveLength(2);
    }
  });

  it('prepares a detached worktree and cleans it on the first pass while retaining candidates with ownership or consumer gaps', async () => {
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

    const candidate = {
      kind: 'detached',
      commit: sha,
      consumers_finished: true,
      verification_completed: true,
    };
    const ownership = { root_issue_id: 150, issue: 150, source: receiptPath };
    const preparedWorktree = resolvePath(wtDir);
    const missingEvidence = path.join(tmp, 'missing-ownership');
    const mismatchedRoot = path.join(tmp, 'wrong-root');
    const activeConsumers = path.join(tmp, 'active-consumers');
    for (const worktree of [missingEvidence, mismatchedRoot, activeConsumers]) {
      const result = runGit(repoDir, 'worktree', 'add', '--detach', worktree, sha);
      expect(result.code, result.stderr).toBe(0);
    }

    const cleanupInputPath = path.join(tmp, '06-input.json');
    const cleanupReceiptPath = path.join(tmp, '06-receipt.md');
    fs.writeFileSync(cleanupInputPath, JSON.stringify({
      ...envelope,
      task: { ...envelope.task, logical_stage: 'workspace_cleanup', step_index: 6 },
      environment: { working_directory: repoDir },
      inputs: {
        objective: 'Clean reconciled detached verification worktrees',
        parameters: {
          candidates: [
            { ...candidate, worktree: missingEvidence },
            {
              ...candidate,
              worktree: mismatchedRoot,
              ownership_evidence: { ...ownership, root_issue_id: 149 },
            },
            { ...candidate, worktree: preparedWorktree, ownership_evidence: ownership },
            {
              ...candidate,
              worktree: activeConsumers,
              ownership_evidence: { ...ownership, source: 'active-consumers-receipt.md' },
              consumers_finished: false,
            },
          ],
        },
      },
      contract: { receipt_path: cleanupReceiptPath },
    }));

    logSpy.mockClear();
    const cleanupCode = await main(['cleanup', '--input-envelope', cleanupInputPath]);
    expect(cleanupCode, errSpy.mock.calls.flat().join('\n')).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const cleanupReport = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(cleanupReport.execution_status).toBe('succeeded');
    expect(cleanupReport.result).toMatchObject({
      outcome: 'incomplete',
      removed_paths: [preparedWorktree],
      retained_paths: [
        {
          path: missingEvidence,
          reason: expect.stringMatching(/Detached worktree ownership_evidence is missing root_issue_id, issue, source/),
        },
        {
          path: mismatchedRoot,
          reason: expect.stringMatching(/root_issue_id 149.*cleanup root 150/),
        },
        {
          path: activeConsumers,
          reason: expect.stringMatching(/all worktree consumers.*consumers_finished/),
        },
      ],
      removed_branches: [],
      retained_branches: [],
    });
    expect(fs.existsSync(wtDir)).toBe(false);
    for (const worktree of [missingEvidence, mismatchedRoot, activeConsumers]) {
      expect(fs.existsSync(worktree)).toBe(true);
    }
    expect(fs.readFileSync(cleanupReceiptPath, 'utf8')).toContain('cleanup root 150');
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
