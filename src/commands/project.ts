/**
 * `pc project` — manage research projects.
 *
 * Subcommands:
 *   pc project add <id> --name <name> [--description <desc>]
 *   pc project get <id>
 *   pc project list
 *   pc project update <id> [--name <name>] [--description <desc>]
 *   pc project delete <id> [--force]
 *   pc project repos <id>
 */

import { Command } from 'commander';
import { mustGetNexusPath, projectsPath, reposPath } from '../utils/config.js';
import { readJsonl, writeJsonl, appendJsonl, findById } from '../storage/jsonl.js';
import { ProjectSchema, type Project } from '../models/project.js';
import { RepoSchema } from '../models/repo.js';
import { output } from '../utils/output.js';

export function registerProjectCommand(program: Command, opts: { human: () => boolean }): void {
  const proj = program
    .command('project')
    .description('Manage research projects');

  proj
    .command('add')
    .description('Create a new project')
    .argument('<id>', 'Unique project identifier (lowercase alphanumeric, hyphens, underscores)')
    .requiredOption('-n, --name <name>', 'Human-readable display name')
    .option('-d, --description <desc>', 'Project description')
    .action(async (id: string, cmdOpts: { name: string; description?: string }) => {
      const nexus = mustGetNexusPath();
      const path = projectsPath(nexus);
      const projects = await readJsonl(path, ProjectSchema);

      // Check for duplicate
      const [idx] = findById(projects, id);
      if (idx >= 0) {
        throw new Error(`Project with id '${id}' already exists`);
      }

      const now = new Date().toISOString();
      const project: Project = ProjectSchema.parse({
        id,
        name: cmdOpts.name,
        description: cmdOpts.description,
        created_at: now,
        updated_at: now,
      });

      await appendJsonl(path, project);
      output(project, opts.human(), () => `Created project: ${project.name} (${project.id})`);
    });

  proj
    .command('get')
    .description('Get a project by ID')
    .argument('<id>', 'Project ID')
    .action(async (id: string) => {
      const nexus = mustGetNexusPath();
      const projects = await readJsonl(projectsPath(nexus), ProjectSchema);
      const [, project] = findById(projects, id);

      if (!project) {
        throw new Error(`Project not found: ${id}`);
      }

      output(project, opts.human(), () =>
        [
          `ID:          ${project.id}`,
          `Name:        ${project.name}`,
          project.description ? `Description: ${project.description}` : '',
          project.created_at ? `Created:     ${project.created_at}` : '',
          project.updated_at ? `Updated:     ${project.updated_at}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    });

  proj
    .command('list')
    .description('List all projects')
    .action(async () => {
      const nexus = mustGetNexusPath();
      const projects = await readJsonl(projectsPath(nexus), ProjectSchema);

      output(projects, opts.human(), () => {
        if (projects.length === 0) return 'No projects.';
        const lines = projects.map((p) => `  ${p.id}\t${p.name}`);
        return `Projects (${projects.length}):\n${lines.join('\n')}`;
      });
    });

  proj
    .command('update')
    .description('Update a project')
    .argument('<id>', 'Project ID')
    .option('-n, --name <name>', 'New display name')
    .option('-d, --description <desc>', 'New description')
    .action(async (id: string, cmdOpts: { name?: string; description?: string }) => {
      if (!cmdOpts.name && cmdOpts.description === undefined) {
        throw new Error('Nothing to update. Specify --name or --description.');
      }

      const nexus = mustGetNexusPath();
      const path = projectsPath(nexus);
      const projects = await readJsonl(path, ProjectSchema);
      const [idx, existing] = findById(projects, id);

      if (idx < 0 || !existing) {
        throw new Error(`Project not found: ${id}`);
      }

      const updated: Project = {
        ...existing,
        name: cmdOpts.name ?? existing.name,
        description: cmdOpts.description ?? existing.description,
        updated_at: new Date().toISOString(),
      };

      projects[idx] = updated;
      await writeJsonl(path, projects);
      output(updated, opts.human(), () => `Updated project: ${updated.name} (${updated.id})`);
    });

  proj
    .command('delete')
    .description('Delete a project')
    .argument('<id>', 'Project ID')
    .option('-f, --force', 'Also delete all repos belonging to this project')
    .action(async (id: string, cmdOpts: { force?: boolean }) => {
      const nexus = mustGetNexusPath();
      const projPath = projectsPath(nexus);
      const projects = await readJsonl(projPath, ProjectSchema);
      const [idx] = findById(projects, id);

      if (idx < 0) {
        throw new Error(`Project not found: ${id}`);
      }

      // Check for associated repos
      const rPath = reposPath(nexus);
      const repos = await readJsonl(rPath, RepoSchema);
      const associatedRepos = repos.filter((r) => r.project === id);

      if (associatedRepos.length > 0 && !cmdOpts.force) {
        throw new Error(
          `Project '${id}' has ${associatedRepos.length} associated repo(s). ` +
            `Use --force to delete the project and its repos.`,
        );
      }

      // Delete project
      projects.splice(idx, 1);
      await writeJsonl(projPath, projects);

      // Cascade delete repos if --force
      let deletedRepos = 0;
      if (associatedRepos.length > 0) {
        const remaining = repos.filter((r) => r.project !== id);
        await writeJsonl(rPath, remaining);
        deletedRepos = associatedRepos.length;
      }

      const result = { status: 'deleted', id, repos_deleted: deletedRepos };
      output(result, opts.human(), () => {
        const msg = `Deleted project: ${id}`;
        return deletedRepos > 0 ? `${msg} (and ${deletedRepos} repo(s))` : msg;
      });
    });

  proj
    .command('repos')
    .description('List repos belonging to a project')
    .argument('<id>', 'Project ID')
    .action(async (id: string) => {
      const nexus = mustGetNexusPath();

      // Verify project exists
      const projects = await readJsonl(projectsPath(nexus), ProjectSchema);
      const [, project] = findById(projects, id);
      if (!project) {
        throw new Error(`Project not found: ${id}`);
      }

      const repos = await readJsonl(reposPath(nexus), RepoSchema);
      const projectRepos = repos.filter((r) => r.project === id);

      output(projectRepos, opts.human(), () => {
        if (projectRepos.length === 0) return `No repos in project '${id}'.`;
        const lines = projectRepos.map((r) => `  ${r.id}\t${r.type}\t${r.name}`);
        return `Repos in '${id}' (${projectRepos.length}):\n${lines.join('\n')}`;
      });
    });
}
