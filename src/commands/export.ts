/**
 * `pc export` — export references to BibTeX format.
 *
 * Usage:
 *   pc export                    # Export all references to stdout
 *   pc export <id> [<id>...]     # Export specific references
 *   pc export --append file.bib  # Append to an existing file
 */

import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { mustGetNexusPath, refsPath } from '../utils/config.js';
import { readJsonl, findById } from '../storage/jsonl.js';
import { ReferenceSchema } from '../models/reference.js';
import { toBibtexFile } from '../utils/bibtex.js';

export function registerExportCommand(program: Command, _opts: { human: () => boolean }): void {
  program
    .command('export')
    .description('Export references to BibTeX format')
    .argument('[ids...]', 'Reference IDs to export (all if omitted)')
    .option('--append <file>', 'Append output to a file instead of stdout')
    .action(async (ids: string[], cmdOpts: { append?: string }) => {
      const nexus = mustGetNexusPath();
      const allRefs = await readJsonl(refsPath(nexus), ReferenceSchema);

      let refs = allRefs;
      if (ids.length > 0) {
        refs = ids.map((id) => {
          const [, ref] = findById(allRefs, id);
          if (!ref) throw new Error(`Reference not found: ${id}`);
          return ref;
        });
      }

      if (refs.length === 0) {
        console.error('No references to export.');
        return;
      }

      const bibtex = toBibtexFile(refs);

      if (cmdOpts.append) {
        await writeFile(cmdOpts.append, bibtex, { flag: 'a' });
        console.error(`Appended ${refs.length} entries to ${cmdOpts.append}`);
      } else {
        process.stdout.write(bibtex);
      }
    });
}
