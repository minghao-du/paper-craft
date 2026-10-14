/**
 * Integration tests for Zotero SQLite import.
 *
 * Tests exercise the full ingestion path end-to-end using a lightweight
 * SQLite fixture, validating output refs.jsonl records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { readJsonl } from '../../src/storage/jsonl.js';
import { ReferenceSchema } from '../../src/models/reference.js';
import type { Reference } from '../../src/models/reference.js';
import {
  importZotero,
  findZoteroBaseAttachmentPath,
  parseBaseAttachmentPath,
  cleanDoi,
  parseZoteroDate,
  reconcileReferences,
} from '../../src/commands/import.js';
import {
  resolveZoteroPath,
  getPdfRoot,
  saveNexusConfig,
  resetGlobalConfigCache,
} from '../../src/utils/config.js';

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

  describe('hierarchical Zotero path resolution', () => {
    let fakeHome: string;
    const origEnv = { ...process.env };

    beforeEach(async () => {
      fakeHome = await mkdtemp(join(tmpdir(), 'pc-home-'));
      process.env['HOME'] = fakeHome;
      delete process.env['PC_ZOTERO_PATH'];
      delete process.env['XDG_CONFIG_HOME'];
      resetGlobalConfigCache();
    });

    afterEach(async () => {
      process.env = { ...origEnv };
      resetGlobalConfigCache();
      await rm(fakeHome, { recursive: true, force: true });
    });

    it('prioritizes CLI option over env, config, and default', async () => {
      process.env['PC_ZOTERO_PATH'] = '/env/zotero';
      const resolved = resolveZoteroPath('/cli/zotero');
      expect(resolved).toBe('/cli/zotero');
    });

    it('prioritizes PC_ZOTERO_PATH over config and default', async () => {
      process.env['PC_ZOTERO_PATH'] = '/env/zotero';
      const configDir = join(fakeHome, '.config', 'pc');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.yml'), 'zotero_path: /config/zotero\n');

      const resolved = resolveZoteroPath();
      expect(resolved).toBe('/env/zotero');
    });

    it('prioritizes global config zotero_path over default', async () => {
      const configDir = join(fakeHome, '.config', 'pc');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.yml'), 'zotero_path: /config/zotero\n');

      const resolved = resolveZoteroPath();
      expect(resolved).toBe('/config/zotero');
    });

    it('falls back to default ~/Zotero', async () => {
      const resolved = resolveZoteroPath();
      expect(resolved).toBe(join(fakeHome, 'Zotero'));
    });

    it('expands tildes in paths', async () => {
      process.env['PC_ZOTERO_PATH'] = '~/CustomZotero';
      const resolved = resolveZoteroPath();
      expect(resolved).toBe(join(fakeHome, 'CustomZotero'));
    });
  });

  describe('prefs.js discovery & baseAttachmentPath extraction', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), 'pc-prefs-'));
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('parses baseAttachmentPath from prefs.js in zotero directory', async () => {
      await writeFile(
        join(testDir, 'prefs.js'),
        'user_pref("extensions.zotero.baseAttachmentPath", "/custom/attachments");\n',
      );
      const parsed = findZoteroBaseAttachmentPath(testDir);
      expect(parsed).toBe('/custom/attachments');
    });

    it('searches platform profile directory if prefs.js is not in zotero directory', async () => {
      const profilesDir = join(testDir, 'Profiles');
      const profileSubdir = join(profilesDir, 'abcdefgh.default');
      await mkdir(profileSubdir, { recursive: true });
      await writeFile(
        join(profileSubdir, 'prefs.js'),
        'user_pref("extensions.zotero.baseAttachmentPath", "/profile/attachments");\n',
      );

      const parsed = findZoteroBaseAttachmentPath(testDir, profilesDir);
      expect(parsed).toBe('/profile/attachments');
    });

    it('handles escaped characters and returns undefined when pref is missing', () => {
      expect(
        parseBaseAttachmentPath(
          'user_pref("extensions.zotero.baseAttachmentPath", "C:\\\\Users\\\\Test\\\\Papers");',
        ),
      ).toBe('C:\\Users\\Test\\Papers');

      expect(parseBaseAttachmentPath('user_pref("other.pref", true);')).toBeUndefined();
    });
  });

  describe('PDF attachment resolution during import', () => {
    it('resolves relative pdf_path when attachment is under configured nexus pdf_root', async () => {
      // In fixture, Vaswani has attachment "attachments:vaswani2017attention.pdf"
      // and FIXTURE_DIR/prefs.js has baseAttachmentPath: "/test/attachments"
      // Configure nexus pdf_root to "/test/attachments"
      saveNexusConfig(nexusDir, { pdf_root: '/test/attachments' });

      const result = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      expect(result.added).toBe(2);
      const refs = await readJsonl(refsPath, ReferenceSchema);
      const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
      expect(vaswani.pdf_path).toBe('vaswani2017attention.pdf');

      // Devlin has no valid PDF attachment
      const devlin = refs.find((r) => r.id === 'devlin2019bert')!;
      expect(devlin.pdf_path).toBe('');
    });

    it('resolves pdf_path when baseAttachmentPath is a parent of pdf_root with subfolders', async () => {
      saveNexusConfig(nexusDir, { pdf_root: '/test' });

      await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      const refs = await readJsonl(refsPath, ReferenceSchema);
      const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
      expect(vaswani.pdf_path).toBe('attachments/vaswani2017attention.pdf');
    });

    it('resolves pdf_path when pdf_root is configured via PC_PDF_ROOT environment variable', async () => {
      process.env['PC_PDF_ROOT'] = '/test/attachments';
      try {
        await importZotero({
          zoteroPath: FIXTURE_DIR,
          nexusPath: nexusDir,
          dryRun: false,
        });

        const refs = await readJsonl(refsPath, ReferenceSchema);
        const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
        expect(vaswani.pdf_path).toBe('vaswani2017attention.pdf');
      } finally {
        delete process.env['PC_PDF_ROOT'];
      }
    });

    it('leaves pdf_path empty if attachment falls outside pdf_root', async () => {
      saveNexusConfig(nexusDir, { pdf_root: '/completely/different/path' });

      await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      const refs = await readJsonl(refsPath, ReferenceSchema);
      const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
      expect(vaswani.pdf_path).toBe('');
    });

    it('leaves pdf_path empty if pdf_root is not configured', async () => {
      await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      const refs = await readJsonl(refsPath, ReferenceSchema);
      const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
      expect(vaswani.pdf_path).toBe('');
    });

    it('leaves pdf_path empty if prefs.js is missing or has no baseAttachmentPath', async () => {
      saveNexusConfig(nexusDir, { pdf_root: '/test/attachments' });

      const tempZotero = await mkdtemp(join(tmpdir(), 'pc-zotero-noprefs-'));
      const { copyFile } = await import('node:fs/promises');
      await copyFile(join(FIXTURE_DIR, 'zotero.sqlite'), join(tempZotero, 'zotero.sqlite'));
      await copyFile(
        join(FIXTURE_DIR, 'better-bibtex-search.sqlite'),
        join(tempZotero, 'better-bibtex-search.sqlite'),
      );

      try {
        await importZotero({
          zoteroPath: tempZotero,
          nexusPath: nexusDir,
          dryRun: false,
          customProfilesDir: join(tempZotero, 'empty-profiles'),
        });

        const refs = await readJsonl(refsPath, ReferenceSchema);
        const vaswani = refs.find((r) => r.id === 'vaswani2017attention')!;
        expect(vaswani.pdf_path).toBe('');
      } finally {
        await rm(tempZotero, { recursive: true, force: true });
      }
    });
  });

  describe('idempotent deduplication, merge, and dry-run preview', () => {
    it('is idempotent: running import twice results in 0 additions and all skipped', async () => {
      // First import
      const firstResult = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      expect(firstResult.added).toBe(2);
      expect(firstResult.updated).toBe(0);
      expect(firstResult.skipped).toBe(0);
      expect(firstResult.total).toBe(2);

      const refsAfterFirst = await readJsonl(refsPath, ReferenceSchema);
      expect(refsAfterFirst).toHaveLength(2);

      // Second import
      const secondResult = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      expect(secondResult.added).toBe(0);
      expect(secondResult.updated).toBe(0);
      expect(secondResult.skipped).toBe(2);
      expect(secondResult.total).toBe(2);

      const refsAfterSecond = await readJsonl(refsPath, ReferenceSchema);
      expect(refsAfterSecond).toHaveLength(2);
      expect(refsAfterSecond).toEqual(refsAfterFirst);
    });

    it('preserves pre-existing local notes, s2_id, and unions custom tags when updated from Zotero', async () => {
      // Seed refs.jsonl with a pre-existing record matching Vaswani by DOI and source.id
      const preExisting: Reference = {
        id: 'vaswani-local-citekey',
        doi: '10.5555/3295222.3295349',
        title: 'Old Title',
        authors: [{ first: 'A.', last: 'Vaswani' }],
        abstract: 'Old abstract',
        venue: 'Old venue',
        published: { year: 2017 },
        pdf_path: '',
        source: { type: 'zotero', id: 'ABC12345' },
        note: 'Important local notes on attention mechanisms',
        s2_id: 's2-transformer-uuid',
        tags: ['custom-local-tag', 'reading-list'],
      };
      const { appendJsonl } = await import('../../src/storage/jsonl.js');
      await appendJsonl(refsPath, preExisting);

      const result = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      // 1 added (devlin), 1 updated (vaswani), 0 skipped
      expect(result.added).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.total).toBe(2);

      const refs = await readJsonl(refsPath, ReferenceSchema);
      expect(refs).toHaveLength(2);

      const vaswani = refs.find((r) => r.source.id === 'ABC12345')!;
      expect(vaswani).toBeDefined();
      // Citekey (id) is updated to Better BibTeX citekey
      expect(vaswani.id).toBe('vaswani2017attention');
      // Local enrichments preserved
      expect(vaswani.note).toBe('Important local notes on attention mechanisms');
      expect(vaswani.s2_id).toBe('s2-transformer-uuid');
      // Custom tags unioned with incoming Zotero tags
      expect(vaswani.tags).toContain('custom-local-tag');
      expect(vaswani.tags).toContain('reading-list');
      expect(vaswani.tags).toContain('deep-learning');
      expect(vaswani.tags).toContain('transformer');
      // Incoming fields updated
      expect(vaswani.title).toBe('Attention Is All You Need');
      expect(vaswani.venue).toBe('Advances in Neural Information Processing Systems');
      expect(vaswani.abstract).toContain('Transformer');

      // Now run import again — should be completely skipped
      const rerunResult = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });
      expect(rerunResult.added).toBe(0);
      expect(rerunResult.updated).toBe(0);
      expect(rerunResult.skipped).toBe(2);
    });

    it('deduplicates and merges by DOI when source is not zotero', async () => {
      // Seed with manual reference matching Vaswani DOI
      const manualRef: Reference = {
        id: 'vaswani-manual',
        doi: '10.5555/3295222.3295349',
        title: 'Attention Is All You Need',
        authors: [{ first: 'Ashish', last: 'Vaswani' }],
        abstract: '',
        venue: '',
        published: { year: 2017 },
        pdf_path: '',
        source: { type: 'manual', id: 'manual-doi-ref' },
        note: 'Imported by hand',
      };
      const { appendJsonl } = await import('../../src/storage/jsonl.js');
      await appendJsonl(refsPath, manualRef);

      const result = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      expect(result.added).toBe(1); // Devlin added
      expect(result.updated).toBe(1); // Vaswani merged & updated
      expect(result.skipped).toBe(0);

      const refs = await readJsonl(refsPath, ReferenceSchema);
      expect(refs).toHaveLength(2);
      const matched = refs.find((r) => r.id === 'vaswani2017attention')!;
      expect(matched).toBeDefined();
      expect(matched.note).toBe('Imported by hand');
      expect(matched.source).toEqual({ type: 'zotero', id: 'ABC12345' });
    });

    it('dry-run accurately predicts added, updated, and skipped without touching refs.jsonl', async () => {
      // 1. Dry run on empty repository
      const dryResult1 = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: true,
      });

      expect(dryResult1.status).toBe('dry-run');
      expect(dryResult1.added).toBe(2);
      expect(dryResult1.updated).toBe(0);
      expect(dryResult1.skipped).toBe(0);
      expect(dryResult1.total).toBe(2);

      let refs = await readJsonl(refsPath, ReferenceSchema);
      expect(refs).toHaveLength(0);

      // 2. Perform real import
      const realResult = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });
      expect(realResult.added).toBe(2);
      expect(realResult.updated).toBe(0);
      expect(realResult.skipped).toBe(0);

      refs = await readJsonl(refsPath, ReferenceSchema);
      expect(refs).toHaveLength(2);

      // 3. Dry run on fully up-to-date repository
      const dryResult2 = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: true,
      });
      expect(dryResult2.status).toBe('dry-run');
      expect(dryResult2.added).toBe(0);
      expect(dryResult2.updated).toBe(0);
      expect(dryResult2.skipped).toBe(2);
      expect(dryResult2.total).toBe(2);

      // 4. Modify one existing record in refs.jsonl (outdated field)
      const { writeJsonl } = await import('../../src/storage/jsonl.js');
      refs[0].title = 'Old Outdated Title';
      await writeJsonl(refsPath, refs);

      // 5. Dry run predicts 1 updated, 1 skipped, 0 added
      const dryResult3 = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: true,
      });
      expect(dryResult3.status).toBe('dry-run');
      expect(dryResult3.added).toBe(0);
      expect(dryResult3.updated).toBe(1);
      expect(dryResult3.skipped).toBe(1);
      expect(dryResult3.total).toBe(2);

      // Ensure dry-run did not overwrite the modified title
      const refsAfterDry = await readJsonl(refsPath, ReferenceSchema);
      expect(refsAfterDry[0].title).toBe('Old Outdated Title');
    });
  });

  describe('DOI cleaning and normalization', () => {
    it('normalizes various DOI formats and strips URL prefixes', () => {
      expect(cleanDoi('https://doi.org/10.1000/182')).toBe('10.1000/182');
      expect(cleanDoi('http://doi.org/10.1000/182')).toBe('10.1000/182');
      expect(cleanDoi('doi:10.1000/182')).toBe('10.1000/182');
      expect(cleanDoi('doi: 10.1000/182')).toBe('10.1000/182');
      expect(cleanDoi('DOI:10.1000/182')).toBe('10.1000/182');
      expect(cleanDoi('  https://doi.org/10.1000/182  ')).toBe('10.1000/182');
      expect(cleanDoi('10.1000/182')).toBe('10.1000/182');
      expect(cleanDoi('')).toBe('');
      expect(cleanDoi('   ')).toBe('');
      expect(cleanDoi(undefined)).toBe('');
      expect(cleanDoi(null)).toBe('');
    });

    it('cleans DOIs during Zotero SQLite import', async () => {
      await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
        libraryId: 3,
      });

      const refs = await readJsonl(refsPath, ReferenceSchema);
      const lovelace = refs.find((r) => r.id === 'lovelace2020proceedings')!;
      expect(lovelace.doi).toBe('10.1145/proceedings');

      const hopper = refs.find((r) => r.id === 'hopper2020conference')!;
      expect(hopper.doi).toBe('10.1145/conf');

      const turing = refs.find((r) => r.id === 'turing2020book')!;
      expect(turing.doi).toBe('10.1145/book');
    });
  });

  describe('Venue fallback mapping', () => {
    it('falls back to proceedingsTitle, conferenceName, then bookTitle', async () => {
      await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
        libraryId: 3,
      });

      const refs = await readJsonl(refsPath, ReferenceSchema);

      // Lovelace uses proceedingsTitle
      const lovelace = refs.find((r) => r.id === 'lovelace2020proceedings')!;
      expect(lovelace.venue).toBe('Proceedings of ACM Conference');

      // Hopper uses conferenceName
      const hopper = refs.find((r) => r.id === 'hopper2020conference')!;
      expect(hopper.venue).toBe('International Conference on Machine Learning');

      // Turing uses bookTitle
      const turing = refs.find((r) => r.id === 'turing2020book')!;
      expect(turing.venue).toBe('Foundations of Computer Science');
    });
  });

  describe('Robust date parsing', () => {
    it('parses numeric and delimited dates', () => {
      expect(parseZoteroDate('2017-06-12')).toEqual({ year: 2017, month: 6, day: 12 });
      expect(parseZoteroDate('2020/05/28')).toEqual({ year: 2020, month: 5, day: 28 });
      expect(parseZoteroDate('2020.05.28')).toEqual({ year: 2020, month: 5, day: 28 });
      expect(parseZoteroDate('2019-03')).toEqual({ year: 2019, month: 3, day: undefined });
      expect(parseZoteroDate('2019')).toEqual({ year: 2019 });
    });

    it('parses textual month-year dates', () => {
      expect(parseZoteroDate('May 2020')).toEqual({ year: 2020, month: 5 });
      expect(parseZoteroDate('September, 2018')).toEqual({ year: 2018, month: 9 });
      expect(parseZoteroDate('May 15, 2020')).toEqual({ year: 2020, month: 5, day: 15 });
      expect(parseZoteroDate('15 May 2020')).toEqual({ year: 2020, month: 5, day: 15 });
      expect(parseZoteroDate('2020 May')).toEqual({ year: 2020, month: 5 });
      expect(parseZoteroDate('2020 May 15')).toEqual({ year: 2020, month: 5, day: 15 });
    });

    it('parses seasons, approximate years, and handles edge cases without NaN', () => {
      expect(parseZoteroDate('Spring 2021')).toEqual({ year: 2021 });
      expect(parseZoteroDate('c. 1998')).toEqual({ year: 1998 });
      expect(parseZoteroDate('')).toEqual({ year: 0 });
      expect(parseZoteroDate('   ')).toEqual({ year: 0 });
      expect(parseZoteroDate(undefined)).toEqual({ year: 0 });
      expect(parseZoteroDate(null)).toEqual({ year: 0 });
      expect(parseZoteroDate('Invalid Date String')).toEqual({ year: 0 });
    });

    it('correctly ingests textual dates from Zotero SQLite library 3', async () => {
      await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
        libraryId: 3,
      });

      const refs = await readJsonl(refsPath, ReferenceSchema);
      const lovelace = refs.find((r) => r.id === 'lovelace2020proceedings')!;
      expect(lovelace.published).toEqual({ year: 2020, month: 5 });

      const hopper = refs.find((r) => r.id === 'hopper2020conference')!;
      expect(hopper.published).toEqual({ year: 2020, month: 5, day: 28 });

      const turing = refs.find((r) => r.id === 'turing2020book')!;
      expect(turing.published).toEqual({ year: 2020, month: 5, day: 15 });
    });
  });

  describe('Better BibTeX citekey merge & reconciliation', () => {
    it('updates reference ID to incoming Better BibTeX citekey on merge', async () => {
      // Seed with existing reference having an old custom citekey
      const existingRef: Reference = {
        id: 'old-custom-citekey',
        doi: '10.5555/3295222.3295349',
        title: 'Original Title',
        authors: [{ first: 'Ashish', last: 'Vaswani' }],
        abstract: 'Original abstract',
        venue: 'Original venue',
        published: { year: 2017 },
        pdf_path: '',
        source: { type: 'manual', id: 'manual-id-1' },
      };
      const { appendJsonl } = await import('../../src/storage/jsonl.js');
      await appendJsonl(refsPath, existingRef);

      const result = await importZotero({
        zoteroPath: FIXTURE_DIR,
        nexusPath: nexusDir,
        dryRun: false,
      });

      expect(result.updated).toBe(1);
      const refs = await readJsonl(refsPath, ReferenceSchema);
      const updated = refs.find((r) => r.doi === '10.5555/3295222.3295349')!;
      expect(updated.id).toBe('vaswani2017attention');
      expect(updated.source).toEqual({ type: 'zotero', id: 'ABC12345' });
    });

    it('avoids collision when incoming citekey matches another existing reference ID', () => {
      const existingRefs: Reference[] = [
        {
          id: 'vaswani2017attention',
          doi: '10.1111/different-paper',
          title: 'Different Paper',
          authors: [{ first: 'Other', last: 'Author' }],
          abstract: '',
          venue: '',
          published: { year: 2017 },
          pdf_path: '',
          source: { type: 'manual', id: 'diff-1' },
        },
        {
          id: 'existing-target',
          doi: '10.5555/3295222.3295349',
          title: 'Vaswani Target',
          authors: [{ first: 'Ashish', last: 'Vaswani' }],
          abstract: '',
          venue: '',
          published: { year: 2017 },
          pdf_path: '',
          source: { type: 'manual', id: 'vaswani-old' },
        },
      ];

      const incomingRefs: Reference[] = [
        {
          id: 'vaswani2017attention', // Same citekey as different paper
          doi: '10.5555/3295222.3295349',
          title: 'Attention Is All You Need',
          authors: [{ first: 'Ashish', last: 'Vaswani' }],
          abstract: '',
          venue: '',
          published: { year: 2017 },
          pdf_path: '',
          source: { type: 'zotero', id: 'ABC12345' },
        },
      ];

      const reconciled = reconcileReferences(existingRefs, incomingRefs, { updateIdOnMerge: true });
      expect(reconciled.updated).toBe(1);
      // Because 'vaswani2017attention' was already taken by diff-1, target gets unique id with suffix
      const target = reconciled.updatedRefs.find((r) => r.source.id === 'ABC12345')!;
      expect(target.id).toBe('vaswani2017attention-2');
    });

    it('preserves existing ID for Paperpile imports when updateIdOnMerge is false', () => {
      const existingRefs: Reference[] = [
        {
          id: 'curated-citekey-2020',
          doi: '10.1234/test',
          title: 'Existing Title',
          authors: [{ first: 'Alice', last: 'Smith' }],
          abstract: '',
          venue: '',
          published: { year: 2020 },
          pdf_path: '',
          source: { type: 'paperpile', id: 'pp-1' },
        },
      ];

      const incomingRefs: Reference[] = [
        {
          id: 'Smith2020', // Generated fallback
          doi: '10.1234/test',
          title: 'Updated Title',
          authors: [{ first: 'Alice', last: 'Smith' }],
          abstract: '',
          venue: '',
          published: { year: 2020 },
          pdf_path: '',
          source: { type: 'paperpile', id: 'pp-1' },
        },
      ];

      const reconciled = reconcileReferences(existingRefs, incomingRefs, {
        updateIdOnMerge: false,
      });
      expect(reconciled.updated).toBe(1);
      expect(reconciled.updatedRefs[0].id).toBe('curated-citekey-2020');
      expect(reconciled.updatedRefs[0].title).toBe('Updated Title');
    });
  });
});
