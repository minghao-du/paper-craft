import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { PaperLibrary } from '../src/library.js';
import { ProjectCollection } from '../src/collection.js';

// Independent small fixtures protect identity, evidence, project isolation and persistence.
// No existing package covers these contracts; type checks alone cannot detect the failures.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pc-papers-test-'));
  const sourceRoot = join(root, 'sources');
  const libraryDir = join(root, 'data');
  const collectionFile = join(root, 'project', 'papers.json');
  mkdirSync(sourceRoot);
  const library = new PaperLibrary({ sourceRoot, libraryDir });
  const collection = new ProjectCollection({ collectionFile, library });
  return {
    root, sourceRoot, libraryDir, collectionFile, library, collection,
    paper(name: string, text: string) {
      const path = join(sourceRoot, name);
      writeFileSync(path, text);
      return path;
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('sync preserves identity through edits and disappearance and does not reset a missing root', () => {
  const f = fixture();
  try {
    const path = f.paper('study.md', '# Study\n\nFossil sampling.\n');
    f.library.sync();
    const id = f.library.list().papers[0].paperId;
    writeFileSync(path, '# Revised study\n\nUpdated evidence.\n');
    assert.match(f.library.read(id).text, /Updated evidence/);
    f.library.sync();
    assert.equal(f.library.list().papers[0].paperId, id);
    rmSync(path);
    f.library.sync();
    assert.equal(f.library.list().papers[0].availability, 'unavailable');
    f.paper('study.md', '# Returned\n\nA paper returned.\n');
    f.library.sync();
    assert.equal(f.library.list().papers[0].paperId, id);
    renameSync(path, join(f.sourceRoot, 'moved.md'));
    f.library.sync();
    const papers = f.library.list().papers;
    assert.equal(papers.length, 2);
    assert.equal(papers.find((p) => p.paperId === id)?.availability, 'unavailable');
    assert.notEqual(papers.find((p) => p.relativePath === 'moved.md')?.paperId, id);
    const catalog = join(f.libraryDir, 'catalog.json');
    const before = readFileSync(catalog, 'utf8');
    renameSync(f.sourceRoot, join(f.root, 'missing'));
    assert.throws(() => f.library.sync());
    assert.equal(readFileSync(catalog, 'utf8'), before);
  } finally { f.close(); }
});

test('search filters scope before ranking and reports incomplete reads distinctly', () => {
  const f = fixture();
  try {
    const inside = f.paper('inside.md', '# Inside\n\nFossil data.\n');
    const outside = f.paper('outside.md', '# Fossil sampling extinction\n\nFossil sampling extinction data.\n');
    f.library.sync();
    const id = f.library.list().papers.find((p) => p.relativePath === 'inside.md')!.paperId;
    const result = f.library.search('fossil sampling extinction', { kind: 'papers', paperIds: [id] }, 1);
    assert.deepEqual(result.hits.map((h) => h.paperId), [id]);
    assert.equal(result.requested, 1);
    assert.equal(f.library.search('fossil', { kind: 'papers', paperIds: [] }).hits.length, 0);
    assert.throws(() => f.library.search('fossil', { kind: 'papers', paperIds: ['unknown'] }));
    rmSync(outside);
    const partial = f.library.search('fossil', { kind: 'all' });
    assert.equal(partial.coverage, 'partial');
    assert.equal(partial.read, 1);
    assert.equal(partial.skipped, 1);
    assert.equal(partial.hits[0].paperId, id);
    rmSync(inside);
    assert.equal(f.library.search('fossil', { kind: 'all' }).coverage, 'none');
  } finally { f.close(); }
});

test('live evidence keeps exact source positions and respects output limits', () => {
  const f = fixture();
  try {
    const text = '# Study\n\nOpening.\n\n## Results\n\nFossil sampling affects survival estimates.\n';
    const path = f.paper('study.md', text.replace('survival', 'extinction'));
    f.library.sync();
    const id = f.library.list().papers[0].paperId;
    writeFileSync(path, text);
    const hit = f.library.search('survival', { kind: 'all' }).hits[0];
    assert.equal(hit.paperId, id);
    for (const excerpt of hit.excerpts) {
      const source = text.split('\n').slice(excerpt.startLine - 1, excerpt.endLine).join('\n');
      assert.ok(source.includes(excerpt.text));
      assert.ok(excerpt.text.length <= 1000);
    }
    assert.equal(f.library.read(id, { startLine: 5, endLine: 7 }).text, text.split('\n').slice(4, 7).join('\n'));
    assert.equal(readFileSync(path, 'utf8'), text);
    writeFileSync(path, '# Study\n\n' + 'fossil '.repeat(2000));
    const longHit = f.library.search('fossil', { kind: 'all' }).hits[0];
    assert.ok(longHit.excerpts.some((e) => e.truncated));
    assert.ok(longHit.excerpts.every((e) => e.text.length <= 1000));
    assert.throws(() => f.library.read(id, { startLine: 3, endLine: 3 }));
  } finally { f.close(); }
});

test('invalid catalog paths and corrupt state cannot read outside the library or regenerate IDs', () => {
  const f = fixture();
  try {
    f.paper('study.md', '# Study\n\nEvidence.\n');
    f.library.sync();
    const path = join(f.libraryDir, 'catalog.json');
    const valid = readFileSync(path, 'utf8');
    const catalog = JSON.parse(valid);
    writeFileSync(join(f.root, 'outside.md'), '# Outside\nUnrelated source.\n');
    catalog.papers[0].relativePath = '../outside.md';
    writeFileSync(path, JSON.stringify(catalog));
    assert.throws(() => f.library.read(catalog.papers[0].paperId));
    assert.throws(() => f.library.sync());
    writeFileSync(path, '{broken');
    assert.throws(() => f.library.sync());
    assert.equal(readFileSync(path, 'utf8'), '{broken');
    writeFileSync(path, valid);
    const alternate = join(f.root, 'alternate');
    mkdirSync(alternate);
    assert.throws(() => new PaperLibrary({ sourceRoot: alternate, libraryDir: f.libraryDir }).sync());
    assert.equal(readFileSync(path, 'utf8'), valid);
  } finally { f.close(); }
});

test('Markdown comments and link metadata do not impersonate paper titles or evidence', () => {
  const f = fixture();
  try {
    const text = [
      '<!--', '# Hidden title', 'commentonlykeyword', '-->', '# Real title', '',
      '![Visible fossil caption](assets/urlonlykeyword(plot).png)', '',
      '[Visible link](https://example.test/linkonlykeyword "titleonlykeyword")', '',
      '[source]: https://example.test/referenceonlykeyword', '',
      '[^1]: Supporting footnotekeyword evidence.', '',
      '```md', '# Code example', '![Literal](codekeyword)', '```', '',
    ].join('\r\n');
    const path = f.paper('study.md', text);
    f.library.sync();
    assert.equal(f.library.list().papers[0].title, 'Real title');
    for (const query of ['commentonlykeyword', 'urlonlykeyword', 'linkonlykeyword', 'titleonlykeyword', 'referenceonlykeyword']) {
      assert.deepEqual(f.library.search(query, { kind: 'all' }).hits, [], query);
    }
    for (const query of ['fossil', 'codekeyword', 'footnotekeyword']) {
      const hits = f.library.search(query, { kind: 'all' }).hits;
      assert.equal(hits.length, 1);
      for (const excerpt of hits[0].excerpts) {
        assert.ok(text.split('\r\n').slice(excerpt.startLine - 1, excerpt.endLine).join('\r\n').includes(excerpt.text));
      }
    }
    assert.equal(readFileSync(path, 'utf8'), text);
  } finally { f.close(); }
});

test('selection is atomic and idempotent and removing stale members leaves source papers alone', () => {
  const f = fixture();
  try {
    const path = f.paper('first.md', '# First\n\nFossil evidence.\n');
    f.paper('second.md', '# Second\n\nOther evidence.\n');
    f.library.sync();
    const papers = f.library.list().papers;
    const first = papers.find((p) => p.relativePath === 'first.md')!.paperId;
    const second = papers.find((p) => p.relativePath === 'second.md')!.paperId;
    assert.deepEqual(f.collection.list().paperIds, []);
    f.collection.add([first, first]);
    const before = readFileSync(f.collectionFile, 'utf8');
    assert.throws(() => f.collection.add([second, 'unknown']));
    assert.equal(readFileSync(f.collectionFile, 'utf8'), before);
    f.collection.add([first]);
    assert.equal(readFileSync(f.collectionFile, 'utf8'), before);
    rmSync(path);
    f.library.sync();
    f.collection.add([first]);
    assert.equal(readFileSync(f.collectionFile, 'utf8'), before);
    f.collection.remove([first]);
    f.collection.remove([first, 'unknown']);
    assert.deepEqual(f.collection.list().paperIds, []);
    assert.equal(readFileSync(join(f.sourceRoot, 'second.md'), 'utf8'), '# Second\n\nOther evidence.\n');
  } finally { f.close(); }
});

test('corrupt or mismatched collection state fails without overwriting selections', () => {
  const f = fixture();
  const other = fixture();
  try {
    f.paper('study.md', '# Study\n\nEvidence.\n');
    f.library.sync();
    const id = f.library.list().papers[0].paperId;
    f.collection.add([id]);
    const valid = readFileSync(f.collectionFile, 'utf8');
    other.library.sync();
    const wrong = new ProjectCollection({ library: other.library, collectionFile: f.collectionFile });
    assert.throws(() => wrong.list());
    assert.throws(() => wrong.remove([id]));
    assert.equal(readFileSync(f.collectionFile, 'utf8'), valid);
    writeFileSync(f.collectionFile, '{broken');
    assert.throws(() => f.collection.add([id]));
    assert.throws(() => f.collection.remove([id]));
    assert.equal(readFileSync(f.collectionFile, 'utf8'), '{broken');
  } finally { f.close(); other.close(); }
});

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const runtimeImport = process.env.PAPERS_TEST_IMPORT ?? fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url));

test('CLI resolves every selected ID across worktrees even when the displayed selection is paginated', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 55; i++) f.paper(`paper-${String(i).padStart(2, '0')}.md`, `# Paper ${i}\n\n${i === 54 ? 'unique-target' : 'ordinary'} evidence.\n`);
    f.library.sync();
    f.collection.add(f.library.list({ limit: 100 }).papers.map((p) => p.paperId));
    const worktreeA = join(f.root, 'worktree-a');
    const worktreeB = join(f.root, 'worktree-b');
    mkdirSync(worktreeA); mkdirSync(worktreeB);
    const requestFile = join(f.root, 'request.json');
    const context = { sourceRoot: f.sourceRoot, libraryDir: f.libraryDir, collectionFile: f.collectionFile };
    const args = ['--import', runtimeImport, cliPath];
    writeFileSync(requestFile, JSON.stringify({ ...context, limit: 1 }));
    const listing = JSON.parse(execFileSync(process.execPath, [...args, 'collection', 'list', '--input', requestFile], { cwd: worktreeA, encoding: 'utf8', timeout: 10000 }));
    assert.equal(listing.ok, true);
    assert.equal(listing.result.paperIds.length, 1);
    const before = readFileSync(f.collectionFile, 'utf8');
    writeFileSync(requestFile, JSON.stringify({ ...context, query: 'unique-target', scope: { kind: 'project' } }));
    const result = JSON.parse(execFileSync(process.execPath, [...args, 'library', 'search', '--input', requestFile], { cwd: worktreeB, encoding: 'utf8', timeout: 10000 }));
    assert.equal(result.ok, true);
    assert.equal(result.result.requested, 55);
    assert.equal(result.result.hits[0].relativePath, 'paper-54.md');
    assert.equal(readFileSync(f.collectionFile, 'utf8'), before);
  } finally { f.close(); }
});

test('CLI rejects missing scope and malformed JSON instead of searching globally', () => {
  const f = fixture();
  try {
    f.paper('study.md', '# Study\n\nFossil evidence.\n');
    f.library.sync();
    const request = JSON.stringify({ sourceRoot: f.sourceRoot, libraryDir: f.libraryDir, query: 'fossil' });
    const args = ['--import', runtimeImport, cliPath, 'library', 'search', '--input', '-'];
    const result = spawnSync(process.execPath, args, { input: request, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).ok, false);
    const malformed = spawnSync(process.execPath, args, { input: '{broken', encoding: 'utf8', timeout: 10000 });
    assert.notEqual(malformed.status, 0);
    assert.equal(JSON.parse(malformed.stdout).ok, false);
  } finally { f.close(); }
});
