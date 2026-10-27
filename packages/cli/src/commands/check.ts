/**
 * `pc check` — verify repository integrity.
 *
 * Checks:
 *   - Missing PDFs (pdf_path set but file not found)
 *   - Duplicate DOIs
 *   - References with missing required fields
 *
 * Usage:
 *   pc check
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mustGetNexusPath, refsPath, loadNexusConfig } from '@paper-craft/core/utils/config';
import { readJsonl } from '@paper-craft/core/storage/jsonl';
import { ReferenceSchema } from '@paper-craft/core/models/reference';
import { output } from '../utils/output.js';

interface CheckResult {
  status: string;
  references: number;
  issues: Array<{ type: string; id: string; detail: string }>;
}

export function registerCheckCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('check')
    .description('Verify repository integrity')
    .action(async () => {
      const nexus = mustGetNexusPath();
      const refs = await readJsonl(refsPath(nexus), ReferenceSchema);
      const cfg = loadNexusConfig(nexus);
      const pdfRoot = cfg.pdf_root ?? '';

      const issues: CheckResult['issues'] = [];

      // Check for missing PDFs
      for (const ref of refs) {
        if (ref.pdf_path) {
          const fullPath = pdfRoot ? join(pdfRoot, ref.pdf_path) : ref.pdf_path;
          if (!existsSync(fullPath)) {
            issues.push({ type: 'missing_pdf', id: ref.id, detail: ref.pdf_path });
          }
        }
      }

      // Check for duplicate DOIs
      const doiMap = new Map<string, string[]>();
      for (const ref of refs) {
        if (ref.doi) {
          const list = doiMap.get(ref.doi) ?? [];
          list.push(ref.id);
          doiMap.set(ref.doi, list);
        }
      }
      for (const [doi, ids] of doiMap) {
        if (ids.length > 1) {
          issues.push({ type: 'duplicate_doi', id: ids.join(', '), detail: doi });
        }
      }

      // Check for missing titles
      for (const ref of refs) {
        if (!ref.title) {
          issues.push({ type: 'missing_title', id: ref.id, detail: 'No title' });
        }
      }

      const result: CheckResult = {
        status: issues.length === 0 ? 'ok' : 'issues_found',
        references: refs.length,
        issues,
      };

      output(result, opts.human(), () => {
        const lines = [`Checked ${refs.length} references.`];
        if (issues.length === 0) {
          lines.push('No issues found. ✓');
        } else {
          lines.push(`Found ${issues.length} issue(s):`);
          for (const issue of issues) {
            lines.push(`  [${issue.type}] ${issue.id}: ${issue.detail}`);
          }
        }
        return lines.join('\n');
      });
    });
}
