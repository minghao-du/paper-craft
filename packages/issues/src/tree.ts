import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueKey, readRef, type GitHubIssues, type Issue, type IssueRef } from './github.js';
import { declaredParent, tasklist } from './tasklist.js';

function index<T extends IssueRef>(items: T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = issueKey(item);
    if (result.has(key)) throw new Error('Duplicate issue identity: ' + key);
    result.set(key, item);
  }
  return result;
}

function inspect(github: GitHubIssues, ref: IssueRef) {
  const issue = github.issue(ref);
  const nativeParent = github.parent(issue);
  const bodyParent = declaredParent(issue.body, issue);
  const nativeChildren = index(github.children(issue));
  const entries = tasklist(issue.body, issue);
  const conflicts: string[] = [];
  if (nativeParent && bodyParent && issueKey(nativeParent) !== issueKey(bodyParent)) {
    conflicts.push('Native parent ' + issueKey(nativeParent) + ' conflicts with declared parent ' + issueKey(bodyParent));
  }
  const parentRef = nativeParent ?? bodyParent;
  const parent = parentRef && github.issue(parentRef);
  if (parent) {
    const listed = index(github.children(parent)).has(issueKey(issue));
    const entry = tasklist(parent.body, parent).has(issueKey(issue));
    if (listed !== Boolean(nativeParent)) conflicts.push('Native parent and child endpoints disagree for ' + issueKey(issue));
    if (!entry) conflicts.push('Parent tasklist is missing ' + issueKey(issue));
  }
  return { issue, nativeParent, bodyParent, parent, nativeChildren, entries, conflicts };
}

function childrenOf(node: ReturnType<typeof inspect>): IssueRef[] {
  const children = new Map<string, IssueRef>(node.nativeChildren);
  for (const [key, entry] of node.entries) children.set(key, entry.child);
  return [...children.values()];
}

export function inspectTree(github: GitHubIssues, ref: IssueRef) {
  const seen = new Set<string>();
  const result: {
    issue: Issue;
    nativeParent?: IssueRef;
    declaredParent?: IssueRef;
    nativeChildren: IssueRef[];
    tasklist: { child: IssueRef; checked: boolean }[];
    differences: string[];
    conflicts: string[];
  }[] = [];

  function visit(child: IssueRef, expectedParent?: IssueRef) {
    const key = issueKey(child);
    if (seen.has(key)) throw new Error('Issue appears more than once in the tree: ' + key);
    seen.add(key);
    const node = inspect(github, child);
    if (expectedParent && (!node.parent || issueKey(node.parent) !== issueKey(expectedParent))) {
      node.conflicts.push('Child ' + key + ' does not confirm parent ' + issueKey(expectedParent));
    }
    result.push({
      issue: node.issue, nativeParent: node.nativeParent && readRef(node.nativeParent), declaredParent: node.bodyParent,
      nativeChildren: [...node.nativeChildren.values()].map(readRef),
      tasklist: [...node.entries.values()].map(({ child, checked }) => ({ child, checked })),
      differences: [
        ...[...node.nativeChildren.keys()].filter((id) => !node.entries.has(id)).map((id) => 'Missing tasklist entry: ' + id),
        ...[...node.entries.keys()].filter((id) => !node.nativeChildren.has(id)).map((id) => 'Missing native child: ' + id),
      ],
      conflicts: node.conflicts,
    });
    for (const next of childrenOf(node)) visit(next, node.issue);
  }
  visit(ref);
  return { issues: result };
}

export class PartialIssueTree extends Error {
  constructor(message: string, readonly progress: unknown, cause: unknown) {
    super(message, { cause });
  }
}

function trackedError(error: unknown, progress: unknown): PartialIssueTree {
  return new PartialIssueTree(error instanceof Error ? error.message : String(error), progress, error);
}

function checkBody(github: GitHubIssues, issue: Issue, body: string): Issue {
  const latest = github.issue(issue);
  if (latest.body !== issue.body) throw new Error('Issue body changed before synchronization: ' + issue.url);
  if (latest.body === body) return latest;
  const directory = mkdtempSync(join(tmpdir(), 'paper-craft-issue-'));
  try {
    const file = join(directory, 'body.md');
    writeFileSync(file, body);
    github.edit(issue, file);
    const after = github.issue(issue);
    if (after.body !== body) throw new Error('Issue body did not match after synchronization: ' + issue.url);
    return after;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertLinked(github: GitHubIssues, parent: Issue, child: Issue): void {
  const confirmed = github.parent(github.issue(child));
  if (!confirmed || issueKey(confirmed) !== issueKey(parent) ||
    !index(github.children(parent)).has(issueKey(child))) {
    throw new Error('Native relationship did not verify: ' + issueKey(parent) + ' → ' + issueKey(child));
  }
}

function requireKnown(items: Iterable<string>, allowed: Map<string, IssueRef>, message: string): void {
  for (const key of items) {
    if (!allowed.has(key)) throw new Error(message + key);
  }
}

function planBody(node: ReturnType<typeof inspect>, children: Issue[], planned: Map<string, IssueRef>): string {
  const rows = children.filter((issue) => !node.entries.has(issueKey(issue))).map((issue) => {
    const ref = issue.repository === node.issue.repository ? '#' + issue.number : issue.url;
    return '- [ ] ' + ref + ' ' + issue.title.replace(/\s+/g, ' ');
  });
  const newline = node.issue.body.includes('\r\n') ? '\r\n' : '\n';
  const body = rows.length ? node.issue.body + (node.issue.body ? newline.repeat(2) : '') + rows.join(newline)
    : node.issue.body;
  const entries = tasklist(body, node.issue);
  if (entries.size !== planned.size || [...planned.keys()].some((key) => !entries.has(key))) {
    throw new Error('Cannot add the planned tasklist to the existing Markdown safely');
  }
  return body;
}

export function syncPlan(github: GitHubIssues, root: IssueRef, requested: IssueRef[]) {
  if (requested.length < 2 || requested.length > 5) throw new Error('Plan requires two to five direct children');
  const planned = index(requested);
  const progress = { root, planned: requested, verifiedLinks: [] as IssueRef[], tasklistVerified: false };
  try {
    const tree = inspect(github, root);
    if (tree.parent || tree.conflicts.length) throw new Error('Only a confirmed root issue can receive a plan');
    requireKnown(tree.nativeChildren.keys(), planned, 'Native child outside the authorized plan: ');
    requireKnown(tree.entries.keys(), planned, 'Tasklist child outside the authorized plan: ');
    const children = requested.map((ref) => {
      if (issueKey(ref) === issueKey(root)) throw new Error('Issue cannot be its own child');
      const node = inspect(github, ref);
      // A missing parent tasklist row is precisely the drift this plan is authorized to repair.
      if (node.conflicts.some((conflict) => conflict !== 'Parent tasklist is missing ' + issueKey(ref))) {
        throw new Error(node.conflicts.join('; '));
      }
      if (node.parent && issueKey(node.parent) !== issueKey(root)) {
        throw new Error('Existing parent conflicts with the plan for ' + issueKey(ref) + ': ' + issueKey(node.parent));
      }
      if (childrenOf(node).length) throw new Error('Plan would create nested children under ' + issueKey(ref));
      if (ref.repository.split('/').slice(0, 2).join('/') !== root.repository.split('/').slice(0, 2).join('/')) {
        throw new Error('Native child must have the same GitHub repository owner: ' + issueKey(ref));
      }
      return { issue: node.issue, linked: Boolean(node.nativeParent) };
    });
    planBody(tree, children.map(({ issue }) => issue), planned);
    for (const child of children) {
      if (!child.linked) {
        const latest = github.parent(github.issue(child.issue));
        if (latest && issueKey(latest) !== issueKey(root)) throw new Error('Child acquired a conflicting parent: ' + latest.url);
        if (!latest) github.attach(tree.issue, child.issue);
      }
      assertLinked(github, tree.issue, child.issue);
      progress.verifiedLinks.push(readRef(child.issue));
    }
    const refreshed = inspect(github, root);
    if (refreshed.parent || refreshed.conflicts.length) throw new Error('Root hierarchy changed during plan synchronization');
    requireKnown(refreshed.nativeChildren.keys(), planned, 'Native child outside the authorized plan: ');
    requireKnown(refreshed.entries.keys(), planned, 'Tasklist child outside the authorized plan: ');
    const body = planBody(refreshed, children.map(({ issue }) => github.issue(issue)), planned);
    const after = checkBody(github, refreshed.issue, body);
    const readback = inspectTree(github, root);
    if (readback.issues[0].issue.body !== after.body || readback.issues[0].nativeParent ||
      readback.issues[0].declaredParent || readback.issues.length !== planned.size + 1 ||
      readback.issues.slice(1).some((node) => !planned.has(issueKey(node.issue)) ||
        !node.nativeParent || issueKey(node.nativeParent) !== issueKey(root) || node.nativeChildren.length) ||
      readback.issues.some((node) => node.conflicts.length || node.differences.length)) {
      throw new Error('Plan relationships and tasklist did not converge');
    }
    progress.tasklistVerified = true;
    return { status: 'synchronized', ...progress };
  } catch (error) {
    throw trackedError(error, progress);
  }
}

export type Acceptance = IssueRef & { receipt: string; legacyParent?: IssueRef };

function orderedKeys(items: Iterable<IssueRef>): string {
  return [...items].map(issueKey).sort().join(',');
}

function sameRef(first: IssueRef | undefined, second: IssueRef | undefined): boolean {
  return (first && issueKey(first)) === (second && issueKey(second));
}

export function closeTree(github: GitHubIssues, root: IssueRef, accepted: Acceptance[]) {
  const evidence = index(accepted);
  const progress = { root, accepted, verifiedClosed: [] as (IssueRef & { state: 'closed'; reason: 'completed'; url: string; receipt: string })[], synchronized: [] as IssueRef[] };
  try {
    const tree = inspectTree(github, root).issues;
    for (const node of tree) {
      if (node.conflicts.length) throw new Error(node.conflicts.join('; '));
      const missingTasklist = node.nativeChildren.some((child) => !node.tasklist.some((row) => issueKey(row.child) === issueKey(child)));
      if (missingTasklist) throw new Error('Native child is missing from tasklist: ' + node.issue.url);
      const acceptedIssue = evidence.get(issueKey(node.issue));
      if (!acceptedIssue?.receipt.trim()) throw new Error('Passing acceptance evidence is required for ' + node.issue.url);
      const legacyParent = node.nativeParent ? undefined : node.declaredParent;
      if (!sameRef(legacyParent, acceptedIssue.legacyParent)) {
        throw new Error('Legacy parent must be reconciled explicitly for ' + node.issue.url);
      }
      if (node.issue.state === 'closed' && node.issue.reason !== 'completed') {
        throw new Error('Issue has a non-completed closure: ' + node.issue.url);
      }
    }
    if (evidence.size !== tree.length) throw new Error('Acceptance scope includes issues outside the reconciled tree');
    for (const node of tree.toReversed()) {
      const current = inspect(github, node.issue);
      if (!sameRef(current.nativeParent, node.nativeParent) || !sameRef(current.bodyParent, node.declaredParent) ||
        current.conflicts.length || orderedKeys(current.nativeChildren.values()) !== orderedKeys(node.nativeChildren) ||
        orderedKeys([...current.entries.values()].map((entry) => entry.child)) !==
          orderedKeys(node.tasklist.map((row) => row.child))) {
        throw new Error('Hierarchy changed during closure: ' + current.issue.url);
      }
      for (const child of childrenOf(current)) {
        const checked = current.entries.get(issueKey(child))?.checked;
        const actual = github.issue(child);
        if (!checked || actual.state !== 'closed' || actual.reason !== 'completed') {
          throw new Error('Child closure no longer verifies: ' + actual.url);
        }
      }
      if (current.issue.state === 'open') github.setState(current.issue, 'closed');
      const closed = github.issue(current.issue);
      if (closed.state !== 'closed' || closed.reason !== 'completed') {
        throw new Error('Completed state did not verify: ' + closed.url);
      }
      progress.verifiedClosed.push({ ...readRef(closed), state: closed.state, reason: closed.reason,
        url: closed.url, receipt: evidence.get(issueKey(closed))!.receipt });
      if (current.parent) {
        const parent = github.issue(current.parent);
        const entry = tasklist(parent.body, parent).get(issueKey(closed));
        if (!entry) throw new Error('Parent tasklist is missing ' + issueKey(closed));
        const at = entry.checkOffset;
        checkBody(github, parent, entry.checked ? parent.body : parent.body.slice(0, at) + 'x' + parent.body.slice(at + 1));
        progress.synchronized.push(readRef(closed));
      }
    }
    const final = inspectTree(github, root).issues;
    const expected = new Map(tree.map((node) => [issueKey(node.issue), node]));
    if (final.length !== tree.length || final.some((node) => {
      const prior = expected.get(issueKey(node.issue));
      return !prior || node.conflicts.length || node.issue.state !== 'closed' || node.issue.reason !== 'completed' ||
        !sameRef(node.nativeParent, prior.nativeParent) || !sameRef(node.declaredParent, prior.declaredParent) ||
        orderedKeys(node.nativeChildren) !== orderedKeys(prior.nativeChildren) ||
        orderedKeys(node.tasklist.map((row) => row.child)) !== orderedKeys(prior.tasklist.map((row) => row.child)) ||
        node.tasklist.some((row) => !row.checked);
    })) {
      throw new Error('Final tree readback did not confirm closure');
    }
    const parentRef = final[0].nativeParent ?? final[0].declaredParent;
    if (parentRef) {
      const parent = github.issue(parentRef);
      if (!tasklist(parent.body, parent).get(issueKey(root))?.checked) {
        throw new Error('Final parent tasklist readback did not confirm closure');
      }
    }
    return { status: 'closed', ...progress };
  } catch (error) {
    throw trackedError(error, progress);
  }
}

export function reopenIssue(github: GitHubIssues, ref: IssueRef) {
  const progress = { issue: ref, openVerified: false, parentTasklistVerified: false };
  try {
    const before = inspect(github, ref);
    if (before.conflicts.length) throw new Error(before.conflicts.join('; '));
    if (before.issue.state === 'closed') github.setState(ref, 'open');
    const opened = github.issue(ref);
    if (opened.state !== 'open') throw new Error('Open state did not verify: ' + opened.url);
    progress.openVerified = true;
    if (before.parent) {
      const parent = github.issue(before.parent);
      const entry = tasklist(parent.body, parent).get(issueKey(ref));
      if (!entry) throw new Error('Parent tasklist is missing ' + issueKey(ref));
      const at = entry.checkOffset;
      checkBody(github, parent, entry.checked ? parent.body.slice(0, at) + ' ' + parent.body.slice(at + 1) : parent.body);
      progress.parentTasklistVerified = true;
    }
    return { status: 'reopened', ...progress };
  } catch (error) {
    throw trackedError(error, progress);
  }
}
