import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { issueKey, refFromUrl, type GitHubIssues, type IssueRef } from './github.js';
import { assertDraftPreservesTasklist, declaredParent } from './tasklist.js';

export class PartialIssuePublication extends Error {
  constructor(message: string, readonly progress: unknown, cause: unknown) {
    super(message, { cause });
  }
}

type Request = {
  worktree: string;
  repository: string;
  draft: string;
} & ({ mode: 'create'; assignee?: string } | { mode: 'update'; number: number } | { mode: 'resume'; url?: string });

interface Receipt {
  repository: string;
  draft: string;
  archive: string;
  digest: string;
  status: 'pending' | 'created';
  url?: string;
}

function digest(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function draftTitle(file: string, body: string): string {
  const heading = /^# (.*)$/.exec(body.split(/\r?\n/, 1)[0])?.[1].trim();
  return heading || basename(file, extname(file));
}

function safeFile(path: string): Buffer {
  if (!lstatSync(path).isFile() || realpathSync(path) !== path) {
    throw new Error('Expected a regular file with no symbolic-link components: ' + path);
  }
  return readFileSync(path);
}

function samePath(file: string, expected: string): void {
  if (digest(safeFile(file)) !== expected) throw new Error('Draft contents changed: ' + file);
}

function noArchiveCollision(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Archive destination already exists: ' + path);
}

function archivedReceipt(path: string, url: string): string {
  return path + '.' + digest(issueKey(refFromUrl(url))) + '.archived.json';
}

function writeStaged(ledger: string, contents: Buffer | string, install: (path: string) => void): void {
  const directory = mkdtempSync(join(ledger, 'stage-'));
  try {
    const temporary = join(directory, 'contents');
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true });
    install(temporary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function publishIssue(github: GitHubIssues, request: Request) {
  const worktree = realpathSync(request.worktree);
  const supplied = isAbsolute(request.draft) ? resolve(request.draft) : resolve(worktree, request.draft);
  const draft = join(realpathSync(dirname(supplied)), basename(supplied));
  const draftPath = relative(worktree, draft);
  if (!draftPath || draftPath.split(sep)[0] === '_ignore') {
    throw new Error('Draft must be outside the assigned checkout archive');
  }
  if (request.mode === 'update') {
    const bytes = safeFile(draft);
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const ref = { repository: request.repository, number: request.number };
    const before = github.issue(ref);
    assertDraftPreservesTasklist(before.body, body, before);
    const liveParent = declaredParent(before.body, before);
    const draftParent = declaredParent(body, before);
    if (Boolean(liveParent) !== Boolean(draftParent) ||
      (liveParent && draftParent && issueKey(liveParent) !== issueKey(draftParent))) {
      throw new Error('Draft changes the explicit parent declaration on ' + issueKey(before));
    }
    const current = github.issue(ref);
    if (current.body !== before.body) throw new Error('Issue body changed while validating the draft');
    samePath(draft, digest(bytes));
    if (current.body !== body) github.edit(ref, draft);
    const updated = github.issue(ref);
    if (updated.body !== body) throw new Error('Issue update could not be verified: ' + updated.url);
    return { status: 'updated', ...ref, url: updated.url, draft };
  }

  const archive = join(worktree, '_ignore', basename(draft));
  const archiveDir = dirname(archive);
  const ledger = join(archiveDir, '.issue-file');
  for (const directory of [archiveDir, ledger]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('Archive directory must not be a symbolic link: ' + directory);
  }
  const recordPath = join(ledger, digest(draftPath) + '.json');
  const stagedArchive = recordPath + '.draft';
  let record: Receipt;
  let historicalReceipt: string | undefined;
  if (request.mode === 'create') {
    if (existsSync(recordPath)) throw new Error('Create already attempted. Use resume with receipt ' + recordPath);
    const bytes = safeFile(draft);
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    noArchiveCollision(archive);
    record = { repository: request.repository, draft, archive, digest: digest(bytes), status: 'pending' };
    writeStaged(ledger, JSON.stringify(record), (temporary) => linkSync(temporary, recordPath));
    try {
      samePath(draft, record.digest);
      record.url = github.run(['issue', 'create', '--repo', request.repository, '--title',
        draftTitle(draft, body), '--body-file', draft,
        ...(request.assignee ? ['--assignee', request.assignee] : [])]).trim();
    } catch (error) {
      throw new PartialIssuePublication('Create is unresolved. Reconcile GitHub before resuming.',
        { repository: request.repository, draft, archive, receipt: recordPath, disposition: 'create_unresolved' }, error);
    }
  } else {
    const candidates = readdirSync(ledger).filter((name) => name.startsWith(basename(recordPath) + '.') &&
      name.endsWith('.archived.json')).map((name) => join(ledger, name));
    const archived = request.url ? candidates.find((path) => path === archivedReceipt(recordPath, request.url!))
      : candidates.length === 1 ? candidates[0] : undefined;
    if (!existsSync(recordPath) && !archived && candidates.length > 1) {
      throw new Error('Multiple completed receipts match this draft path. Supply the original issue URL.');
    }
    historicalReceipt = request.url && archived ? archived : existsSync(recordPath) ? undefined : archived;
    const recovered: unknown = JSON.parse(safeFile(historicalReceipt ?? recordPath).toString('utf8'));
    if (!recovered || typeof recovered !== 'object' || !('repository' in recovered) || recovered.repository !== request.repository ||
      !('draft' in recovered) || recovered.draft !== draft || !('archive' in recovered) || recovered.archive !== archive ||
      !('digest' in recovered) || typeof recovered.digest !== 'string' || !('status' in recovered) ||
      (recovered.status !== 'created' && recovered.status !== 'pending')) throw new Error('Invalid create receipt: ' + recordPath);
    const url = 'url' in recovered && typeof recovered.url === 'string' ? recovered.url : undefined;
    if (url && request.url && issueKey(refFromUrl(url)) !== issueKey(refFromUrl(request.url))) {
      throw new Error('Supplied issue conflicts with recorded create: ' + url);
    }
    record = { repository: request.repository, draft, archive, digest: recovered.digest,
      status: recovered.status, url: url ?? request.url };
  }

  let observed: IssueRef | undefined;
  let verified = false;
  try {
    if (!record.url) throw new Error('Supply the verified issue URL to resume an unresolved create');
    const ref = refFromUrl(record.url);
    if (ref.repository !== request.repository) throw new Error('Created issue URL has an unexpected repository');
    observed = ref;
    const persistIssue = () => {
      record.status = 'created';
      writeStaged(ledger, JSON.stringify(record), (temporary) => renameSync(temporary, recordPath));
    };
    // A URL returned by a successful create can be recovered even if read-back is unavailable.
    if (request.mode === 'create') persistIssue();
    const source = !historicalReceipt && existsSync(draft) ? draft : archive;
    const bytes = safeFile(source);
    const created = github.issue(ref);
    if (digest(bytes) !== record.digest || created.body !== bytes.toString('utf8') ||
      created.title !== draftTitle(draft, bytes.toString('utf8'))) {
      throw new Error('GitHub issue does not match the original draft: ' + created.url);
    }
    verified = true;
    if (historicalReceipt) {
      return { status: 'created', ...ref, url: created.url, archive, receipt: historicalReceipt };
    }
    if (record.status === 'pending') persistIssue();
    if (source === draft) {
      if (!existsSync(stagedArchive)) {
        writeStaged(ledger, bytes, (temporary) => linkSync(temporary, stagedArchive));
      }
      samePath(stagedArchive, record.digest);
      if (!existsSync(archive)) linkSync(stagedArchive, archive);
      const destination = lstatSync(archive);
      const staged = lstatSync(stagedArchive);
      if (destination.dev !== staged.dev || destination.ino !== staged.ino) {
        throw new Error('Archive destination is occupied by another file: ' + archive);
      }
      samePath(draft, record.digest);
      unlinkSync(draft);
    }
    samePath(archive, record.digest);
    if (existsSync(stagedArchive)) unlinkSync(stagedArchive);
    const completed = archivedReceipt(recordPath, created.url);
    if (existsSync(recordPath)) renameSync(recordPath, completed);
    return { status: 'created', ...ref, url: created.url, archive, receipt: completed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PartialIssuePublication(message, {
      repository: request.repository, number: observed?.number, url: record.url, draft, archive,
      receipt: historicalReceipt ?? recordPath,
      disposition: verified ? 'archive_unverified' : 'create_unverified',
    }, error);
  }
}
