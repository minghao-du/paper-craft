import { spawnSync } from 'node:child_process';
import { getRemoteUrl, isValidCommitSha } from '../../workspace/src/git.js';
import { verifyAssignedEnvironment } from '../../workspace/src/index.js';

type Fields = Record<string, unknown>;

export interface PullRequestIdentity {
  repository: string;
  prNumber: number;
  baseBranch: string;
  branch: string;
  headRepository: string;
  commit: string;
}

interface PullRequest {
  identity: PullRequestIdentity;
  prUrl: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  mergedAt: unknown;
  mergedCommit: unknown;
}

interface CaptureOptions {
  workingDirectory: string;
  repository: string;
  prNumber: number;
  baseBranch?: string;
  branch?: string;
  headRepository?: string;
  commit?: string;
  baseRemote?: string;
}

function fields(value: unknown, label: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Missing or invalid ${label}`);
  }
  return value as Fields;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing or invalid ${label}`);
  return value;
}

function sha(value: unknown, label: string): string {
  const result = string(value, label);
  if (!isValidCommitSha(result)) throw new Error(`Invalid ${label}: ${result}`);
  return result.toLowerCase();
}

function repo(value: unknown): string {
  const name = string(value, 'repository').toLowerCase().replace(/^github\.com\//, '');
  if (!/^(?:[a-z0-9.-]+\/)?[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name)) {
    throw new Error(`Invalid repository: ${name}`);
  }
  return name;
}

function repoCoordinates(repository: string): { host: string; name: string } {
  const [prefix, owner, name] = repository.split('/');
  return name === undefined
    ? { host: 'github.com', name: repository }
    : { host: prefix, name: `${owner}/${name}` };
}

function onHost(host: string, name: unknown): string {
  return repo(`${host}/${string(name, 'remote repository')}`);
}

function gh(cwd: string, ...args: string[]): unknown {
  const result = spawnSync('gh', args, {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(`GitHub evidence unavailable (${args.slice(0, 2).join(' ')}): ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`GitHub evidence unavailable: invalid JSON from gh ${args.slice(0, 2).join(' ')}`);
  }
}

function api(cwd: string, repository: string, endpoint: string, ...flags: string[]): unknown {
  const { host, name } = repoCoordinates(repository);
  return gh(cwd, 'api', '--hostname', host, ...flags, `repos/${name}/${endpoint}`);
}

function pullRequest(cwd: string, repository: string, number: number): PullRequest {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Expected a positive PR number');
  const data = fields(api(cwd, repository, `pulls/${number}`), 'pull request');
  if (data.number !== number || !['open', 'closed'].includes(String(data.state))
      || typeof data.merged !== 'boolean' || typeof data.draft !== 'boolean'
      || (data.merged && data.state !== 'closed')) {
    throw new Error(`Missing or inconsistent state for PR #${number}`);
  }
  const head = fields(data.head, 'PR head');
  const base = fields(data.base, 'PR base');
  const { host } = repoCoordinates(repository);
  const observedRepo = onHost(host, fields(base.repo, 'PR base repository').full_name);
  if (observedRepo !== repository) {
    throw new Error(`PR repository mismatch: expected ${repository}, observed ${observedRepo}`);
  }
  const prUrl = string(data.html_url, 'PR URL');
  const expectedUrl = `https://${host}/${repoCoordinates(repository).name}/pull/${number}`;
  if (prUrl.toLowerCase() !== expectedUrl) {
    throw new Error(`PR URL mismatch: expected ${expectedUrl}, observed ${prUrl}`);
  }
  return {
    identity: {
      repository, prNumber: number,
      baseBranch: string(base.ref, 'PR base branch'),
      branch: string(head.ref, 'PR head branch'),
      headRepository: onHost(host, fields(head.repo, 'PR head repository').full_name),
      commit: sha(head.sha, 'PR head SHA'),
    },
    prUrl,
    state: data.merged ? 'merged' : data.state as 'open' | 'closed',
    draft: data.draft,
    mergedAt: data.merged_at,
    mergedCommit: data.merge_commit_sha,
  };
}

function matchIdentity(actual: PullRequestIdentity, expected: Partial<PullRequestIdentity>): void {
  const keys = ['repository', 'prNumber', 'baseBranch', 'branch', 'headRepository', 'commit'] as const;
  for (const key of keys) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) {
      throw new Error(`PR ${key} mismatch: expected ${expected[key]}, observed ${actual[key]}`);
    }
  }
}

function baseBranch(cwd: string, identity: PullRequestIdentity): Fields {
  const value = fields(api(cwd, identity.repository, `branches/${encodeURIComponent(identity.baseBranch)}`),
    'base branch');
  if (value.name !== identity.baseBranch) throw new Error('GitHub returned a different base branch');
  return value;
}

function branchCommit(base: Fields): string {
  return sha(fields(base.commit, 'base branch commit').sha, 'base branch SHA');
}

function configuredContexts(base: Fields): string[] {
  if (base.protected === false) return [];
  if (base.protected !== true) throw new Error('Missing GitHub branch protection state');
  const protection = fields(base.protection, 'branch protection configuration');
  const checks = fields(protection.required_status_checks, 'required status check configuration');
  if (!Array.isArray(checks.contexts) || !['off', 'non_admins', 'everyone'].includes(String(checks.enforcement_level))) {
    throw new Error('GitHub branch protection check configuration unavailable');
  }
  const contexts = checks.contexts.map((context) => string(context, 'required status check name'));
  if (!contexts.length && checks.enforcement_level !== 'off') {
    throw new Error('GitHub branch protection requires checks with no reported configuration');
  }
  return contexts;
}

function requiredChecks(cwd: string, identity: PullRequestIdentity, base: Fields): string[] {
  const { repository, prNumber } = identity;
  const pages = api(cwd, repository, `rules/branches/${encodeURIComponent(identity.baseBranch)}?per_page=100`,
    '--paginate', '--slurp');
  if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) {
    throw new Error('GitHub branch rules unavailable');
  }
  const contexts = new Set(configuredContexts(base));
  for (const entry of pages.flat()) {
    const rule = fields(entry, 'branch rule');
    const type = string(rule.type, 'branch rule type');
    if (type === 'workflows') {
      throw new Error('GitHub requires workflows whose individual status could not be verified');
    }
    if (type !== 'required_status_checks') continue;
    const checks = fields(rule.parameters, 'status check rule parameters').required_status_checks;
    if (!Array.isArray(checks) || !checks.length) throw new Error('GitHub status check rule is incomplete');
    for (const check of checks) {
      contexts.add(string(fields(check, 'required status check').context, 'required status check name'));
    }
  }
  if (!contexts.size) return [];
  const results = gh(cwd, 'pr', 'checks', String(prNumber), '--repo', repository,
    '--required', '--json', 'name,bucket');
  if (!Array.isArray(results) || !results.length) throw new Error('Required checks have not reported');
  const passed = new Set<string>();
  for (const entry of results) {
    const check = fields(entry, 'required check result');
    const name = string(check.name, 'required check name');
    if (check.bucket !== 'pass' && check.bucket !== 'skipping') {
      throw new Error(`Required check ${name} is ${String(check.bucket)}`);
    }
    passed.add(name);
  }
  const missing = [...contexts].filter((name) => !passed.has(name));
  if (missing.length) throw new Error(`Required checks have not reported: ${missing.join(', ')}`);
  return [...passed].sort();
}

function verifyLocal(options: CaptureOptions, readback: boolean) {
  const repository = repo(options.repository);
  const { host, name } = repoCoordinates(repository);
  const local = verifyAssignedEnvironment({
    workingDirectory: options.workingDirectory, repository: name, baseRemote: options.baseRemote,
    branch: readback ? undefined : options.branch, commit: readback ? undefined : options.commit,
    requireClean: !readback,
  });
  const url = getRemoteUrl(local.workingDirectory, local.baseRemote);
  const remoteHost = url.includes('://') ? new URL(url).hostname : /^(?:[^@]+@)?([^/:]+):/.exec(url)?.[1];
  if (remoteHost?.toLowerCase() !== host) {
    throw new Error(`Base remote host mismatch: expected ${host}, observed ${remoteHost ?? '(unavailable)'}`);
  }
  return { ...local, repository };
}

function captureCurrent(options: CaptureOptions) {
  const local = verifyLocal(options, false);
  const pr = pullRequest(local.workingDirectory, local.repository, options.prNumber);
  matchIdentity(pr.identity, {
    baseBranch: options.baseBranch,
    branch: options.branch ?? local.branch ?? undefined,
    headRepository: options.headRepository === undefined ? undefined : repo(options.headRepository),
    commit: local.commit,
  });
  if (pr.state !== 'open') throw new Error(`PR #${options.prNumber} is ${pr.state}`);
  const base = baseBranch(local.workingDirectory, pr.identity);
  return { current: { ...pr.identity, prUrl: pr.prUrl, baseCommit: branchCommit(base) },
    base, draft: pr.draft };
}

export function capture(options: CaptureOptions) {
  return captureCurrent(options).current;
}

export function reviewedIdentity(value: unknown) {
  const data = fields(value, 'review evidence');
  if (!Number.isSafeInteger(data.prNumber) || Number(data.prNumber) < 1) throw new Error('Invalid reviewed PR number');
  return {
    repository: repo(data.repository), prNumber: Number(data.prNumber),
    baseBranch: string(data.baseBranch, 'reviewed base branch'),
    branch: string(data.branch, 'reviewed head branch'),
    headRepository: repo(data.headRepository), commit: sha(data.commit, 'reviewed head SHA'),
    baseCommit: sha(data.baseCommit, 'reviewed base SHA'),
  };
}

export function verify(options: CaptureOptions, reviewed: ReturnType<typeof reviewedIdentity>) {
  const { current, base, draft } = captureCurrent(options);
  if (draft) throw new Error(`PR #${options.prNumber} is a draft`);
  matchIdentity(current, reviewed);
  const cwd = options.workingDirectory;
  const checks = requiredChecks(cwd, reviewed, base);
  const merge = fields(gh(cwd, 'pr', 'view', String(reviewed.prNumber), '--repo', reviewed.repository,
    '--json', 'headRefOid,mergeStateStatus'), 'PR merge state');
  if (merge.headRefOid !== reviewed.commit || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(String(merge.mergeStateStatus))) {
    throw new Error(`GitHub merge state: ${String(merge.mergeStateStatus)} at ${String(merge.headRefOid)}`);
  }
  const { current: latest, draft: latestDraft } = captureCurrent(options);
  if (latestDraft) throw new Error(`PR #${reviewed.prNumber} is a draft`);
  matchIdentity(latest, reviewed);
  return { ...latest, requiredChecks: checks.length ? 'passed' : 'none_configured', checks };
}

export function readback(options: CaptureOptions, reviewed?: ReturnType<typeof reviewedIdentity>) {
  const local = verifyLocal(options, true);
  const pr = pullRequest(local.workingDirectory, local.repository, options.prNumber);
  matchIdentity(pr.identity, {
    baseBranch: options.baseBranch, branch: options.branch,
    commit: options.commit === undefined ? undefined : sha(options.commit, 'expected head SHA'),
    headRepository: options.headRepository === undefined ? undefined : repo(options.headRepository),
  });
  if (reviewed) matchIdentity(pr.identity, reviewed);
  if (pr.state !== 'merged') return { ...pr.identity, prUrl: pr.prUrl, state: pr.state, merged: false };
  return { ...pr.identity, prUrl: pr.prUrl, state: pr.state, merged: true,
    mergedCommit: sha(pr.mergedCommit, 'merge commit'), mergedAt: string(pr.mergedAt, 'merge timestamp') };
}
