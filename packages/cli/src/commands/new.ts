/**
 * `pc new` — list recently added papers.
 * `pc diff` — show papers added/removed since last commit.
 *
 * Usage:
 *   pc new --days 7           # Papers added in the last 7 days
 *   pc new --since abc123     # Papers added since a commit
 *   pc diff                   # Papers added/removed vs HEAD
 */

import { Command } from 'commander';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mustGetNexusPath, refsPath } from '@paper-craft/core/utils/config';
import { readJsonl } from '@paper-craft/core/storage/jsonl';
import { ReferenceSchema } from '@paper-craft/core/models/reference';
import type { Reference } from '@paper-craft/core/models/reference';
import { output } from '../utils/output.js';

const execFileAsync = promisify(execFileCb);

/** Get refs.jsonl content at a specific git commit. */
async function refsAtCommit(nexusPath: string, commit: string): Promise<Reference[]> {
  const relPath = '.paper-craft/refs.jsonl';
  try {
    const { stdout } = await execFileAsync('git', ['show', `${commit}:${relPath}`], {
      cwd: nexusPath,
    });
    const lines = stdout.split('\n');
    const refs: Reference[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const result = ReferenceSchema.safeParse(JSON.parse(line));
      if (result.success) refs.push(result.data);
    }
    return refs;
  } catch {
    return []; // File doesn't exist at that commit
  }
}

export function registerNewCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('new')
    .description('List recently added papers')
    .option('--days <n>', 'Papers added within N days')
    .option('--since <commit>', 'Papers added since a git commit')
    .action(async (cmdOpts: { days?: string; since?: string }) => {
      if (!cmdOpts.days && !cmdOpts.since) {
        throw new Error('Specify --days <n> or --since <commit>.');
      }

      const nexus = mustGetNexusPath();
      const currentRefs = await readJsonl(refsPath(nexus), ReferenceSchema);

      let oldRefs: Reference[];
      if (cmdOpts.since) {
        oldRefs = await refsAtCommit(nexus, cmdOpts.since);
      } else {
        // Use git log to find commit from N days ago
        const days = parseInt(cmdOpts.days!, 10);
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['log', `--since=${days} days ago`, '--format=%H', '-1'],
            { cwd: nexus },
          );
          const commit = stdout.trim();
          oldRefs = commit ? await refsAtCommit(nexus, commit) : [];
        } catch {
          oldRefs = [];
        }
      }

      const oldIds = new Set(oldRefs.map((r) => r.id));
      const newRefs = currentRefs.filter((r) => !oldIds.has(r.id));

      output(newRefs, opts.human(), () => {
        if (newRefs.length === 0) return 'No new papers.';
        const lines = newRefs.map(
          (r) => `  ${r.id}\t${r.published.year}\t${r.title.slice(0, 70)}`,
        );
        return `New papers (${newRefs.length}):\n${lines.join('\n')}`;
      });
    });
}

export function registerDiffCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('diff')
    .description('Show papers added/removed since last commit')
    .action(async () => {
      const nexus = mustGetNexusPath();
      const currentRefs = await readJsonl(refsPath(nexus), ReferenceSchema);
      const headRefs = await refsAtCommit(nexus, 'HEAD');

      const currentIds = new Set(currentRefs.map((r) => r.id));
      const headIds = new Set(headRefs.map((r) => r.id));

      const added = currentRefs.filter((r) => !headIds.has(r.id));
      const removed = headRefs.filter((r) => !currentIds.has(r.id));

      const result = {
        added: added.map((r) => ({ id: r.id, title: r.title })),
        removed: removed.map((r) => ({ id: r.id, title: r.title })),
      };

      output(result, opts.human(), () => {
        const lines: string[] = [];
        if (added.length > 0) {
          lines.push(`Added (${added.length}):`);
          added.forEach((r) => lines.push(`  + ${r.id}\t${r.title.slice(0, 70)}`));
        }
        if (removed.length > 0) {
          lines.push(`Removed (${removed.length}):`);
          removed.forEach((r) => lines.push(`  - ${r.id}\t${r.title.slice(0, 70)}`));
        }
        if (lines.length === 0) lines.push('No changes since last commit.');
        return lines.join('\n');
      });
    });
}
