/**
 * Tests for BibTeX export and dedupe logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toBibtex, toBibtexFile } from '../../src/utils/bibtex.js';
import { readJsonl, writeJsonl } from '../../src/storage/jsonl.js';
import { ReferenceSchema } from '../../src/models/reference.js';
import type { Reference } from '../../src/models/reference.js';

function makeRef(id: string, overrides: Partial<Reference> = {}): Reference {
  return {
    id,
    doi: `10.1234/${id}`,
    title: `Paper ${id}`,
    authors: [{ first: 'Jane', last: 'Doe' }],
    abstract: `Abstract for ${id}`,
    venue: 'Test Journal',
    published: { year: 2024 },
    pdf_path: `${id}.pdf`,
    source: { type: 'manual', id },
    ...overrides,
  };
}

describe('BibTeX export', () => {
  it('generates valid BibTeX entry', () => {
    const ref = makeRef('Test2024', {
      title: 'Machine Learning Methods',
      authors: [
        { first: 'Jane', last: 'Doe' },
        { first: 'John', last: 'Smith' },
      ],
      venue: 'Nature',
      volume: '42',
      pages: '100-110',
    });

    const bib = toBibtex(ref);
    expect(bib).toContain('@article{Test2024,');
    expect(bib).toContain('title = {Machine Learning Methods}');
    expect(bib).toContain('author = {Doe, Jane and Smith, John}');
    expect(bib).toContain('journal = {Nature}');
    expect(bib).toContain('volume = {42}');
    expect(bib).toContain('pages = {100-110}');
    expect(bib).toContain('year = 2024');
    expect(bib).toContain('doi = {10.1234/Test2024}');
  });

  it('escapes special LaTeX characters', () => {
    const ref = makeRef('special', { title: 'R&D: 100% #1 approach_v2' });
    const bib = toBibtex(ref);
    expect(bib).toContain('R\\&D: 100\\% \\#1 approach\\_v2');
  });

  it('generates multi-entry file', () => {
    const refs = [makeRef('a'), makeRef('b')];
    const file = toBibtexFile(refs);
    expect(file.split('@article').length).toBe(3); // 2 entries + 1 split artifact
    expect(file).toContain('@article{a,');
    expect(file).toContain('@article{b,');
  });

  it('omits empty fields', () => {
    const ref = makeRef('minimal', { volume: undefined, pages: undefined, note: undefined });
    const bib = toBibtex(ref);
    expect(bib).not.toContain('volume');
    expect(bib).not.toContain('pages');
    expect(bib).not.toContain('note');
  });
});

describe('Dedupe detection via JSONL', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pc-test-'));
    await mkdir(join(dir, '.paper-craft'), { recursive: true });
    path = join(dir, '.paper-craft', 'refs.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects DOI duplicates', async () => {
    const refs = [
      makeRef('a', { doi: '10.1234/same' }),
      makeRef('b', { doi: '10.1234/same' }),
      makeRef('c', { doi: '10.1234/different' }),
    ];
    await writeJsonl(path, refs);

    const loaded = await readJsonl(path, ReferenceSchema);
    const doiMap = new Map<string, string[]>();
    for (const ref of loaded) {
      if (ref.doi) {
        const list = doiMap.get(ref.doi) ?? [];
        list.push(ref.id);
        doiMap.set(ref.doi, list);
      }
    }
    const dupes = [...doiMap.values()].filter((ids) => ids.length > 1);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toEqual(['a', 'b']);
  });

  it('detects source ID duplicates', async () => {
    const refs = [
      makeRef('a', { source: { type: 'paperpile', id: 'pp-1' } }),
      makeRef('b', { source: { type: 'paperpile', id: 'pp-1' } }),
    ];
    await writeJsonl(path, refs);

    const loaded = await readJsonl(path, ReferenceSchema);
    const sourceMap = new Map<string, string[]>();
    for (const ref of loaded) {
      const key = `${ref.source.type}:${ref.source.id}`;
      const list = sourceMap.get(key) ?? [];
      list.push(ref.id);
      sourceMap.set(key, list);
    }
    const dupes = [...sourceMap.values()].filter((ids) => ids.length > 1);
    expect(dupes).toHaveLength(1);
  });
});
