#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { ghAt, GitHubIssues, issueNumber, readRef, repositoryName } from './github.js';
import { PartialIssuePublication, publishIssue } from './publish.js';
import { closeTree, inspectTree, PartialIssueTree, reopenIssue, syncPlan } from './tree.js';

const usage = [
  'Usage: <create|update|resume|inspect|plan|close|reopen> --worktree <absolute path> --repository <[HOST/]OWNER/REPO>',
  '  create --draft <path> [--assignee <login>]',
  '  update --draft <path> --issue <number>',
  '  resume --draft <original path> [--url <verified issue URL>]',
  '  inspect --issue <number>',
  '  plan --issue <number> --input <absolute JSON path to array of child issue identities>',
  '  close --issue <number> --input <absolute JSON path to array of accepted issue identities and receipts>',
  '  reopen --issue <number>',
].join('\n');

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, worktree: { type: 'string' }, repository: { type: 'string' },
      draft: { type: 'string' }, assignee: { type: 'string' }, issue: { type: 'string' }, url: { type: 'string' },
      input: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [mode] = positionals;
  if (positionals.length !== 1 || !values.worktree || !isAbsolute(values.worktree) ||
    !statSync(values.worktree).isDirectory() || !values.repository ||
    (values.assignee && mode !== 'create') || (values.url && mode !== 'resume') ||
    (values.input && !['plan', 'close'].includes(mode)) ||
    (values.draft && !['create', 'resume', 'update'].includes(mode)) ||
    (values.issue && ['create', 'resume'].includes(mode))) {
    throw new Error(usage);
  }
  const repository = repositoryName(values.repository);
  const github = new GitHubIssues(ghAt(values.worktree));
  if (values.draft) {
    const draft = { worktree: values.worktree, repository, draft: values.draft };
    if (mode === 'create') {
      if (values.assignee && !/^(?:@me|[a-z\d](?:[a-z\d-]*[a-z\d])?)$/i.test(values.assignee)) {
        throw new Error('Expected an explicitly authorized GitHub assignee login');
      }
      return publishIssue(github, { mode, ...draft, assignee: values.assignee });
    }
    if (mode === 'resume') return publishIssue(github, { mode, ...draft, url: values.url });
    if (mode === 'update' && values.issue) {
      return publishIssue(github, { mode, ...draft, number: issueNumber(values.issue) });
    }
  }
  if (!values.issue) throw new Error(usage);
  const ref = { repository, number: issueNumber(values.issue) };
  if (mode === 'inspect') return inspectTree(github, ref);
  if (mode === 'reopen') return reopenIssue(github, ref);
  if (!values.input || !isAbsolute(values.input)) throw new Error(usage);
  const input: unknown = JSON.parse(readFileSync(values.input, 'utf8'));
  if (!Array.isArray(input)) throw new Error('Expected a JSON array of repository-qualified issue identities');
  if (mode === 'plan') return syncPlan(github, ref, input.map(readRef));
  if (mode === 'close') {
    return closeTree(github, ref, input.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('receipt' in entry) ||
        typeof entry.receipt !== 'string' || !entry.receipt.trim()) {
        throw new Error('Expected a passing acceptance receipt reference per issue');
      }
      return { ...readRef(entry), receipt: entry.receipt,
        legacyParent: 'legacyParent' in entry ? readRef(entry.legacyParent) : undefined };
    }));
  }
  throw new Error(usage);
}

try {
  const result = main();
  if (result) console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof PartialIssueTree || error instanceof PartialIssuePublication ? { progress: error.progress } : {}),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
  }));
  process.exitCode = 1;
}
