import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestDir, PREPARE_WORKTREE_SCRIPT, runTypeScript } from '../../../tests/support/index.js';
import { git } from '../src/git.js';
import { verifyAssignedEnvironment } from '../src/index.js';

function createForkCheckout() {
  const fixture = createTestDir('pc-verify-test-');
  try {
    git(fixture.dir, 'init', '--initial-branch=main');
    git(fixture.dir, '-c', 'user.name=Workspace Test', '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial commit');
    git(fixture.dir, 'remote', 'add', 'origin', 'git@github.com:contributor/project.git');
    git(fixture.dir, 'remote', 'add', 'upstream', 'https://github.com/owner/project.git');
    return { ...fixture, commit: git(fixture.dir, 'rev-parse', 'HEAD') };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

it('verifies an explicitly assigned fork worktree under the caller’s cleanliness policy', () => {
  const { dir, commit, cleanup } = createForkCheckout();
  try {
    const checkout = path.join(dir, 'assigned-checkout');
    git(dir, 'worktree', 'add', '--detach', checkout, commit);
    const localNotes = path.join(checkout, 'local-notes.txt');
    fs.writeFileSync(localNotes, 'uncommitted notes');
    const args = [
      'verify', '--repo-dir', checkout, '--repository', 'owner/project',
      '--detached', '--commit', commit, '--cleanliness',
    ];
    const allowed = runTypeScript(PREPARE_WORKTREE_SCRIPT, [...args, 'allow-dirty'], { cwd: dir });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({
      working_directory: checkout, repository: 'owner/project', base_remote: 'upstream', branch: null, commit,
    });
    const blocked = runTypeScript(PREPARE_WORKTREE_SCRIPT, [...args, 'clean'], { cwd: dir });
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stderr)).toMatchObject({
      code: 'UNCLEAN_CHECKOUT',
      details: { directory: checkout, status: '?? local-notes.txt' },
    });
    expect(fs.readFileSync(localNotes, 'utf8')).toBe('uncommitted notes');
  } finally {
    cleanup();
  }
});

it('rejects a subdirectory, conflicting remote, branch, or revision before accepting an assignment', () => {
  const { dir, commit, cleanup } = createForkCheckout();
  try {
    const assignment = {
      workingDirectory: dir, repository: 'owner/project', branch: 'main', commit, requireClean: false,
    };
    const subdirectory = path.join(dir, 'docs');
    fs.mkdirSync(subdirectory);
    expect(() => verifyAssignedEnvironment({ ...assignment, workingDirectory: subdirectory }))
      .toThrow(expect.objectContaining({ details: { expected: subdirectory, observed: dir } }));
    expect(() => verifyAssignedEnvironment({ ...assignment, baseRemote: 'origin' }))
      .toThrow(expect.objectContaining({ code: 'REPOSITORY_NOT_FOUND' }));
    expect(() => verifyAssignedEnvironment({ ...assignment, branch: null }))
      .toThrow(expect.objectContaining({ details: { directory: dir, expected: null, observed: 'main' } }));
    expect(() => verifyAssignedEnvironment({ ...assignment, commit: '0'.repeat(commit.length) }))
      .toThrow(expect.objectContaining({ code: 'HEAD_MISMATCH' }));
    const configDirectory = path.join(dir, '.paper-craft');
    fs.mkdirSync(configDirectory);
    fs.writeFileSync(path.join(configDirectory, 'workspace-config.json'), JSON.stringify({
      base_remote: 'origin', delivery_target: 'contributor/project',
    }));
    expect(() => verifyAssignedEnvironment(assignment)).toThrow(expect.objectContaining({
      details: { directory: dir, expected: 'owner/project', observed: 'contributor/project', baseRemote: 'origin' },
    }));
  } finally {
    cleanup();
  }
});

it('resolves an unassigned dispatch revision from its envelope checkout', () => {
  const { dir, commit, cleanup } = createForkCheckout();
  try {
    const envelope = path.join(dir, 'assignment.json');
    fs.writeFileSync(envelope, JSON.stringify({
      schema_version: '1.0',
      task: { logical_stage: 'pr_review', root_issue_id: '1', current_issue_id: '1', step_index: 1, attempt: 1 },
      provider: { type: 'skill', target: 'pc-pr-review' },
      environment: { working_directory: dir, repository: 'owner/project', branch: null, commit: null },
      inputs: { objective: 'Review the assigned checkout' },
      contract: { receipt_path: path.join(dir, 'receipt.md') },
      budgets: {},
    }));
    const report = runTypeScript(PREPARE_WORKTREE_SCRIPT, [
      'verify', '--input-envelope', envelope, '--cleanliness', 'allow-dirty',
    ]);
    expect(report.status, report.stderr).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ working_directory: dir, branch: 'main', commit });
    expect(fs.existsSync(path.join(dir, 'receipt.md'))).toBe(false);
  } finally {
    cleanup();
  }
});
