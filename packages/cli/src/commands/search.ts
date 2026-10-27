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
import { Library } from '@paper-craft/core';
import { mustGetNexusPath } from '@paper-craft/core/utils/config';
import { output } from '../utils/output.js';

export function registerSearchCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('search')
    .description('Search references by keyword (full-text search)')
    .argument('<query>', 'Search query')
    .option('-n, --limit <n>', 'Maximum number of results', '50')
    .action(async (query: string, cmdOpts: { limit: string }) => {
      const nexus = mustGetNexusPath();
      const library = new Library(nexus);
      const limit = parseInt(cmdOpts.limit, 10);

      const results = await library.searchReferences(query, limit);
      output(results, opts.human(), () => {
        if (results.length === 0) return `No results for "${query}".`;
        const lines = results.map((r) => `  ${r.id}\t${r.published.year}\t${r.title.slice(0, 80)}`);
        return `Results for "${query}" (${results.length}):\n${lines.join('\n')}`;
      });
    });
}

export function registerListCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('list')
    .description('List all references')
    .option('-n, --limit <n>', 'Maximum number of results')
    .action(async (cmdOpts: { limit?: string }) => {
      const nexus = mustGetNexusPath();
      const library = new Library(nexus);
      const limit = cmdOpts.limit ? parseInt(cmdOpts.limit, 10) : undefined;

      const { references: refs, total } = await library.listReferences(limit);
      output(refs, opts.human(), () => {
        if (refs.length === 0) return 'No references.';
        const lines = refs.map((r) => `  ${r.id}\t${r.published.year}\t${r.title.slice(0, 80)}`);
        const header =
          limit && total > limit
            ? `References (showing ${refs.length} of ${total}):`
            : `References (${refs.length}):`;
        return `${header}\n${lines.join('\n')}`;
      });
    });
}

export function registerGetCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('get')
    .description('Get a reference by ID')
    .argument('<id>', 'Reference ID')
    .action(async (id: string) => {
      const nexus = mustGetNexusPath();
      const library = new Library(nexus);

      const ref = await library.getReference(id);

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
    });
}
