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
});
