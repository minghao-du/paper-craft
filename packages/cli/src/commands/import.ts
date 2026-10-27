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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import initSqlJs, { type Database } from 'sql.js';
import {
  mustGetNexusPath,
  refsPath,
  resolveZoteroPath,
  getPdfRoot,
  expandTilde,
} from '@paper-craft/core/utils/config';
import { readJsonl, writeJsonl, appendJsonl } from '@paper-craft/core/storage/jsonl';
import { ReferenceSchema, mergeReferences, referencesEqual } from '@paper-craft/core/models/reference';
import type { Reference, Author } from '@paper-craft/core/models/reference';
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
    doi: cleanDoi(entry.DOI),
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

/**
 * Clean and normalize a DOI string.
 *
 * Trims whitespace, strips leading URL prefixes ('https://doi.org/', 'http://doi.org/')
 * and 'doi:' scheme prefixes, defaulting to '' if absent or empty.
 */
export function cleanDoi(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '';
  let doi = raw.trim();
  if (!doi) return '';
  doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
  doi = doi.replace(/^doi:\s*/i, '');
  return doi.trim();
}

/** Generate a unique ID that doesn't collide with existing refs. */
function uniqueId(existingIds: Set<string>, baseId: string): string {
  if (!existingIds.has(baseId)) return baseId;
  for (let i = 2; ; i++) {
    const candidate = `${baseId}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

/** Options for reference reconciliation and deduplication. */
export interface ReconcileOptions {
  /** If true, incoming ref.id replaces existing.id on merge (used by Zotero to apply Better BibTeX citekeys). */
  updateIdOnMerge?: boolean;
}

/** Result of reconciling incoming references against existing references. */
export interface ReconcileResult {
  added: number;
  updated: number;
  skipped: number;
  total: number;
  updatedRefs: Reference[];
  newRefs: Reference[];
  hasUpdates: boolean;
}

/**
 * Reconcile incoming references against existing references.
 *
 * Shared deduplication and reconciliation pipeline used by both Zotero SQLite and Paperpile JSON imports:
 *   1. Matches existing references by exact `source.type` + `source.id` first.
 *   2. Falls back to matching by cleaned DOI if source ID does not match.
 *   3. When matching an existing reference:
 *      - Merges incoming metadata with existing reference (preserving local notes, tags union).
 *      - If `updateIdOnMerge` is true (e.g. Zotero with Better BibTeX citekeys), updates the reference ID
 *        to incoming citekey, ensuring no collisions with other references.
 *      - Compares merged result to existing using `referencesEqual` to accurately track updated vs. skipped.
 *   4. For new references:
 *      - Assigns a unique ID if collision with existing references occurs.
 *      - Records addition.
 */
export function reconcileReferences(
  existingRefs: Reference[],
  incomingRefs: Reference[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const updateIdOnMerge = options.updateIdOnMerge ?? false;
  const existingIds = new Set(existingRefs.map((r) => r.id));

  // Build indexes for fast dedup lookup
  const bySourceId = new Map<string, number>();
  const byDoi = new Map<string, number>();

  existingRefs.forEach((r, i) => {
    if (r.source.id) {
      bySourceId.set(`${r.source.type}:${r.source.id}`, i);
    }
    const doi = cleanDoi(r.doi);
    if (doi) {
      byDoi.set(doi, i);
    }
  });

  let added = 0;
  let updated = 0;
  let skipped = 0;
  const newRefs: Reference[] = [];
  const updatedRefs = [...existingRefs];
  let hasUpdates = false;

  for (let ref of incomingRefs) {
    const cleanedDoi = cleanDoi(ref.doi);
    if (ref.doi !== cleanedDoi) {
      ref = { ...ref, doi: cleanedDoi };
    }

    // 1. Check exact source match first: type + id
    let existingIdx = -1;
    const sourceKey = `${ref.source.type}:${ref.source.id}`;
    if (ref.source.id && bySourceId.has(sourceKey)) {
      existingIdx = bySourceId.get(sourceKey)!;
    } else if (cleanedDoi && byDoi.has(cleanedDoi)) {
      existingIdx = byDoi.get(cleanedDoi)!;
    }

    if (existingIdx >= 0) {
      const existing = updatedRefs[existingIdx];
      let targetId = existing.id;
      if (updateIdOnMerge && ref.id) {
        // When updating ID on merge (e.g. Zotero BBT citekey), ensure targetId does not collide
        // with any OTHER existing reference
        existingIds.delete(existing.id);
        targetId = uniqueId(existingIds, ref.id);
        existingIds.add(targetId);
      }

      const merged = mergeReferences(existing, {
        ...ref,
        id: targetId,
      });

      if (referencesEqual(existing, merged)) {
        skipped++;
      } else {
        updatedRefs[existingIdx] = merged;
        hasUpdates = true;
        updated++;
      }
    } else {
      const id = uniqueId(existingIds, ref.id);
      existingIds.add(id);
      ref = { ...ref, id };
      newRefs.push(ref);
      added++;
    }
  }

  return {
    added,
    updated,
    skipped,
    total: incomingRefs.length,
    updatedRefs,
    newRefs,
    hasUpdates,
  };
}

/** Persist reconciled references to `refs.jsonl` unless in dry-run mode. */
export async function persistReconciledReferences(
  path: string,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  if (result.hasUpdates) {
    await writeJsonl(path, result.updatedRefs.concat(result.newRefs));
  } else if (result.newRefs.length > 0) {
    for (const ref of result.newRefs) {
      await appendJsonl(path, ref);
    }
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
  zoteroPath?: string;
  nexusPath: string;
  dryRun: boolean;
  libraryId?: number;
  collection?: string;
  baseAttachmentPath?: string;
  customProfilesDir?: string;
}

/**
 * Parse `extensions.zotero.baseAttachmentPath` from `prefs.js` content.
 */
export function parseBaseAttachmentPath(content: string): string | undefined {
  const match = content.match(
    /^[ \t]*user_pref\s*\(\s*["']extensions\.zotero\.baseAttachmentPath["']\s*,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)\s*;/m,
  );
  if (!match || !match[1]) return undefined;
  const raw = match[1];
  let val: string;
  if (raw.startsWith('"')) {
    try {
      val = JSON.parse(raw);
    } catch {
      val = raw.slice(1, -1);
    }
  } else {
    val = raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  val = val.trim();
  return val ? expandTilde(val) : undefined;
}

/**
 * Discover `extensions.zotero.baseAttachmentPath` from `prefs.js`.
 *
 * Checks:
 *   1. Direct `prefs.js` inside `zoteroPath`
 *   2. Platform profile directories:
 *      - macOS: `~/Library/Application Support/Zotero/Profiles/<profile>/prefs.js`
 *      - Linux: `~/.zotero/zotero/<profile>/prefs.js`
 *      - Windows: `%APPDATA%/Zotero/Zotero/Profiles/<profile>/prefs.js`
 */
export function findZoteroBaseAttachmentPath(
  zoteroPath: string,
  customProfilesDir?: string,
): string | undefined {
  // 1. Direct prefs.js in zoteroPath
  const directPrefs = join(zoteroPath, 'prefs.js');
  if (existsSync(directPrefs)) {
    try {
      const content = readFileSync(directPrefs, 'utf-8');
      const parsed = parseBaseAttachmentPath(content);
      if (parsed) return parsed;
    } catch {
      // Ignore read error and fallback to profiles
    }
  }

  // 2. Profile directories
  const candidateDirs: string[] = [];
  if (customProfilesDir) {
    candidateDirs.push(customProfilesDir);
  } else {
    const home = process.env['HOME'] || homedir();
    if (process.platform === 'darwin') {
      candidateDirs.push(
        join(home, 'Library', 'Application Support', 'Zotero', 'Profiles'),
        join(home, '.zotero', 'zotero'),
      );
    } else if (process.platform === 'linux') {
      candidateDirs.push(
        join(home, '.zotero', 'zotero'),
        join(home, 'Library', 'Application Support', 'Zotero', 'Profiles'),
      );
    } else if (process.platform === 'win32') {
      const appdata = process.env['APPDATA'] || join(home, 'AppData', 'Roaming');
      candidateDirs.push(join(appdata, 'Zotero', 'Zotero', 'Profiles'));
    } else {
      candidateDirs.push(
        join(home, 'Library', 'Application Support', 'Zotero', 'Profiles'),
        join(home, '.zotero', 'zotero'),
      );
    }
  }

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const profilePrefs = join(dir, entry.name, 'prefs.js');
          if (existsSync(profilePrefs)) {
            const content = readFileSync(profilePrefs, 'utf-8');
            const parsed = parseBaseAttachmentPath(content);
            if (parsed) return parsed;
          }
        }
      }
    } catch {
      // Ignore unreadable directory
    }
  }

  return undefined;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/**
 * Robustly parse a Zotero date string into `{ year, month, day }`.
 *
 * Supports:
 *   - ISO 8601: "2017-06-12", "2019-03"
 *   - Slashes / dots: "2020/05/28", "2020.05.28"
 *   - Year-only: "2019", "c. 2020"
 *   - Textual dates: "May 2020", "May 15, 2020", "15 May 2020", "2020 May", "Spring 2021"
 *
 * Avoids returning `NaN` or collapsing valid dates. If no year can be parsed, returns `{ year: 0 }`.
 */
export function parseZoteroDate(raw?: string | null): {
  year: number;
  month?: number;
  day?: number;
} {
  if (!raw || typeof raw !== 'string') return { year: 0 };
  const str = raw.trim();
  if (!str) return { year: 0 };

  // 1. Delimited numeric date starting with 4-digit year: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, YYYY-MM
  const ymdMatch = str.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const monthNum = parseInt(ymdMatch[2], 10);
    const dayNum = ymdMatch[3] ? parseInt(ymdMatch[3], 10) : undefined;
    const month = monthNum >= 1 && monthNum <= 12 ? monthNum : undefined;
    const day = dayNum !== undefined && dayNum >= 1 && dayNum <= 31 ? dayNum : undefined;
    return { year: isNaN(year) ? 0 : year, month, day };
  }

  // 2. Pure 4-digit year
  const yearOnlyMatch = str.match(/^(\d{4})$/);
  if (yearOnlyMatch) {
    const year = parseInt(yearOnlyMatch[1], 10);
    return { year: isNaN(year) ? 0 : year };
  }

  // 3. Textual formats:
  // "Month YYYY" or "Month, YYYY" e.g. "May 2020", "September, 2018"
  const monthYearMatch = str.match(/^([A-Za-z]+)\s*,?\s*(\d{4})$/);
  if (monthYearMatch) {
    const mName = monthYearMatch[1].toLowerCase();
    const year = parseInt(monthYearMatch[2], 10);
    const month = MONTH_NAMES[mName];
    return { year: isNaN(year) ? 0 : year, month };
  }

  // "Month DD, YYYY" or "Month DD YYYY" e.g. "May 15, 2020"
  const monthDayYearMatch = str.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})$/);
  if (monthDayYearMatch) {
    const mName = monthDayYearMatch[1].toLowerCase();
    const dayNum = parseInt(monthDayYearMatch[2], 10);
    const year = parseInt(monthDayYearMatch[3], 10);
    const month = MONTH_NAMES[mName];
    const day = dayNum >= 1 && dayNum <= 31 ? dayNum : undefined;
    return { year: isNaN(year) ? 0 : year, month, day };
  }

  // "DD Month YYYY" e.g. "15 May 2020", "1st May 2020"
  const dayMonthYearMatch = str.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s*,?\s*(\d{4})$/);
  if (dayMonthYearMatch) {
    const dayNum = parseInt(dayMonthYearMatch[1], 10);
    const mName = dayMonthYearMatch[2].toLowerCase();
    const year = parseInt(dayMonthYearMatch[3], 10);
    const month = MONTH_NAMES[mName];
    const day = dayNum >= 1 && dayNum <= 31 ? dayNum : undefined;
    return { year: isNaN(year) ? 0 : year, month, day };
  }

  // "YYYY Month" or "YYYY Month DD" e.g. "2020 May", "2020 May 15"
  const yearMonthDayMatch = str.match(/^(\d{4})\s+([A-Za-z]+)(?:\s+(\d{1,2}))?$/);
  if (yearMonthDayMatch) {
    const year = parseInt(yearMonthDayMatch[1], 10);
    const mName = yearMonthDayMatch[2].toLowerCase();
    const dayNum = yearMonthDayMatch[3] ? parseInt(yearMonthDayMatch[3], 10) : undefined;
    const month = MONTH_NAMES[mName];
    const day = dayNum !== undefined && dayNum >= 1 && dayNum <= 31 ? dayNum : undefined;
    return { year: isNaN(year) ? 0 : year, month, day };
  }

  // 4. Delimited numeric date with year at end: MM/DD/YYYY or DD/MM/YYYY
  const mdyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (mdyMatch) {
    const part1 = parseInt(mdyMatch[1], 10);
    const part2 = parseInt(mdyMatch[2], 10);
    const year = parseInt(mdyMatch[3], 10);
    let month: number | undefined;
    let day: number | undefined;
    if (part1 <= 12 && part2 <= 31) {
      month = part1;
      day = part2;
    } else if (part2 <= 12 && part1 <= 31) {
      month = part2;
      day = part1;
    }
    return { year: isNaN(year) ? 0 : year, month, day };
  }

  // 5. Fallback: find any 4-digit year in the string (e.g. "Spring 2021", "c. 1998")
  const fallbackYear = str.match(/\b(1[89]\d{2}|20\d{2})\b/);
  if (fallbackYear) {
    const year = parseInt(fallbackYear[1], 10);
    let month: number | undefined;
    const words = str.toLowerCase().split(/[\s,.-]+/);
    for (const w of words) {
      if (MONTH_NAMES[w]) {
        month = MONTH_NAMES[w];
        break;
      }
    }
    return { year: isNaN(year) ? 0 : year, month };
  }

  return { year: 0 };
}

/** Row shape from the main Zotero extraction query. */
interface ZoteroRow {
  itemID: number;
  itemKey: string;
  citekey: string;
}

/**
 * Concurrency & Memory Architecture (DESIGN.md §II):
 *
 * We open both SQLite databases (`zotero.sqlite` and `better-bibtex-search.sqlite`)
 * by reading their files from disk into Uint8Array memory buffers via `readFile`,
 * then instantiating pure WebAssembly/JavaScript databases via `sql.js`.
 *
 * This architecture guarantees:
 *   1. Zero native C++ addons (`better-sqlite3`, etc.), adhering strictly to DESIGN.md §II.
 *   2. Pure read-only, lock-free concurrency: because the database runs entirely in WASM
 *      memory, it holds no filesystem file descriptors or POSIX/Windows advisory locks.
 *      Even if Zotero desktop is actively running and modifying the database, `pc import`
 *      will never encounter `SQLITE_BUSY` or `SQLITE_LOCKED`, nor interfere with Zotero.
 *
 * Extracts references from a Zotero SQLite database with Better BibTeX citekeys.
 */
export async function importZotero(opts: ZoteroImportOptions): Promise<ImportResult> {
  const zoteroPath = resolveZoteroPath(opts.zoteroPath);
  const zoteroDbPath = join(zoteroPath, 'zotero.sqlite');
  const bbtDbPath = join(zoteroPath, 'better-bibtex-search.sqlite');

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

  // Discover base attachment path
  const baseAttachmentPath =
    opts.baseAttachmentPath ?? findZoteroBaseAttachmentPath(zoteroPath, opts.customProfilesDir);

  // Open databases read-only via sql.js (reads file into WASM memory — no lock)
  const SQL = await initSqlJs();
  const zoteroBuffer = await readFile(zoteroDbPath);
  const bbtBuffer = await readFile(bbtDbPath);

  const db: Database = new SQL.Database(zoteroBuffer);

  // Attach Better BibTeX database
  // sql.js doesn't support ATTACH, so open separately and query in two phases
  const bbtDb: Database = new SQL.Database(bbtBuffer);

  try {
    return await extractReferences(db, bbtDb, opts, baseAttachmentPath);
  } finally {
    db.close();
    bbtDb.close();
  }
}

async function extractReferences(
  db: Database,
  bbtDb: Database,
  opts: ZoteroImportOptions,
  baseAttachmentPath?: string,
): Promise<ImportResult> {
  const nexus = opts.nexusPath;
  const path = refsPath(nexus);
  const pdfRoot = getPdfRoot(nexus);
  const targetLibraryId = opts.libraryId ?? 1;

  // Query item attachments for application/pdf (excluding deleted items)
  const attachmentMap = new Map<number, string>();
  const hasAttTable = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='itemAttachments'",
  );
  if (hasAttTable.length > 0 && hasAttTable[0].values.length > 0) {
    const attStmt = db.prepare(`
      SELECT ia.parentItemID, ia.path
      FROM itemAttachments ia
      WHERE ia.contentType = 'application/pdf'
        AND ia.itemID NOT IN (SELECT itemID FROM deletedItems)
      ORDER BY ia.itemID ASC
    `);
    while (attStmt.step()) {
      const attRow = attStmt.getAsObject() as { parentItemID: number; path: string };
      if (!attachmentMap.has(attRow.parentItemID) && attRow.path) {
        attachmentMap.set(attRow.parentItemID, attRow.path);
      }
    }
    attStmt.free();
  }

  // Build citekey map from BBT: itemID → citekey
  const citekeyMap = new Map<number, string>();
  let bbtStmt: ReturnType<Database['prepare']>;
  try {
    bbtStmt = bbtDb.prepare('SELECT itemID, citekey FROM citekeys WHERE libraryID = :libraryID');
    bbtStmt.bind({ ':libraryID': targetLibraryId });
  } catch {
    bbtStmt = bbtDb.prepare('SELECT itemID, citekey FROM citekeys');
  }
  while (bbtStmt.step()) {
    const row = bbtStmt.getAsObject() as { itemID: number; citekey: string };
    citekeyMap.set(row.itemID, row.citekey);
  }
  bbtStmt.free();

  // Also read citationKey field directly from zotero.sqlite (Zotero 7 / BBT native field)
  try {
    const ckFieldStmt = db.prepare("SELECT fieldID FROM fields WHERE fieldName = 'citationKey'");
    if (ckFieldStmt.step()) {
      const ckField = ckFieldStmt.getAsObject() as { fieldID: number };
      const ckStmt = db.prepare(`
        SELECT id.itemID, idv.value AS citekey
        FROM itemData id
        JOIN itemDataValues idv ON idv.valueID = id.valueID
        WHERE id.fieldID = :fieldID
      `);
      ckStmt.bind({ ':fieldID': ckField.fieldID });
      while (ckStmt.step()) {
        const r = ckStmt.getAsObject() as { itemID: number; citekey: string };
        if (r.citekey && !citekeyMap.has(r.itemID)) {
          citekeyMap.set(r.itemID, r.citekey.trim());
        }
      }
      ckStmt.free();
    }
    ckFieldStmt.free();
  } catch {
    // citationKey field may not exist in older Zotero schemas
  }

  // If collection filter specified, look up collectionID
  let targetCollectionId: number | undefined;
  if (opts.collection) {
    const collStmt = db.prepare(`
      SELECT collectionID
      FROM collections
      WHERE libraryID = :libraryID AND LOWER(collectionName) = LOWER(:name)
    `);
    collStmt.bind({ ':libraryID': targetLibraryId, ':name': opts.collection.trim() });
    if (collStmt.step()) {
      const res = collStmt.getAsObject() as { collectionID: number };
      targetCollectionId = res.collectionID;
    }
    collStmt.free();
    if (targetCollectionId === undefined) {
      throw new Error(`Zotero collection not found: "${opts.collection}"`);
    }
  }

  // Query main items — exclude non-regular types (attachment=14, note=1, annotation=36)
  // and deleted items, scoped to the targeted library (and optional collection)
  const itemSql =
    targetCollectionId !== undefined
      ? `
    SELECT i.itemID, i.key AS itemKey
    FROM items i
    JOIN collectionItems ci ON ci.itemID = i.itemID
    WHERE i.libraryID = :libraryID
      AND ci.collectionID = :collectionID
      AND i.itemTypeID NOT IN (1, 14, 36)
      AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    ORDER BY i.itemID
  `
      : `
    SELECT i.itemID, i.key AS itemKey
    FROM items i
    WHERE i.libraryID = :libraryID
      AND i.itemTypeID NOT IN (1, 14, 36)
      AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    ORDER BY i.itemID
  `;
  const itemStmt = db.prepare(itemSql);
  const itemBinds: Record<string, number> = { ':libraryID': targetLibraryId };
  if (targetCollectionId !== undefined) {
    itemBinds[':collectionID'] = targetCollectionId;
  }
  itemStmt.bind(itemBinds);

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

  // Prepare tag lookup (excluding collection hierarchies)
  let tagStmt: ReturnType<Database['prepare']> | undefined;
  try {
    tagStmt = db.prepare(`
      SELECT DISTINCT t.name
      FROM itemTags it
      JOIN tags t ON t.tagID = it.tagID
      WHERE it.itemID = :itemID
      ORDER BY t.name
    `);
  } catch {
    tagStmt = undefined;
  }

  const incomingRefs: Reference[] = [];

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
    const published = parseZoteroDate(dateStr);

    const doi = cleanDoi(getField('DOI'));
    const volume = getField('volume') || undefined;
    const issue = getField('issue') || undefined;
    const pages = getField('pages') || undefined;

    // Resolve PDF path
    let pdf_path = '';
    const rawAttPath = attachmentMap.get(row.itemID);
    if (rawAttPath && pdfRoot) {
      let fullPath: string | undefined;
      if (rawAttPath.startsWith('attachments:')) {
        const relPart = rawAttPath.slice('attachments:'.length);
        if (baseAttachmentPath) {
          fullPath = resolve(baseAttachmentPath, relPart);
        }
      } else if (isAbsolute(rawAttPath)) {
        fullPath = resolve(rawAttPath);
      }

      if (fullPath) {
        const absPdfRoot = resolve(pdfRoot);
        const rel = relative(absPdfRoot, fullPath);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
          pdf_path = rel.split('\\').join('/');
        }
      }
    }

    // Extract tags
    let tags: string[] | undefined;
    if (tagStmt) {
      tagStmt.bind({ ':itemID': row.itemID });
      const tagList: string[] = [];
      while (tagStmt.step()) {
        const t = tagStmt.getAsObject() as { name: string };
        if (t.name) {
          tagList.push(t.name);
        }
      }
      tagStmt.reset();
      if (tagList.length > 0) {
        tags = tagList;
      }
    }

    const venue =
      getField('publicationTitle') ||
      getField('proceedingsTitle') ||
      getField('conferenceName') ||
      getField('bookTitle') ||
      '';

    const ref: Reference = {
      id: row.citekey,
      doi,
      title: getField('title'),
      authors,
      abstract: getField('abstractNote'),
      venue,
      volume,
      issue,
      pages,
      published,
      pdf_path,
      source: { type: 'zotero', id: row.itemKey },
      tags,
    };
    incomingRefs.push(ref);
  }

  valueStmt.free();
  authorStmt.free();
  tagStmt?.free();

  const existingRefs = await readJsonl(path, ReferenceSchema);
  const reconciled = reconcileReferences(existingRefs, incomingRefs, { updateIdOnMerge: true });
  await persistReconciledReferences(path, reconciled, opts.dryRun);

  return {
    status: opts.dryRun ? 'dry-run' : 'ok',
    added: reconciled.added,
    updated: reconciled.updated,
    skipped: reconciled.skipped,
    total: rows.length,
  };
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
    .option('--library <id>', 'Zotero library ID to import from (default: 1)')
    .option('--collection <name>', 'Zotero collection name to import from')
    .action(
      async (
        file: string | undefined,
        cmdOpts: {
          format: string;
          dryRun?: boolean;
          zoteroPath?: string;
          library?: string;
          collection?: string;
        },
      ) => {
        if (cmdOpts.format === 'zotero') {
          const zoteroPath = resolveZoteroPath(cmdOpts.zoteroPath);
          const nexus = mustGetNexusPath();
          const libraryId = cmdOpts.library ? parseInt(cmdOpts.library, 10) : 1;
          if (isNaN(libraryId)) {
            throw new Error(`Invalid library ID: ${cmdOpts.library}. Must be an integer.`);
          }

          const result = await importZotero({
            zoteroPath,
            nexusPath: nexus,
            dryRun: cmdOpts.dryRun ?? false,
            libraryId,
            collection: cmdOpts.collection,
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

          // Read and parse import file
          const raw = await readFile(file, 'utf-8');
          const entries: PaperpileEntry[] = JSON.parse(raw);
          const incomingRefs = entries.map((entry) => paperpileToReference(entry, entry.id ?? ''));

          const existingRefs = await readJsonl(path, ReferenceSchema);
          const reconciled = reconcileReferences(existingRefs, incomingRefs, {
            updateIdOnMerge: false,
          });
          await persistReconciledReferences(path, reconciled, cmdOpts.dryRun ?? false);

          const result: ImportResult = {
            status: cmdOpts.dryRun ? 'dry-run' : 'ok',
            added: reconciled.added,
            updated: reconciled.updated,
            skipped: reconciled.skipped,
            total: entries.length,
          };

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
