/**
 * `pc import` — import references from external formats.
 *
 * Supports:
 *   - Paperpile JSON export
 *   - Direct Zotero SQLite (requires Better BibTeX)
 *
 * Usage:
 *   pc import --format paperpile export.json
 *   pc import --format zotero --zotero-path ~/Zotero
 *   pc import --format zotero --dry-run
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { mustGetNexusPath, refsPath } from '../utils/config.js';
import { readJsonl, writeJsonl, appendJsonl } from '../storage/jsonl.js';
import { ReferenceSchema, mergeReferences } from '../models/reference.js';
import type { Reference, Author } from '../models/reference.js';
import { output } from '../utils/output.js';

/** A Paperpile JSON entry (simplified — only fields we use). */
interface PaperpileEntry {
  id?: string;
  title?: string;
  author?: Array<{ given?: string; family?: string }>;
  abstract?: string;
  'container-title'?: string;
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  PMID?: string;
  PMCID?: string;
  issued?: { 'date-parts'?: number[][] };
  note?: string;
  keyword?: string;
  'article-number'?: string;
}

/** Convert a Paperpile entry to our Reference model. */
function paperpileToReference(entry: PaperpileEntry, sourceId: string): Reference {
  const authors: Author[] = (entry.author ?? []).map((a) => ({
    first: a.given ?? '',
    last: a.family ?? '',
  }));

  const firstAuthor = authors[0]?.last ?? 'Unknown';
  const dateParts = entry.issued?.['date-parts']?.[0] ?? [];
  const year = dateParts[0] ?? 0;
  const month = dateParts[1];
  const day = dateParts[2];

  // Generate citekey
  const baseId = `${firstAuthor}${year}`;

  return {
    id: baseId,
    doi: entry.DOI ?? '',
    title: entry.title ?? '',
    authors,
    abstract: entry.abstract ?? '',
    venue: entry['container-title'] ?? '',
    volume: entry.volume,
    issue: entry.issue,
    pages: entry.page,
    note: entry.note,
    published: { year, month, day },
    pdf_path: '',
    source: { type: 'paperpile', id: sourceId },
    pmid: entry.PMID,
    pmcid: entry.PMCID,
    tags: entry.keyword ? entry.keyword.split(',').map((k) => k.trim()) : undefined,
  };
}

/** Generate a unique ID that doesn't collide with existing refs. */
function uniqueId(existingIds: Set<string>, baseId: string): string {
  if (!existingIds.has(baseId)) return baseId;
  for (let i = 2; ; i++) {
    const candidate = `${baseId}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

/** Summary statistics of an import operation. */
export interface ImportResult {
  status: string;
  added: number;
  updated: number;
  skipped: number;
  total: number;
}

// ──────────────────────────────────────────────
// Zotero SQLite + Better BibTeX import
// ──────────────────────────────────────────────

/** Options for importing from Zotero SQLite database. */
export interface ZoteroImportOptions {
  zoteroPath: string;
  nexusPath: string;
  dryRun: boolean;
}

/** Parse a Zotero date string into { year, month, day }. */
function parseZoteroDate(raw: string): { year: number; month?: number; day?: number } {
  // Zotero dates are typically "2017-06-12", "2019", "2019-03", etc.
  const parts = raw.split('-').map(Number);
  return {
    year: parts[0] || 0,
    month: parts.length >= 2 && parts[1] ? parts[1] : undefined,
    day: parts.length >= 3 && parts[2] ? parts[2] : undefined,
  };
}

/** Row shape from the main Zotero extraction query. */
interface ZoteroRow {
  itemID: number;
  itemKey: string;
  citekey: string;
}

/** Extract references from a Zotero SQLite database with Better BibTeX citekeys. */
export async function importZotero(opts: ZoteroImportOptions): Promise<ImportResult> {
  const zoteroDbPath = join(opts.zoteroPath, 'zotero.sqlite');
  const bbtDbPath = join(opts.zoteroPath, 'better-bibtex-search.sqlite');

  // Validate database files exist
  if (!existsSync(zoteroDbPath)) {
    throw new Error(
      `Zotero database not found at ${zoteroDbPath}.\n` +
        `Specify --zotero-path pointing to your Zotero data directory.`,
    );
  }
  if (!existsSync(bbtDbPath)) {
    throw new Error(
      `Better BibTeX database not found at ${bbtDbPath}.\n` +
        `Better BibTeX must be installed in Zotero for citekey-based import.\n` +
        `Install it from: https://retorque.re/zotero-better-bibtex/installation/`,
    );
  }

  // Open databases read-only via sql.js (reads file into WASM memory — no lock)
  const SQL = await initSqlJs();
  const zoteroBuffer = await readFile(zoteroDbPath);
  const bbtBuffer = await readFile(bbtDbPath);

  const db: Database = new SQL.Database(zoteroBuffer);

  // Attach Better BibTeX database
  // sql.js doesn't support ATTACH, so open separately and query in two phases
  const bbtDb: Database = new SQL.Database(bbtBuffer);

  try {
    return await extractReferences(db, bbtDb, opts);
  } finally {
    db.close();
    bbtDb.close();
  }
}

async function extractReferences(
  db: Database,
  bbtDb: Database,
  opts: ZoteroImportOptions,
): Promise<ImportResult> {
  const nexus = opts.nexusPath;
  const path = refsPath(nexus);

  // Read existing refs for dedup
  const existingRefs = await readJsonl(path, ReferenceSchema);
  const existingIds = new Set(existingRefs.map((r) => r.id));

  // Build dedup indexes
  const bySourceId = new Map<string, number>();
  const byDoi = new Map<string, number>();
  existingRefs.forEach((r, i) => {
    if (r.source.type === 'zotero' && r.source.id) bySourceId.set(r.source.id, i);
    if (r.doi) byDoi.set(r.doi, i);
  });

  // Build citekey map from BBT: itemID → citekey
  const citekeyMap = new Map<number, string>();
  const bbtStmt = bbtDb.prepare('SELECT itemID, citekey FROM citekeys');
  while (bbtStmt.step()) {
    const row = bbtStmt.getAsObject() as { itemID: number; citekey: string };
    citekeyMap.set(row.itemID, row.citekey);
  }
  bbtStmt.free();

  // Query main items — exclude non-regular types (attachment=14, note=1, annotation=36)
  // and deleted items
  const itemStmt = db.prepare(`
    SELECT i.itemID, i.key AS itemKey
    FROM items i
    WHERE i.libraryID = 1
      AND i.itemTypeID NOT IN (1, 14, 36)
      AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    ORDER BY i.itemID
  `);

  const rows: ZoteroRow[] = [];
  while (itemStmt.step()) {
    const row = itemStmt.getAsObject() as { itemID: number; itemKey: string };
    const citekey = citekeyMap.get(row.itemID);
    if (!citekey) continue; // Skip items without BBT citekeys
    rows.push({ itemID: row.itemID, itemKey: row.itemKey, citekey });
  }
  itemStmt.free();

  // Build field lookup: fieldName → fieldID
  const fieldMap = new Map<string, number>();
  const fieldStmt = db.prepare('SELECT fieldID, fieldName FROM fields');
  while (fieldStmt.step()) {
    const row = fieldStmt.getAsObject() as { fieldID: number; fieldName: string };
    fieldMap.set(row.fieldName, row.fieldID);
  }
  fieldStmt.free();

  // Prepare field-value lookup
  const valueStmt = db.prepare(`
    SELECT idv.value
    FROM itemData id
    JOIN itemDataValues idv ON idv.valueID = id.valueID
    WHERE id.itemID = :itemID AND id.fieldID = :fieldID
  `);

  // Prepare author lookup
  const authorStmt = db.prepare(`
    SELECT c.firstName, c.lastName
    FROM itemCreators ic
    JOIN creators c ON c.creatorID = ic.creatorID
    WHERE ic.itemID = :itemID
    ORDER BY ic.orderIndex
  `);

  let added = 0;
  let updated = 0;
  const newRefs: Reference[] = [];
  const updatedRefs = [...existingRefs];
  let hasUpdates = false;

  for (const row of rows) {
    const getField = (fieldName: string): string => {
      const fieldID = fieldMap.get(fieldName);
      if (fieldID === undefined) return '';
      valueStmt.bind({ ':itemID': row.itemID, ':fieldID': fieldID });
      let val = '';
      if (valueStmt.step()) {
        const r = valueStmt.getAsObject() as { value: string };
        val = r.value ?? '';
      }
      valueStmt.reset();
      return val;
    };

    // Extract authors
    authorStmt.bind({ ':itemID': row.itemID });
    const authors: Author[] = [];
    while (authorStmt.step()) {
      const a = authorStmt.getAsObject() as { firstName: string; lastName: string };
      authors.push({ first: a.firstName ?? '', last: a.lastName ?? '' });
    }
    authorStmt.reset();

    const dateStr = getField('date');
    const published = dateStr ? parseZoteroDate(dateStr) : { year: 0 };

    const doi = getField('DOI');
    const volume = getField('volume') || undefined;
    const issue = getField('issue') || undefined;
    const pages = getField('pages') || undefined;

    let ref: Reference = {
      id: row.citekey,
      doi: doi,
      title: getField('title'),
      authors,
      abstract: getField('abstractNote'),
      venue: getField('publicationTitle'),
      volume,
      issue,
      pages,
      published,
      pdf_path: '',
      source: { type: 'zotero', id: row.itemKey },
    };

    // Dedup: check source ID first, then DOI
    let existingIdx = -1;
    if (bySourceId.has(row.itemKey)) {
      existingIdx = bySourceId.get(row.itemKey)!;
    } else if (doi && byDoi.has(doi)) {
      existingIdx = byDoi.get(doi)!;
    }

    if (existingIdx >= 0) {
      const existing = updatedRefs[existingIdx];
      updatedRefs[existingIdx] = mergeReferences(existing, { ...ref, id: existing.id });
      hasUpdates = true;
      updated++;
    } else {
      const id = uniqueId(existingIds, ref.id);
      existingIds.add(id);
      ref = { ...ref, id };
      newRefs.push(ref);
      added++;
    }
  }

  valueStmt.free();
  authorStmt.free();

  const result: ImportResult = {
    status: opts.dryRun ? 'dry-run' : 'ok',
    added,
    updated,
    skipped: 0,
    total: rows.length,
  };

  if (!opts.dryRun) {
    if (hasUpdates) {
      await writeJsonl(path, updatedRefs.concat(newRefs));
    } else {
      for (const ref of newRefs) {
        await appendJsonl(path, ref);
      }
    }
  }

  return result;
}

// ──────────────────────────────────────────────
// CLI registration
// ──────────────────────────────────────────────

/** Register the `pc import` command on the Commander program. */
export function registerImportCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('import')
    .description('Import references from external formats')
    .argument('[file]', 'Path to import file (required for paperpile)')
    .requiredOption('--format <format>', 'Import format (paperpile, zotero)')
    .option('--dry-run', 'Show what would be imported without writing')
    .option('--zotero-path <path>', 'Path to Zotero data directory')
    .action(
      async (
        file: string | undefined,
        cmdOpts: { format: string; dryRun?: boolean; zoteroPath?: string },
      ) => {
        if (cmdOpts.format === 'zotero') {
          const zoteroPath = cmdOpts.zoteroPath ?? join(process.env['HOME'] ?? '', 'Zotero');
          const nexus = mustGetNexusPath();

          const result = await importZotero({
            zoteroPath,
            nexusPath: nexus,
            dryRun: cmdOpts.dryRun ?? false,
          });

          output(result, opts.human(), () =>
            [
              `Import ${result.status}: ${result.total} entries processed`,
              `  Added:   ${result.added}`,
              `  Updated: ${result.updated}`,
              `  Skipped: ${result.skipped}`,
              '',
              'Run `pc rebuild` to update the search index.',
            ].join('\n'),
          );
          return;
        }

        if (cmdOpts.format === 'paperpile') {
          if (!file) {
            throw new Error('File argument is required for paperpile format.');
          }

          const nexus = mustGetNexusPath();
          const path = refsPath(nexus);

          // Read existing refs
          const existingRefs = await readJsonl(path, ReferenceSchema);
          const existingIds = new Set(existingRefs.map((r) => r.id));

          // Build indexes for dedup
          const bySourceId = new Map<string, number>();
          const byDoi = new Map<string, number>();
          existingRefs.forEach((r, i) => {
            if (r.source.type === 'paperpile' && r.source.id) bySourceId.set(r.source.id, i);
            if (r.doi) byDoi.set(r.doi, i);
          });

          // Read and parse import file
          const raw = await readFile(file, 'utf-8');
          const entries: PaperpileEntry[] = JSON.parse(raw);

          let added = 0;
          let updated = 0;
          const skipped = 0;
          const newRefs: Reference[] = [];
          const updatedRefs = [...existingRefs];
          let hasUpdates = false;

          for (const entry of entries) {
            const sourceId = entry.id ?? '';
            let ref = paperpileToReference(entry, sourceId);

            // Dedup: check source ID first, then DOI
            let existingIdx = -1;
            if (sourceId && bySourceId.has(sourceId)) {
              existingIdx = bySourceId.get(sourceId)!;
            } else if (ref.doi && byDoi.has(ref.doi)) {
              existingIdx = byDoi.get(ref.doi)!;
            }

            if (existingIdx >= 0) {
              // Merge with existing
              const existing = updatedRefs[existingIdx];
              updatedRefs[existingIdx] = mergeReferences(existing, {
                ...ref,
                id: existing.id,
              });
              hasUpdates = true;
              updated++;
            } else {
              // New entry
              const id = uniqueId(existingIds, ref.id);
              existingIds.add(id);
              ref = { ...ref, id };
              newRefs.push(ref);
              added++;
            }
          }

          const result: ImportResult = {
            status: cmdOpts.dryRun ? 'dry-run' : 'ok',
            added,
            updated,
            skipped,
            total: entries.length,
          };

          if (!cmdOpts.dryRun) {
            if (hasUpdates) {
              await writeJsonl(path, updatedRefs.concat(newRefs));
            } else {
              for (const ref of newRefs) {
                await appendJsonl(path, ref);
              }
            }
          }

          output(result, opts.human(), () =>
            [
              `Import ${result.status}: ${result.total} entries processed`,
              `  Added:   ${result.added}`,
              `  Updated: ${result.updated}`,
              `  Skipped: ${result.skipped}`,
            ].join('\n'),
          );
          return;
        }

        throw new Error(`Unsupported format: ${cmdOpts.format}. Supported: paperpile, zotero`);
      },
    );
}
