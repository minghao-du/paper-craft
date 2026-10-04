/**
 * `pc open` — open paper PDFs or URLs.
 *
 * Usage:
 *   pc open <id>              # Open PDF in configured reader
 *   pc open --url <id>        # Print DOI/S2/ArXiv URLs
 *   pc open --copy <id>       # Copy DOI URL to clipboard
 */

import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { mustGetNexusPath, refsPath, loadNexusConfig } from '../utils/config.js';
import { readJsonl, findById } from '../storage/jsonl.js';
import { ReferenceSchema } from '../models/reference.js';
import { output } from '../utils/output.js';

/** Build all available URLs for a reference. */
function buildUrls(ref: { doi: string; pmid?: string; pmcid?: string; arxiv_id?: string; s2_id?: string }) {
  const urls: Record<string, string> = {};
  if (ref.doi) urls['doi'] = `https://doi.org/${ref.doi}`;
  if (ref.pmid) urls['pubmed'] = `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`;
  if (ref.pmcid) urls['pmc'] = `https://www.ncbi.nlm.nih.gov/pmc/articles/${ref.pmcid}/`;
  if (ref.arxiv_id) urls['arxiv'] = `https://arxiv.org/abs/${ref.arxiv_id}`;
  if (ref.s2_id) urls['s2'] = `https://www.semanticscholar.org/paper/${ref.s2_id}`;
  return urls;
}

export function registerOpenCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('open')
    .description('Open paper PDFs or show URLs')
    .argument('<id>', 'Reference ID')
    .option('--url', 'Show URLs instead of opening PDF')
    .option('--copy', 'Copy DOI URL to clipboard')
    .action(async (id: string, cmdOpts: { url?: boolean; copy?: boolean }) => {
      const nexus = mustGetNexusPath();
      const refs = await readJsonl(refsPath(nexus), ReferenceSchema);
      const [, ref] = findById(refs, id);

      if (!ref) throw new Error(`Reference not found: ${id}`);

      // URL mode
      if (cmdOpts.url || cmdOpts.copy) {
        const urls = buildUrls(ref);

        if (cmdOpts.copy && urls['doi']) {
          // Copy to clipboard (macOS)
          await new Promise<void>((resolve, reject) => {
            const proc = execFile('pbcopy', [], (err) => (err ? reject(err) : resolve()));
            proc.stdin?.write(urls['doi']);
            proc.stdin?.end();
          });
          console.error(`Copied: ${urls['doi']}`);
        }

        output(urls, opts.human(), () =>
          Object.entries(urls)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n'),
        );
        return;
      }

      // PDF mode
      if (!ref.pdf_path) {
        throw new Error(`No PDF path for ${id}. Use --url to see web links.`);
      }

      const cfg = loadNexusConfig(nexus);
      const pdfRoot = cfg.pdf_root ?? '';
      const fullPath = pdfRoot ? `${pdfRoot}/${ref.pdf_path}` : ref.pdf_path;

      // Open with system viewer (macOS: open, Linux: xdg-open)
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFile(opener, [fullPath], (err) => {
        if (err) console.error(`Failed to open: ${err.message}`);
      });
    });
}
