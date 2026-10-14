/**
 * Integration tests for Zotero SQLite import.
 *
 * Tests exercise the full ingestion path end-to-end using a lightweight
 * SQLite fixture, validating output refs.jsonl records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonl } from '../../src/storage/jsonl.js';
import { ReferenceSchema } from '../../src/models/reference.js';
import type { Reference } from '../../src/models/reference.js';
import { importZotero } from '../../src/commands/import.js';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'zotero');

describe('Zotero import', () => {
  let nexusDir: string;
  let refsPath: string;

  beforeEach(async () => {
    nexusDir = await mkdtemp(join(tmpdir(), 'pc-zotero-test-'));
    await mkdir(join(nexusDir, '.paper-craft'), { recursive: true });
    refsPath = join(nexusDir, '.paper-craft', 'refs.jsonl');
  });

  afterEach(async () => {
    await rm(nexusDir, { recursive: true, force: true });
  });

  it('ingests core bibliographic fields from Zotero', async () => {
    const result = await importZotero({
      zoteroPath: FIXTURE_DIR,
      nexusPath: nexusDir,
      dryRun: false,
    });

    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.total).toBe(2);

    const refs = await readJsonl(refsPath, ReferenceSchema);
    expect(refs).toHaveLength(2);

    // Find by citekey
    const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
    expect(vaswani).toBeDefined();
    expect(vaswani.title).toBe('Attention Is All You Need');
    expect(vaswani.doi).toBe('10.5555/3295222.3295349');
    expect(vaswani.venue).toBe('Advances in Neural Information Processing Systems');
    expect(vaswani.abstract).toContain('Transformer');
    expect(vaswani.published.year).toBe(2017);
    expect(vaswani.published.month).toBe(6);
    expect(vaswani.published.day).toBe(12);
    expect(vaswani.authors).toEqual([
      { first: 'Ashish', last: 'Vaswani' },
      { first: 'Noam', last: 'Shazeer' },
    ]);
    expect(vaswani.source).toEqual({ type: 'zotero', id: 'ABC12345' });
    expect(vaswani.pages).toBe('5998-6008');

    const devlin = refs.find((r) => r.id === 'devlin2019bert')!;
    expect(devlin).toBeDefined();
    expect(devlin.title).toBe('BERT: Pre-training of Deep Bidirectional Transformers');
    expect(devlin.source).toEqual({ type: 'zotero', id: 'DEF67890' });
    expect(devlin.authors).toEqual([{ first: 'Jacob', last: 'Devlin' }]);
    expect(devlin.published.year).toBe(2019);
  });

  it('ingests native Zotero tags and excludes collection hierarchies', async () => {
    await importZotero({
      zoteroPath: FIXTURE_DIR,
      nexusPath: nexusDir,
      dryRun: false,
    });

    const refs = await readJsonl(refsPath, ReferenceSchema);
    const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
    expect(vaswani.tags).toEqual(['deep-learning', 'transformer']);
    expect(vaswani.tags).not.toContain('Deep Learning Hierarchy');
    expect(vaswani.tags).not.toContain('Artificial Intelligence');

    const devlin = refs.find((r) => r.id === 'devlin2019bert')!;
    expect(devlin.tags).toBeUndefined();
  });

  it('defaults to personal library (libraryID = 1) and excludes group libraries', async () => {
    const result = await importZotero({
      zoteroPath: FIXTURE_DIR,
      nexusPath: nexusDir,
      dryRun: false,
    });

    expect(result.total).toBe(2);
    const refs = await readJsonl(refsPath, ReferenceSchema);
    expect(refs.map((r) => r.id)).toEqual(['vaswani2017attention', 'devlin2019bert']);
  });

  it('targets a custom group library via libraryId', async () => {
    const result = await importZotero({
      zoteroPath: FIXTURE_DIR,
      nexusPath: nexusDir,
      dryRun: false,
      libraryId: 2,
    });

    expect(result.added).toBe(1);
    expect(result.total).toBe(1);

    const refs = await readJsonl(refsPath, ReferenceSchema);
    expect(refs).toHaveLength(1);
    const brown = refs[0];
    expect(brown.id).toBe('brown2020language');
    expect(brown.title).toBe('Language Models are Few-Shot Learners');
    expect(brown.source).toEqual({ type: 'zotero', id: 'GRP12345' });
    expect(brown.authors).toEqual([{ first: 'Tom', last: 'Brown' }]);
    expect(brown.published.year).toBe(2020);
    expect(brown.tags).toEqual(['few-shot', 'llm']);
  });

  it('excludes deleted items, attachments, and notes', async () => {
    const result = await importZotero({
      zoteroPath: FIXTURE_DIR,
      nexusPath: nexusDir,
      dryRun: false,
    });

    // Only 2 real items, not 5 (deleted, attachment, note excluded)
    expect(result.total).toBe(2);

    const refs = await readJsonl(refsPath, ReferenceSchema);
    const ids = refs.map((r) => r.source.id);
    expect(ids).not.toContain('GHI11111'); // deleted
    expect(ids).not.toContain('ATT00001'); // attachment
    expect(ids).not.toContain('NOTE0001'); // note
  });

  it('reports an actionable error when Better BibTeX is missing', async () => {
    // Use a directory that has zotero.sqlite but not better-bibtex-search.sqlite
    const fakeDir = await mkdtemp(join(tmpdir(), 'pc-no-bbt-'));
    // Copy just zotero.sqlite
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(FIXTURE_DIR, 'zotero.sqlite'), join(fakeDir, 'zotero.sqlite'));

    await expect(
      importZotero({ zoteroPath: fakeDir, nexusPath: nexusDir, dryRun: false }),
    ).rejects.toThrow(/Better BibTeX/i);

    await rm(fakeDir, { recursive: true, force: true });
  });

  it('appends newly extracted references to existing refs.jsonl', async () => {
    // Seed refs.jsonl with a pre-existing reference
    const existing: Reference = {
      id: 'existing2020',
      doi: '10.1234/existing',
      title: 'Existing Paper',
      authors: [{ first: 'Alice', last: 'Smith' }],
      abstract: 'Already here.',
      venue: 'Test Journal',
      published: { year: 2020 },
      pdf_path: '',
      source: { type: 'manual', id: 'manual-1' },
    };
    const { appendJsonl } = await import('../../src/storage/jsonl.js');
    await appendJsonl(refsPath, existing);

    await importZotero({
      zoteroPath: FIXTURE_DIR,
      nexusPath: nexusDir,
      dryRun: false,
    });

    const refs = await readJsonl(refsPath, ReferenceSchema);
    expect(refs).toHaveLength(3); // 1 existing + 2 new
    expect(refs[0].id).toBe('existing2020');
  });

  it('does not write when dry-run is set', async () => {
    const result = await importZotero({
      zoteroPath: FIXTURE_DIR,
      nexusPath: nexusDir,
      dryRun: true,
    });

    expect(result.status).toBe('dry-run');
    expect(result.added).toBe(2);

    // refs.jsonl should not exist
    const refs = await readJsonl(refsPath, ReferenceSchema);
    expect(refs).toHaveLength(0);
  });

  it('reports an error when zotero.sqlite is not found', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'pc-empty-'));

    await expect(
      importZotero({ zoteroPath: emptyDir, nexusPath: nexusDir, dryRun: false }),
    ).rejects.toThrow(/zotero\.sqlite/i);

    await rm(emptyDir, { recursive: true, force: true });
  });

  describe('CLI command arguments', () => {
    it('requires file argument when format is paperpile', async () => {
      const { Command } = await import('commander');
      const { registerImportCommand } = await import('../../src/commands/import.js');

      const program = new Command();
      program.exitOverride();
      registerImportCommand(program, { human: () => false });

      process.env['PC_NEXUS_PATH'] = nexusDir;
      try {
        await expect(
          program.parseAsync(['node', 'pc', 'import', '--format', 'paperpile']),
        ).rejects.toThrow(/File argument is required for paperpile format/i);
      } finally {
        delete process.env['PC_NEXUS_PATH'];
      }
    });

    it('allows omitting file argument when format is zotero', async () => {
      const { Command } = await import('commander');
      const { registerImportCommand } = await import('../../src/commands/import.js');

      const program = new Command();
      program.exitOverride();
      registerImportCommand(program, { human: () => false });

      process.env['PC_NEXUS_PATH'] = nexusDir;
      try {
        await program.parseAsync([
          'node',
          'pc',
          'import',
          '--format',
          'zotero',
          '--zotero-path',
          FIXTURE_DIR,
          '--dry-run',
        ]);
      } finally {
        delete process.env['PC_NEXUS_PATH'];
      }
    });

    it('parses --library flag in CLI command', async () => {
      const { Command } = await import('commander');
      const { registerImportCommand } = await import('../../src/commands/import.js');

      const program = new Command();
      program.exitOverride();
      registerImportCommand(program, { human: () => false });

      process.env['PC_NEXUS_PATH'] = nexusDir;
      try {
        await program.parseAsync([
          'node',
          'pc',
          'import',
          '--format',
          'zotero',
          '--zotero-path',
          FIXTURE_DIR,
          '--library',
          '2',
        ]);
      } finally {
        delete process.env['PC_NEXUS_PATH'];
      }

      const refs = await readJsonl(refsPath, ReferenceSchema);
      expect(refs).toHaveLength(1);
      expect(refs[0].id).toBe('brown2020language');
      expect(refs[0].tags).toEqual(['few-shot', 'llm']);
    });
  });
});
