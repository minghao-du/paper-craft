/**
 * `pc search` — search references by keyword (full-text search).
 *
 * Uses the SQLite FTS5 index for ranked results. Triggers lazy rebuild
 * if the database is stale.
 *
 * Usage:
 *   pc search "machine learning"
 *   pc search --limit 10 "deep learning"
 */

import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import {
  mustGetNexusPath,
  refsPath,
  projectsPath,
  reposPath,
  cachePath,
  dbPath,
  allJsonlPaths,
} from '../utils/config.js';
import { readJsonl } from '../storage/jsonl.js';
import { PcDatabase, isDbStale } from '../storage/db.js';
import { ReferenceSchema } from '../models/reference.js';
import { ProjectSchema } from '../models/project.js';
import { RepoSchema } from '../models/repo.js';
import { output } from '../utils/output.js';

/**
 * Ensure the database is up-to-date, rebuilding lazily if stale.
 * Returns an open PcDatabase instance. Caller must close it.
 */
async function ensureDb(nexusPath: string): Promise<PcDatabase> {
  const db_path = dbPath(nexusPath);
  const stale = await isDbStale(db_path, allJsonlPaths(nexusPath));

  if (stale) {
    mkdirSync(cachePath(nexusPath), { recursive: true });
    const [refs, projects, repos] = await Promise.all([
      readJsonl(refsPath(nexusPath), ReferenceSchema),
      readJsonl(projectsPath(nexusPath), ProjectSchema),
      readJsonl(reposPath(nexusPath), RepoSchema),
    ]);
    const db = await PcDatabase.open(db_path);
    db.rebuildAll(refs, projects, repos);
    await db.save(db_path);
    return db;
  }

  return PcDatabase.open(db_path);
}

export function registerSearchCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('search')
    .description('Search references by keyword (full-text search)')
    .argument('<query>', 'Search query')
    .option('-n, --limit <n>', 'Maximum number of results', '50')
    .action(async (query: string, cmdOpts: { limit: string }) => {
      const nexus = mustGetNexusPath();
      const db = await ensureDb(nexus);
      const limit = parseInt(cmdOpts.limit, 10);

      try {
        const results = db.searchRefs(query, limit);
        output(results, opts.human(), () => {
          if (results.length === 0) return `No results for "${query}".`;
          const lines = results.map(
            (r) => `  ${r.id}\t${r.published.year}\t${r.title.slice(0, 80)}`,
          );
          return `Results for "${query}" (${results.length}):\n${lines.join('\n')}`;
        });
      } finally {
        db.close();
      }
    });
}

export function registerListCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('list')
    .description('List all references')
    .option('-n, --limit <n>', 'Maximum number of results')
    .action(async (cmdOpts: { limit?: string }) => {
      const nexus = mustGetNexusPath();
      const db = await ensureDb(nexus);
      const limit = cmdOpts.limit ? parseInt(cmdOpts.limit, 10) : undefined;

      try {
        const refs = db.listRefs(limit);
        output(refs, opts.human(), () => {
          if (refs.length === 0) return 'No references.';
          const total = db.countRefs();
          const lines = refs.map(
            (r) => `  ${r.id}\t${r.published.year}\t${r.title.slice(0, 80)}`,
          );
          const header =
            limit && total > limit
              ? `References (showing ${refs.length} of ${total}):`
              : `References (${refs.length}):`;
          return `${header}\n${lines.join('\n')}`;
        });
      } finally {
        db.close();
      }
    });
}

export function registerGetCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('get')
    .description('Get a reference by ID')
    .argument('<id>', 'Reference ID')
    .action(async (id: string) => {
      const nexus = mustGetNexusPath();
      const db = await ensureDb(nexus);

      try {
        const ref = db.getRef(id);
        if (!ref) {
          throw new Error(`Reference not found: ${id}`);
        }

        output(ref, opts.human(), () =>
          [
            `ID:       ${ref.id}`,
            `Title:    ${ref.title}`,
            `Authors:  ${ref.authors.map((a) => `${a.first} ${a.last}`).join(', ')}`,
            `Year:     ${ref.published.year}`,
            `Venue:    ${ref.venue}`,
            ref.doi ? `DOI:      ${ref.doi}` : '',
            ref.s2_id ? `S2 ID:    ${ref.s2_id}` : '',
            ref.pmid ? `PMID:     ${ref.pmid}` : '',
            ref.abstract ? `\nAbstract: ${ref.abstract.slice(0, 200)}...` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } finally {
        db.close();
      }
    });
}
