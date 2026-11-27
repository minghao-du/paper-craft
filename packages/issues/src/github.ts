import { execFileSync } from 'node:child_process';

export interface IssueRef {
  repository: string;
  number: number;
}

export interface Issue extends IssueRef {
  id: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  reason: string | null;
}

export type RunGh = (args: string[]) => string;

export function ghAt(worktree: string): RunGh {
  return (args) => execFileSync('gh', args, {
    cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
}

export function repositoryName(value: string): string {
  const qualified = value.split('/').length === 2 ? 'github.com/' + value : value;
  if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?\/[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(qualified)
    || /\/(?:\.|\.\.)$/.test(qualified)) {
    throw new Error('Expected [HOST/]OWNER/REPO');
  }
  return qualified.toLowerCase();
}

export function refFromUrl(url: string): IssueRef {
  const match = /^https:\/\/([^/]+\/[^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/i.exec(url);
  if (!match) throw new Error('Expected a GitHub issue URL: ' + url);
  return { repository: repositoryName(match[1]), number: issueNumber(match[2]) };
}

export function issueNumber(value: string): number {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error('Expected a positive issue number: ' + value);
  }
  return number;
}

export function issueKey(ref: IssueRef): string {
  return ref.repository + '#' + ref.number;
}

export function readRef(value: unknown): IssueRef {
  if (!value || typeof value !== 'object' || !('repository' in value) || typeof value.repository !== 'string'
    || !('number' in value) || typeof value.number !== 'number') {
    throw new Error('Expected repository and numeric issue number');
  }
  return { repository: repositoryName(value.repository), number: issueNumber(String(value.number)) };
}

function parseIssue(value: unknown, host: string): Issue {
  if (!value || typeof value !== 'object' || 'pull_request' in value ||
    !('html_url' in value) || typeof value.html_url !== 'string' ||
    !('id' in value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0 ||
    !('title' in value) || typeof value.title !== 'string' ||
    !('body' in value) || (value.body !== null && typeof value.body !== 'string') ||
    !('state' in value) || (value.state !== 'open' && value.state !== 'closed') ||
    !('state_reason' in value) || (value.state_reason !== null && typeof value.state_reason !== 'string')) {
    throw new Error('Unrecognized GitHub issue response');
  }
  const ref = refFromUrl(value.html_url);
  if (!ref.repository.startsWith(host + '/') || !('number' in value) || value.number !== ref.number) {
    throw new Error('GitHub issue response has conflicting identity: ' + value.html_url);
  }
  return { ...ref, id: value.id, url: value.html_url, title: value.title, body: value.body ?? '',
    state: value.state, reason: value.state_reason };
}

function split(ref: IssueRef): [string, string] {
  const [host, owner, repo] = ref.repository.split('/');
  return [host, 'repos/' + owner + '/' + repo + '/issues/' + ref.number];
}

function ghStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') return;
  const status = /^gh: .+ \(HTTP (\d{3})\)$/m.exec(error.stderr);
  return status ? Number(status[1]) : undefined;
}

export class GitHubIssues {
  constructor(readonly run: RunGh) {}

  private api(ref: IssueRef, suffix: string, ...args: string[]): unknown {
    const [host, endpoint] = split(ref);
    return JSON.parse(this.run(['api', '--hostname', host, endpoint + suffix, ...args]));
  }

  issue(ref: IssueRef): Issue {
    const issue = parseIssue(this.api(ref, ''), split(ref)[0]);
    if (issueKey(issue) !== issueKey(ref)) throw new Error('Unexpected issue identity: ' + issue.url);
    return issue;
  }

  parent(issue: Issue): Issue | undefined {
    try {
      return parseIssue(this.api(issue, '/parent'), split(issue)[0]);
    } catch (error) {
      if (ghStatus(error) === 404) return;
      throw error;
    }
  }

  children(ref: IssueRef): Issue[] {
    const pages = this.api(ref, '/sub_issues?per_page=100', '--paginate', '--slurp');
    if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) {
      throw new Error('Unrecognized GitHub sub-issue pages for ' + issueKey(ref));
    }
    return pages.flat().map((raw) => parseIssue(raw, split(ref)[0]));
  }

  attach(parent: IssueRef, child: Issue): void {
    this.api(parent, '/sub_issues', '--method', 'POST', '-F', 'replace_parent=false', '-F', 'sub_issue_id=' + child.id);
  }

  edit(ref: IssueRef, file: string): void {
    this.run(['issue', 'edit', String(ref.number), '--repo', ref.repository, '--body-file', file]);
  }

  setState(ref: IssueRef, state: 'open' | 'closed'): void {
    this.run(['issue', state === 'closed' ? 'close' : 'reopen', String(ref.number),
      '--repo', ref.repository, ...(state === 'closed' ? ['--reason', 'completed'] : [])]);
  }
}
