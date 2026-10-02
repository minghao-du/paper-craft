/**
 * `pc rebuild` — rebuild the SQLite query layer from JSONL source files.
 *
 * Usage:
 *   pc rebuild    # Rebuild refs, projects, repos from JSONL
 *
 * Use after pulling git changes or if the database becomes corrupted.
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
} from '../utils/config.js';
import { readJsonl } from '../storage/jsonl.js';
import { PcDatabase } from '../storage/db.js';
import { ReferenceSchema } from '../models/reference.js';
import { ProjectSchema } from '../models/project.js';
import { RepoSchema } from '../models/repo.js';
import { output } from '../utils/output.js';

export function registerRebuildCommand(program: Command, opts: { human: () => boolean }): void {
  program
    .command('rebuild')
    .description('Rebuild the query layer from JSONL source files')
    .action(async () => {
      const nexusPath = mustGetNexusPath();

      // Ensure cache directory exists
      mkdirSync(cachePath(nexusPath), { recursive: true });

      // Read all JSONL sources
      const [refs, projects, repos] = await Promise.all([
        readJsonl(refsPath(nexusPath), ReferenceSchema),
        readJsonl(projectsPath(nexusPath), ProjectSchema),
        readJsonl(reposPath(nexusPath), RepoSchema),
      ]);

      // Open DB, rebuild, save
      const db = await PcDatabase.open(dbPath(nexusPath));
      const result = db.rebuildAll(refs, projects, repos);
      await db.save(dbPath(nexusPath));
      db.close();

      output(result, opts.human(), () =>
        `Rebuilt: ${result.references} references, ${result.projects} projects, ${result.repos} repos`,
      );
    });
}
