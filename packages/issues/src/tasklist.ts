import type { Heading } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { issueKey, issueNumber, refFromUrl, repositoryName, type IssueRef } from './github.js';

const markdown = unified().use(remarkParse).use(remarkGfm);

export interface Entry {
  child: IssueRef;
  checked: boolean;
  line: string;
  offset: number;
  checkOffset: number;
}

function leadingRef(text: string, repository: string): IssueRef | undefined {
  const url = /^(?:<|\[[^\]]+\]\()?((?:https:\/\/)[^\s)>]+)(?:[)>]|\s|$)/i.exec(text);
  if (url) {
    if (!/\/issues\//i.test(url[1])) return;
    return refFromUrl(url[1]);
  }
  const match = /^(?:([a-z\d_.-]+\/[a-z\d_.-]+)#|#)([1-9]\d*)(?=$|[\s.,;:!?)])/i.exec(text);
  if (!match) return;
  return {
    repository: match[1] ? repositoryName(repository.split('/')[0] + '/' + match[1]) : repository,
    number: issueNumber(match[2]),
  };
}

function headingText(heading: Heading): string {
  return heading.children.map((part) => part.type === 'text' ? part.value : '').join('');
}

export function tasklist(body: string, issue: IssueRef): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  let section: number | undefined;
  for (const block of markdown.parse(body).children) {
    if (block.type === 'heading') {
      if (section !== undefined && block.depth <= section) section = undefined;
      if (/^(?:child issues|sub[ -]?issues)$/i.test(headingText(block).trim())) section = block.depth;
    }
    if (block.type !== 'list') continue;
    for (const item of block.children) {
      if (item.checked == null || item.position?.start.offset === undefined) continue;
      const offset = item.position.start.offset;
      const line = body.slice(offset).split(/\r?\n/, 1)[0];
      const marker = /^([-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]+(.*)$/.exec(line);
      const child = marker && leadingRef(marker[3], issue.repository);
      if (!child || !marker) {
        if (section !== undefined) throw new Error('Ambiguous child tasklist entry on ' + issueKey(issue) + ': ' + line);
        continue;
      }
      const key = issueKey(child);
      if (entries.has(key)) throw new Error('Duplicate tasklist entry for ' + key + ' on ' + issueKey(issue));
      entries.set(key, { child, checked: item.checked, line, offset, checkOffset: offset + line.indexOf('[') + 1 });
    }
  }
  return entries;
}

export function declaredParent(body: string, issue: IssueRef): IssueRef | undefined {
  const parents: IssueRef[] = [];
  for (const block of markdown.parse(body).children) {
    if (block.type !== 'paragraph' || block.position?.start.offset === undefined) continue;
    const lines = body.slice(block.position.start.offset, block.position.end.offset).split(/\r?\n/);
    for (const line of lines) {
      const label = /^(?:(?:\*\*|__)?Parent(?: issue)?:(?:\*\*|__)?|(?:\*\*|__)Parent(?: issue)?(?:\*\*|__):)\s*(.*)$/i.exec(line);
      if (!label) continue;
      const parent = leadingRef(label[1], issue.repository);
      if (!parent) throw new Error('Unreadable explicit parent declaration on ' + issueKey(issue));
      parents.push(parent);
    }
  }
  if (new Set(parents.map(issueKey)).size > 1) throw new Error('Conflicting parent declarations on ' + issueKey(issue));
  return parents[0];
}

export function assertDraftPreservesTasklist(live: string, draft: string, issue: IssueRef): void {
  const current = tasklist(live, issue);
  const proposed = tasklist(draft, issue);
  const currentRows = [...current.values()].map((entry) => entry.line);
  const proposedRows = [...proposed.values()].map((entry) => entry.line);
  if (currentRows.length !== proposedRows.length || currentRows.some((line, index) => proposedRows[index] !== line)) {
    throw new Error('Draft changes the managed child tasklist on ' + issueKey(issue) + '. Reconcile hierarchy through issue-tree first.');
  }
}
