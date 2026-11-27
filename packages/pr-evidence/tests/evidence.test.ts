import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { landReviewed } from '../src/landing.js';
import { capture, readback, verify } from '../src/evidence.js';

const baseSha = 'a'.repeat(40);
const mergedSha = 'b'.repeat(40);

describe('GitHub pull request evidence', () => {
  let directory: string;
  let options: Parameters<typeof capture>[0];

  function mockGitHub({ headRepo = 'contributor/project', base = 'main', baseCommit = baseSha,
    merged = false, required = false, allReported = false, inaccessible = false, loseReadback = false } = {}) {
    const responses = {
      pr: {
        number: 12, html_url: 'https://github.com/project-owner/project/pull/12',
        draft: false, merged, state: merged ? 'closed' : 'open',
        merged_at: merged ? '2026-11-27T10:00:00Z' : null,
        merge_commit_sha: merged ? mergedSha : 'c'.repeat(40),
        base: { ref: base, repo: { full_name: 'project-owner/project' } },
        head: { ref: 'feature', repo: { full_name: headRepo }, sha: options.commit },
      },
      branch: { name: base, commit: { sha: baseCommit }, protected: false },
      rules: required ? [[{ type: 'required_status_checks', parameters: {
        required_status_checks: [{ context: 'build' }, { context: 'security' }],
      } }]] : [[]],
      status: { headRefOid: options.commit, mergeStateStatus: 'CLEAN' },
      checks: [
        { name: 'build', bucket: 'pass' },
        ...(allReported ? [{ name: 'security', bucket: 'pass' }] : []),
      ],
      inaccessible, loseReadback,
    };
    writeFileSync(path.join(directory, 'github.json'), JSON.stringify(responses));
  }

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'paper-craft-pr-evidence-'));
    const worktree = path.join(directory, 'checkout');
    const bin = path.join(directory, 'bin');
    mkdirSync(worktree);
    mkdirSync(bin);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf-8' }).trim();
    git('init', '-b', 'feature');
    git('-c', 'user.name=Test User', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-m', 'Feature');
    git('remote', 'add', 'origin', 'git@github.com:contributor/project.git');
    git('remote', 'add', 'upstream', 'https://github.com/project-owner/project.git');
    options = { workingDirectory: worktree, repository: 'project-owner/project', prNumber: 12,
      branch: 'feature', commit: git('rev-parse', 'HEAD'), baseBranch: 'main',
      headRepository: 'contributor/project', baseRemote: 'upstream' };
    writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fixture = require('../github.json');
const args = process.argv.slice(2);
const endpoint = args.at(-1);
let response;
if (args[0] === 'api' && args[2] === 'github.com') {
  if (endpoint === 'repos/project-owner/project/pulls/12') response = fixture.pr;
  if (endpoint === 'repos/project-owner/project/branches/' + fixture.branch.name) response = fixture.branch;
  if (endpoint === 'repos/project-owner/project/rules/branches/' + fixture.branch.name + '?per_page=100') {
    if (fixture.inaccessible) {
      console.error('gh: Resource not accessible (HTTP 403)');
      process.exit(1);
    }
    response = fixture.rules;
  }
} else if (args[0] === 'pr' && args[2] === '12' && args[4] === 'project-owner/project') {
  if (args[1] === 'checks' && args.includes('--required')) response = fixture.checks;
  if (args[1] === 'view') response = fixture.status;
  if (args[1] === 'merge') {
    const fs = require('node:fs');
    fs.appendFileSync(require('node:path').join(__dirname, '../merges'), 'attempt\\n');
    const expected = ['pr', 'merge', '12', '--repo', 'project-owner/project', '--squash',
      '--match-head-commit', fixture.pr.head.sha, '--body', 'Refs #42'];
    if (JSON.stringify(args) !== JSON.stringify(expected) || fixture.pr.merged) process.exit(2);
    fixture.pr = { ...fixture.pr, merged: true, state: 'closed',
      merged_at: '2026-11-27T10:00:00Z', merge_commit_sha: 'b'.repeat(40) };
    fs.writeFileSync(require.resolve('../github.json'), fixture.loseReadback ? '' : JSON.stringify(fixture));
    console.error('merge response lost');
    process.exit(1);
  }
}
if (response === undefined) throw Error('Unexpected gh invocation: ' + JSON.stringify(args));
console.log(JSON.stringify(response));
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('binds fork identity to the review while allowing the reviewed base branch to advance', () => {
    mockGitHub();
    const reviewed = capture(options);
    mockGitHub({ baseCommit: 'd'.repeat(40) });
    expect(verify(options, reviewed)).toMatchObject({
      headRepository: 'contributor/project', baseBranch: 'main', requiredChecks: 'none_configured',
    });

    mockGitHub({ headRepo: 'another-fork/project' });
    expect(() => verify({ ...options, headRepository: undefined }, reviewed)).toThrow(
      'headRepository mismatch: expected contributor/project, observed another-fork/project',
    );
    mockGitHub({ base: 'release' });
    expect(() => verify({ ...options, baseBranch: undefined }, reviewed)).toThrow(
      'baseBranch mismatch: expected main, observed release',
    );
  });

  it('requires all configured checks to report regardless of the checkout workflow files', () => {
    mockGitHub({ required: true, allReported: true });
    const reviewed = capture(options);
    expect(verify(options, reviewed)).toMatchObject({ requiredChecks: 'passed', checks: ['build', 'security'] });
    mockGitHub({ required: true });
    expect(() => verify(options, reviewed)).toThrow('Required checks have not reported: security');
    mockGitHub({ inaccessible: true });
    expect(() => verify(options, reviewed)).toThrow('Resource not accessible');
  });

  it('settles a guarded merge from remote readback after losing the command response', () => {
    mockGitHub();
    const reviewed = capture(options);
    expect(landReviewed(options, reviewed, '42')).toMatchObject({ outcome: 'landed', mergedCommit: mergedSha });
    expect(landReviewed(options, reviewed, '42')).toMatchObject({ outcome: 'landed', mergedCommit: mergedSha });
    expect(readFileSync(path.join(directory, 'merges'), 'utf8')).toBe('attempt\n');
    mockGitHub({ loseReadback: true });
    expect(landReviewed(options, reviewed, '42')).toMatchObject({ outcome: 'blocked', mergeState: 'unknown' });
  });

  it('reconciles an interrupted merge using the remote state and retained reviewed identity', () => {
    mockGitHub();
    const reviewed = capture(options);
    expect(readback(options, reviewed)).toMatchObject({ state: 'open', merged: false });
    mockGitHub({ merged: true });
    expect(readback(options, reviewed)).toMatchObject({ state: 'merged', merged: true, mergedCommit: mergedSha });
    mockGitHub({ merged: true, headRepo: 'another-fork/project' });
    expect(() => readback({ ...options, headRepository: undefined }, reviewed)).toThrow('headRepository mismatch');
  });
});
