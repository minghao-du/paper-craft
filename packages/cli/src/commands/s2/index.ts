import { Command } from 'commander';
import { mustGetNexusPath, refsPath } from '@paper-craft/core/utils/config';
import { readJsonl, appendJsonl } from '@paper-craft/core/storage/jsonl';
import { ReferenceSchema, mergeReferences } from '@paper-craft/core/models/reference';
import type { Reference } from '@paper-craft/core/models/reference';
import {
  lookupPaper,
  s2PaperToReference,
  S2ApiError,
  S2ExitCode,
  fetchCitations,
  fetchReferences,
} from '@paper-craft/core/clients/s2';
import { findById } from '@paper-craft/core/storage/jsonl';
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

          const existing = refs[existingIdx];
          ref = mergeReferences(existing, { ...ref, id: existing.id });
          refs[existingIdx] = ref;

          const { writeJsonl } = await import('@paper-craft/core/storage/jsonl');
          await writeJsonl(path, refs);

          output(
            { status: 'updated', ref },
            opts.human(),
            () => `Updated: ${ref.id} — ${ref.title}`,
          );
          return;
        }

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

  s2.command('citations')
    .description('Find papers that cite a given paper (forward citations)')
    .argument('<paper-id>', 'DOI, ArXiv ID, PMID, or S2 paper ID')
    .option('-n, --limit <n>', 'Maximum number of results', '20')
    .option('--local-only', 'Only show citations already in your library')
    .action(async (paperId: string, cmdOpts: { limit: string; localOnly?: boolean }) => {
      try {
        const limit = parseInt(cmdOpts.limit, 10);
        const papers = await fetchCitations(paperId, limit);

        let results = papers.map(s2PaperToReference);

        if (cmdOpts.localOnly) {
          const nexus = mustGetNexusPath();
          const refs = await readJsonl(refsPath(nexus), ReferenceSchema);
          const localDois = new Set(refs.map((r) => r.doi).filter(Boolean));
          const localS2Ids = new Set(refs.map((r) => r.s2_id).filter(Boolean));
          results = results.filter((r) => localDois.has(r.doi) || localS2Ids.has(r.s2_id));
        }

        output(results, opts.human(), () => {
          if (results.length === 0) return 'No citations found.';
          const lines = results.map(
            (r) => `  ${r.published.year}\t${r.authors[0]?.last ?? '?'}\t${r.title.slice(0, 70)}`,
          );
          return `Citations (${results.length}):\n${lines.join('\n')}`;
        });
      } catch (err) {
        if (err instanceof S2ApiError) {
          console.error(`Error: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  s2.command('references')
    .description('Find papers referenced by a given paper (backward references)')
    .argument('<paper-id>', 'DOI, ArXiv ID, PMID, or S2 paper ID')
    .option('-n, --limit <n>', 'Maximum number of results', '50')
    .option('--missing', 'Only show references NOT in your library')
    .action(async (paperId: string, cmdOpts: { limit: string; missing?: boolean }) => {
      try {
        const limit = parseInt(cmdOpts.limit, 10);
        const papers = await fetchReferences(paperId, limit);

        let results = papers.map(s2PaperToReference);

        if (cmdOpts.missing) {
          const nexus = mustGetNexusPath();
          const refs = await readJsonl(refsPath(nexus), ReferenceSchema);
          const localDois = new Set(refs.map((r) => r.doi).filter(Boolean));
          const localS2Ids = new Set(refs.map((r) => r.s2_id).filter(Boolean));
          results = results.filter((r) => !localDois.has(r.doi) && !localS2Ids.has(r.s2_id));
        }

        output(results, opts.human(), () => {
          if (results.length === 0) return 'No references found.';
          const lines = results.map(
            (r) => `  ${r.published.year}\t${r.authors[0]?.last ?? '?'}\t${r.title.slice(0, 70)}`,
          );
          return `References (${results.length}):\n${lines.join('\n')}`;
        });
      } catch (err) {
        if (err instanceof S2ApiError) {
          console.error(`Error: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  s2.command('gaps')
    .description('Find highly-cited papers NOT in your library')
    .option('-n, --limit <n>', 'Maximum papers to scan per reference', '20')
    .option('-m, --min-citations <n>', 'Minimum citation count to report', '5')
    .action(async (cmdOpts: { limit: string; minCitations: string }) => {
      try {
        const nexus = mustGetNexusPath();
        const refs = await readJsonl(refsPath(nexus), ReferenceSchema);

        if (refs.length === 0) {
          output([], opts.human(), () => 'No references in library. Add papers first.');
          return;
        }

        const localDois = new Set(refs.map((r) => r.doi).filter(Boolean));
        const localS2Ids = new Set(refs.map((r) => r.s2_id).filter(Boolean));
        const limit = parseInt(cmdOpts.limit, 10);

        // Collect referenced papers across all library entries that have S2 IDs
        const refsWithS2 = refs.filter((r) => r.s2_id);
        const citationCount = new Map<string, { count: number; ref: Reference }>();

        // Sample up to 10 library papers to avoid API rate limits
        const sample = refsWithS2.slice(0, 10);
        for (const libRef of sample) {
          try {
            const referenced = await fetchReferences(libRef.s2_id!, limit);
            for (const paper of referenced) {
              const ref = s2PaperToReference(paper);
              // Skip if already in library
              if (localDois.has(ref.doi) || localS2Ids.has(ref.s2_id ?? '')) continue;

              const key = ref.doi || ref.s2_id || ref.title;
              const existing = citationCount.get(key);
              if (existing) {
                existing.count++;
              } else {
                citationCount.set(key, { count: 1, ref });
              }
            }
          } catch {
            // Skip API errors for individual papers
          }
        }

        // Sort by citation frequency and filter
        const minCitations = parseInt(cmdOpts.minCitations, 10);
        const gaps = [...citationCount.values()]
          .filter((g) => g.count >= minCitations)
          .sort((a, b) => b.count - a.count)
          .slice(0, 50);

        const gapResults = gaps.map((g) => ({
          ...g.ref,
          _referenced_by: g.count,
        }));

        output(gapResults, opts.human(), () => {
          if (gaps.length === 0) return 'No literature gaps found.';
          const lines = gaps.map(
            (g) =>
              `  [${g.count}x] ${g.ref.published.year}\t${g.ref.authors[0]?.last ?? '?'}\t${g.ref.title.slice(0, 60)}`,
          );
          return `Literature gaps (referenced by ${minCitations}+ of your papers):\n${lines.join('\n')}`;
        });
      } catch (err) {
        if (err instanceof S2ApiError) {
          console.error(`Error: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });
}
