/**
 * `pc dedupe` — find and resolve duplicate references.
 *
 * Detects duplicates by:
 *   1. Source ID (same importer + same external ID)
 *   2. DOI match
 *   3. Title similarity (reports for manual review)
 *
 * Usage:
 *   pc dedupe --dry-run     # Show duplicates without modifying
 *   pc dedupe --merge       # Merge duplicates (keeps first, merges fields)
 */

import { Command } from 'commander';
import { mustGetNexusPath, refsPath } from '../utils/config.js';
import { readJsonl, writeJsonl } from '../storage/jsonl.js';
import { ReferenceSchema, mergeReferences } from '../models/reference.js';
import type { Reference } from '../models/reference.js';
import { output } from '../utils/output.js';

interface DuplicateGroup {
  reason: string;
  key: string;
  refs: string[]; // IDs
}

/** Normalize a title for fuzzy comparison. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find all duplicate groups in a set of references. */
function findDuplicates(refs: Reference[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  // 1. Source ID duplicates
  const bySourceId = new Map<string, number[]>();
  refs.forEach((r, i) => {
    if (r.source.id) {
      const key = `${r.source.type}:${r.source.id}`;
      const list = bySourceId.get(key) ?? [];
      list.push(i);
      bySourceId.set(key, list);
    }
  });
  for (const [key, indices] of bySourceId) {
    if (indices.length > 1) {
      groups.push({
        reason: 'source_id',
        key,
        refs: indices.map((i) => refs[i].id),
      });
    }
  }

  // 2. DOI duplicates (skip if already caught by source ID)
  const byDoi = new Map<string, number[]>();
  refs.forEach((r, i) => {
    if (r.doi) {
      const list = byDoi.get(r.doi) ?? [];
      list.push(i);
      byDoi.set(r.doi, list);
    }
  });
  const alreadyCovered = new Set(groups.flatMap((g) => g.refs));
  for (const [doi, indices] of byDoi) {
    if (indices.length > 1) {
      const ids = indices.map((i) => refs[i].id);
      if (!ids.every((id) => alreadyCovered.has(id))) {
        groups.push({ reason: 'doi', key: doi, refs: ids });
      }
    }
  }

  // 3. Title similarity (exact normalized match only)
  const byTitle = new Map<string, number[]>();
  refs.forEach((r, i) => {
    const norm = normalizeTitle(r.title);
    if (norm.length > 10) {
      // Skip very short titles
      const list = byTitle.get(norm) ?? [];
      list.push(i);
      byTitle.set(norm, list);
    }
  });
  const covered2 = new Set(groups.flatMap((g) => g.refs));
  for (const [title, indices] of byTitle) {
    if (indices.length > 1) {
      const ids = indices.map((i) => refs[i].id);
      if (!ids.every((id) => covered2.has(id))) {
        groups.push({ reason: 'title', key: title.slice(0, 60), refs: ids });
      }
    }
  }

  return groups;
}

export function registerDedupeCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('dedupe')
    .description('Find and resolve duplicate references')
    .option('--dry-run', 'Show duplicates without modifying')
    .option('--merge', 'Merge duplicates (keeps first occurrence, merges fields)')
    .action(async (cmdOpts: { dryRun?: boolean; merge?: boolean }) => {
      if (!cmdOpts.dryRun && !cmdOpts.merge) {
        throw new Error('Specify --dry-run to preview or --merge to resolve duplicates.');
      }

      const nexus = mustGetNexusPath();
      const path = refsPath(nexus);
      const refs = await readJsonl(path, ReferenceSchema);
      const groups = findDuplicates(refs);

      if (groups.length === 0) {
        output(
          { status: 'clean', duplicates: 0 },
          opts.human(),
          () => 'No duplicates found.',
        );
        return;
      }

      if (cmdOpts.dryRun) {
        output(groups, opts.human(), () => {
          const lines = groups.map(
            (g) => `  [${g.reason}] ${g.key}: ${g.refs.join(', ')}`,
          );
          return `Found ${groups.length} duplicate group(s):\n${lines.join('\n')}`;
        });
        return;
      }

      // Merge: for each group, merge all into the first and remove the rest
      const toRemove = new Set<string>();
      for (const group of groups) {
        const primary = refs.find((r) => r.id === group.refs[0])!;
        let merged = primary;
        for (let i = 1; i < group.refs.length; i++) {
          const dup = refs.find((r) => r.id === group.refs[i])!;
          merged = mergeReferences(merged, dup);
          merged = { ...merged, id: primary.id, source: primary.source };
          toRemove.add(group.refs[i]);
        }
        // Update the primary in-place
        const idx = refs.findIndex((r) => r.id === primary.id);
        refs[idx] = merged;
      }

      const cleaned = refs.filter((r) => !toRemove.has(r.id));
      await writeJsonl(path, cleaned);

      const result = {
        status: 'merged',
        groups: groups.length,
        removed: toRemove.size,
        remaining: cleaned.length,
      };
      output(result, opts.human(), () =>
        `Merged ${groups.length} group(s), removed ${toRemove.size} duplicate(s). ${cleaned.length} references remaining.`,
      );
    });
}
