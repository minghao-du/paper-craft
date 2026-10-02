/**
 * `pc s2` — Semantic Scholar integration.
 *
 * Subcommands:
 *   pc s2 add <paper-id>     Add a paper by DOI/ArXiv/PMID/S2ID
 *   pc s2 lookup <paper-id>  Look up a paper without adding it
 */

import { Command } from 'commander';
import { mustGetNexusPath, refsPath } from '../../utils/config.js';
import { readJsonl, appendJsonl } from '../../storage/jsonl.js';
import { ReferenceSchema, mergeReferences } from '../../models/reference.js';
import type { Reference } from '../../models/reference.js';
import { lookupPaper, s2PaperToReference, S2ApiError, S2ExitCode } from '../../clients/s2.js';
import { findById } from '../../storage/jsonl.js';
import { output } from '../../utils/output.js';

/** Generate a unique ID that doesn't collide with existing refs. */
function uniqueId(refs: Reference[], baseId: string): string {
  if (findById(refs, baseId)[0] < 0) return baseId;
  for (let i = 2; ; i++) {
    const candidate = `${baseId}-${i}`;
    if (findById(refs, candidate)[0] < 0) return candidate;
  }
}

export function registerS2Command(program: Command, opts: { human: () => boolean }): void {
  const s2 = program
    .command('s2')
    .description('Semantic Scholar integration');

  s2.command('lookup')
    .description('Look up a paper on Semantic Scholar (without adding)')
    .argument('<paper-id>', 'DOI, ArXiv ID, PMID, or S2 paper ID')
    .action(async (paperId: string) => {
      try {
        const paper = await lookupPaper(paperId);
        const ref = s2PaperToReference(paper);
        output(ref, opts.human(), () =>
          [
            `Title:    ${ref.title}`,
            `Authors:  ${ref.authors.map((a) => `${a.first} ${a.last}`).join(', ')}`,
            `Year:     ${ref.published.year}`,
            `Venue:    ${ref.venue}`,
            ref.doi ? `DOI:      ${ref.doi}` : '',
            ref.s2_id ? `S2 ID:    ${ref.s2_id}` : '',
            ref.pmid ? `PMID:     ${ref.pmid}` : '',
            ref.arxiv_id ? `ArXiv:    ${ref.arxiv_id}` : '',
            ref.abstract ? `\nAbstract: ${ref.abstract.slice(0, 300)}...` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (err) {
        if (err instanceof S2ApiError) {
          console.error(`Error: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  s2.command('add')
    .description('Add a paper from Semantic Scholar to your library')
    .argument('<paper-id>', 'DOI, ArXiv ID, PMID, or S2 paper ID')
    .option('-u, --update', 'Update existing reference if found (by DOI or S2 ID)')
    .action(async (paperId: string, cmdOpts: { update?: boolean }) => {
      try {
        const nexus = mustGetNexusPath();
        const path = refsPath(nexus);
        const refs = await readJsonl(path, ReferenceSchema);

        // Fetch from S2
        const paper = await lookupPaper(paperId);
        let ref = s2PaperToReference(paper);

        // Check for duplicates by DOI or S2 ID
        let existingIdx = -1;
        if (ref.doi) {
          existingIdx = refs.findIndex((r) => r.doi === ref.doi);
        }
        if (existingIdx < 0 && ref.s2_id) {
          existingIdx = refs.findIndex((r) => r.s2_id === ref.s2_id);
        }

        if (existingIdx >= 0) {
          if (!cmdOpts.update) {
            const existing = refs[existingIdx];
            throw new S2ApiError(
              `Paper already exists as '${existing.id}'. Use --update to merge.`,
              S2ExitCode.Duplicate,
            );
          }

          // Merge with existing
          const existing = refs[existingIdx];
          ref = mergeReferences(existing, { ...ref, id: existing.id });
          refs[existingIdx] = ref;

          // Rewrite entire file (in-place update)
          const { writeJsonl } = await import('../../storage/jsonl.js');
          await writeJsonl(path, refs);

          output(
            { status: 'updated', ref },
            opts.human(),
            () => `Updated: ${ref.id} — ${ref.title}`,
          );
          return;
        }

        // New paper — generate unique ID and append
        ref = { ...ref, id: uniqueId(refs, ref.id) };
        await appendJsonl(path, ref);

        output(
          { status: 'added', ref },
          opts.human(),
          () => `Added: ${ref.id} — ${ref.title}`,
        );
      } catch (err) {
        if (err instanceof S2ApiError) {
          console.error(`Error: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });
}
