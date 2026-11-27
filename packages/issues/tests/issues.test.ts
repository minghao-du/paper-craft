import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubIssues, issueKey, type IssueRef } from '../src/github.js';
import { publishIssue } from '../src/publish.js';
import { closeTree, inspectTree, syncPlan } from '../src/tree.js';

function ref(number: number, repository = 'github.com/lab/study'): IssueRef {
  return { repository, number };
}

type RemoteIssue = ReturnType<typeof rawIssue>;

function rawIssue(issue: IssueRef, body: string, title = 'Issue ' + issue.number, closed = false) {
  return {
    html_url: 'https://' + issue.repository + '/issues/' + issue.number, number: issue.number,
    id: issue.number + (issue.repository.endsWith('/study') ? 1000 : 2000), body, title,
    state: closed ? 'closed' : 'open', state_reason: closed ? 'completed' : null as string | null,
  };
}

const scratch: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'paper-craft-issue-test-'));
  scratch.push(path);
  return path;
}
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tracker() {
  const issues = new Map<string, RemoteIssue>();
  const links = new Map<string, string>();
  const calls: string[][] = [];
  const effects: string[] = [];
  const errors = { create: false, link: '' };
  const onCreate = { callback: () => {} };
  function add(issue: IssueRef, body: string, title?: string, closed?: boolean) {
    const item = rawIssue(issue, body, title, closed);
    issues.set(issueKey(issue), item);
    return item;
  }
  const github = new GitHubIssues((args) => {
    calls.push(args);
    if (args[0] === 'api') {
      const [, owner, repo, number, suffix] = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(.*)$/.exec(args[3])!;
      const key = issueKey(ref(Number(number), args[2] + '/' + owner + '/' + repo));
      const item = issues.get(key);
      if (suffix === '/parent') {
        const parent = links.get(key);
        if (!parent) throw Object.assign(new Error('Not Found'), { stderr: 'gh: Not Found (HTTP 404)' });
        return JSON.stringify(issues.get(parent));
      }
      if (suffix.startsWith('/sub_issues')) {
        if (args.includes('POST')) {
          const child = [...issues].find(([, value]) => value.id === Number(args.at(-1)?.split('=')[1]))![0];
          links.set(child, key);
          effects.push('link ' + child);
          if (errors.link === child) throw new Error('Link response lost');
          return JSON.stringify(item);
        }
        const children = [...links].filter(([, parent]) => parent === key).map(([child]) => [issues.get(child)]);
        return JSON.stringify(children.length ? children : [[]]);
      }
      if (!item) throw new Error('Unknown issue ' + key);
      return JSON.stringify(item);
    }
    const repo = args[args.indexOf('--repo') + 1];
    if (args[1] === 'create') {
      const body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
      const title = args[args.indexOf('--title') + 1];
      const item = add(ref(73 + effects.filter((effect) => effect.startsWith('create')).length, repo), body, title);
      effects.push('create ' + item.html_url);
      onCreate.callback();
      if (errors.create) throw new Error('Create response lost');
      return item.html_url + '\n';
    }
    const key = issueKey(ref(Number(args[2]), repo));
    const item = issues.get(key)!;
    effects.push(args[1] + ' ' + key);
    if (args[1] === 'edit') item.body = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
    if (args[1] === 'close') {
      item.state = 'closed';
      item.state_reason = args[args.indexOf('--reason') + 1];
    }
    if (args[1] === 'reopen') {
      item.state = 'open';
      item.state_reason = null;
    }
    return '';
  });
  return { github, effects, calls, links, add, errors, onCreate };
}

describe('Issue publication', () => {
  it('recovers a verified create after an archive collision without overwriting or creating a duplicate', () => {
    const trackerState = tracker();
    const worktree = directory();
    const draft = join(directory(), 'ISSUE-worker.md');
    const body = '# Worker scope\r\n\r\nExact markdown $HOME.\r\n';
    writeFileSync(draft, body);
    const archive = join(worktree, '_ignore', 'ISSUE-worker.md');
    trackerState.onCreate.callback = () => writeFileSync(archive, 'unrelated file');
    const inputs = { worktree, draft, repository: ref(1).repository };

    expect(() => publishIssue(trackerState.github, { ...inputs, mode: 'create', assignee: 'scientist' }))
      .toThrow(/archive destination is occupied/i);
    expect(readFileSync(draft, 'utf8')).toBe(body);
    expect(readFileSync(archive, 'utf8')).toBe('unrelated file');
    expect(trackerState.calls[0]).toEqual([
      'issue', 'create', '--repo', inputs.repository, '--title', 'Worker scope',
      '--body-file', expect.stringContaining('ISSUE-worker.md'), '--assignee', 'scientist',
    ]);

    rmSync(archive);
    expect(() => publishIssue(trackerState.github, { ...inputs, mode: 'create' })).toThrow(/already attempted/);
    expect(publishIssue(trackerState.github, { ...inputs, mode: 'resume' })).toMatchObject({ status: 'created', number: 73 });
    expect(existsSync(draft)).toBe(false);
    expect(readFileSync(archive, 'utf8')).toBe(body);
    expect(trackerState.effects).toHaveLength(1);
    writeFileSync(draft, body);
    expect(publishIssue(trackerState.github, { ...inputs, mode: 'resume' })).toMatchObject({ number: 73 });
    expect(readFileSync(draft, 'utf8')).toBe(body);

    rmSync(archive);
    trackerState.onCreate.callback = () => {};
    trackerState.errors.create = true;
    expect(() => publishIssue(trackerState.github, { ...inputs, mode: 'create' })).toThrow(/unresolved/);
    const historical = { ...inputs, mode: 'resume' as const, url: 'https://github.com/lab/study/issues/73' };
    expect(() => publishIssue(trackerState.github, historical)).toThrow(/ENOENT/);
    expect(readFileSync(draft, 'utf8')).toBe(body);
    expect(publishIssue(trackerState.github, { ...historical, url: 'https://github.com/lab/study/issues/74' }))
      .toMatchObject({ number: 74 });
  });

  it('does not bind an unresolved create to a mismatched candidate and uses filename fallback', () => {
    const { github, add, effects, errors } = tracker();
    const worktree = directory();
    const draft = join(worktree, 'fallback.md');
    const inputs = { worktree, draft, repository: ref(1).repository };
    writeFileSync(draft, 'Body without H1\n');
    add(ref(99), 'Different draft', 'fallback');
    errors.create = true;

    expect(() => publishIssue(github, { ...inputs, mode: 'create' })).toThrow(/unresolved/);
    expect(() => publishIssue(github, { ...inputs, mode: 'resume', url: 'https://github.com/lab/study/issues/99' }))
      .toThrow(/does not match/);
    expect(publishIssue(github, { ...inputs, mode: 'resume', url: 'https://github.com/lab/study/issues/73' }))
      .toMatchObject({ number: 73 });
    expect(effects).toHaveLength(1);
  });

  it('rejects stale managed checklist rows and accepts exact drafts changing unrelated checkboxes', () => {
    const { github, add, effects } = tracker();
    const worktree = directory();
    const draft = join(worktree, 'edit.md');
    const root = ref(1);
    const live = add(root, 'Notes\n\n- [x] #2 Child\n- [ ] Run the benchmark\n');
    const inputs = { worktree, draft, ...root, mode: 'update' as const };
    writeFileSync(draft, '# Revised\n\n- [ ] #2 Child\n- [x] Run the benchmark\n');

    expect(() => publishIssue(github, inputs)).toThrow(/managed child tasklist/);
    expect(effects).toEqual([]);
    const valid = '# Revised\n\n- [x] #2 Child\n- [x] Run the benchmark\n';
    writeFileSync(draft, valid);
    expect(publishIssue(github, inputs)).toMatchObject({ status: 'updated' });
    expect(live.body).toBe(valid);
    expect(existsSync(draft)).toBe(true);
  });
});

describe('Issue tree reconciliation', () => {
  it('reconciles paginated native children after an uncertain link, preserving qualified rows and earlier progress', () => {
    const { github, add, links, calls, effects, errors } = tracker();
    const root = ref(1);
    const child = ref(2);
    const other = ref(2, 'github.com/lab/data');
    const parent = add(root, 'Unrelated #12\n\n- [x] #2 Done\n\nDo not change.\n');
    add(child, 'Parent: #1', 'Done', true);
    add(other, '', 'Data');
    links.set(issueKey(child), issueKey(root));
    errors.link = issueKey(other);
    const originalBody = parent.body;

    expect(() => syncPlan(github, root, [child, other])).toThrow(/Link response lost/);
    expect(parent.body).toBe(originalBody);
    const result = syncPlan(github, root, [child, other]);
    expect(result).toMatchObject({ status: 'synchronized', verifiedLinks: [child, other], tasklistVerified: true });
    expect(parent.body).toBe(originalBody + '\n\n- [ ] https://github.com/lab/data/issues/2 Data');
    expect(effects.filter((effect) => effect.startsWith('link'))).toHaveLength(1);
    expect(calls.some((args) => args.includes('--paginate') && args.includes('--slurp'))).toBe(true);
  });

  it('makes the verifier explicitly reconcile matching legacy declarations with a missing native edge', () => {
    const { github, add, effects } = tracker();
    const root = ref(1);
    const child = ref(2);
    const parent = add(root, '- [ ] #2 Legacy child');
    add(child, 'Parent: #1');
    const acceptance = [{ ...root, receipt: 'accept/1' }, { ...child, receipt: 'accept/2' }];

    expect(inspectTree(github, root).issues[0].differences).toEqual(['Missing native child: ' + issueKey(child)]);
    expect(() => closeTree(github, root, acceptance)).toThrow(/Legacy parent must be reconciled explicitly/);
    expect(effects).toEqual([]);
    expect(closeTree(github, root, [acceptance[0], { ...acceptance[1], legacyParent: root }]))
      .toMatchObject({ status: 'closed' });
    expect(parent.body).toBe('- [x] #2 Legacy child');
  });

  it('requires acceptance for closed descendants and checks off only the assigned subtree', () => {
    const { github, add, links, effects } = tracker();
    const parent = ref(1);
    const child = ref(2);
    const grandchild = ref(3);
    const unrelated = ref(4);
    const top = add(parent, '- [ ] #2 Child\n- [ ] #4 Unrelated');
    const middle = add(child, '- [ ] #3 Grandchild');
    add(grandchild, '', 'Grandchild', true);
    add(unrelated, '');
    links.set(issueKey(child), issueKey(parent));
    links.set(issueKey(grandchild), issueKey(child));
    links.set(issueKey(unrelated), issueKey(parent));
    expect(inspectTree(github, child).issues.map((node) => node.issue.number)).toEqual([2, 3]);

    expect(() => closeTree(github, child, [{ ...child, receipt: 'accept/2' }])).toThrow(/acceptance evidence/);
    expect(effects).toEqual([]);
    const result = closeTree(github, child, [{ ...child, receipt: 'accept/2' }, { ...grandchild, receipt: 'accept/3' }]);
    expect(result.verifiedClosed.map((item) => item.number)).toEqual([3, 2]);
    expect(effects.filter((effect) => effect.startsWith('close'))).toEqual(['close ' + issueKey(child)]);
    expect(top.body).toBe('- [x] #2 Child\n- [ ] #4 Unrelated');
    expect(middle.body).toBe('- [x] #3 Grandchild');
  });
});
