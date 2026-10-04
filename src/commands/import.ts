/**
 * `pc import` — import references from external formats.
 *
 * Currently supports:
 *   - Paperpile JSON export
 *
 * Usage:
 *   pc import --format paperpile export.json
 *   pc import --format paperpile --dry-run export.json
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
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

interface ImportResult {
  status: string;
  added: number;
  updated: number;
  skipped: number;
  total: number;
}

export function registerImportCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('import')
    .description('Import references from external formats')
    .argument('<file>', 'Path to import file')
    .requiredOption('--format <format>', 'Import format (paperpile)')
    .option('--dry-run', 'Show what would be imported without writing')
    .action(async (file: string, cmdOpts: { format: string; dryRun?: boolean }) => {
      if (cmdOpts.format !== 'paperpile') {
        throw new Error(`Unsupported format: ${cmdOpts.format}. Supported: paperpile`);
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
          updatedRefs[existingIdx] = mergeReferences(existing, { ...ref, id: existing.id });
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
        // Write updates if any existing refs were modified
        if (hasUpdates) {
          await writeJsonl(path, updatedRefs.concat(newRefs));
        } else {
          // Just append new refs
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
    });
}
