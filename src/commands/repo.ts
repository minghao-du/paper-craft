/**
 * `pc repo` — manage tracked repositories.
 *
 * Subcommands:
 *   pc repo add <url> --project <id> [--id <id>] [--name <name>] [--description <desc>]
 *   pc repo add --manual --project <id> --name <name> [--id <id>] [--description <desc>]
 *   pc repo get <id>
 *   pc repo list [--project <id>]
 *   pc repo update <id> [--name <name>] [--description <desc>] [--topics <topics>]
 *   pc repo delete <id>
 */

import { Command } from 'commander';
import { mustGetNexusPath, projectsPath, reposPath } from '../utils/config.js';
import { readJsonl, writeJsonl, appendJsonl, findById } from '../storage/jsonl.js';
import { ProjectSchema } from '../models/project.js';
import { RepoSchema, RepoType, type Repo } from '../models/repo.js';
import { output } from '../utils/output.js';

/** Extract owner/repo from a GitHub URL. */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Handle https://github.com/owner/repo(.git)
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** Generate a repo ID from a GitHub URL or name. */
function generateRepoId(url: string, name?: string): string {
  if (name) return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const parsed = parseGitHubUrl(url);
  if (parsed) return parsed.repo.toLowerCase();
  return url.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export function registerRepoCommand(program: Command, opts: { human: () => boolean }): void {
  const repo = program
    .command('repo')
    .description('Manage tracked repositories');

  repo
    .command('add')
    .description('Add a repository to a project')
    .argument('[url]', 'GitHub URL of the repository')
    .requiredOption('-p, --project <id>', 'Project ID this repo belongs to')
    .option('--id <id>', 'Override the auto-generated repo ID')
    .option('--manual', 'Add a manually tracked repo (no GitHub URL)')
    .option('-n, --name <name>', 'Display name (defaults to GitHub repo name)')
    .option('-d, --description <desc>', 'Description')
    .option('--topics <topics>', 'Comma-separated topic tags')
    .action(
      async (
        url: string | undefined,
        cmdOpts: {
          project: string;
          id?: string;
          manual?: boolean;
          name?: string;
          description?: string;
          topics?: string;
        },
      ) => {
        const nexus = mustGetNexusPath();

        // Validate: need url or --manual
        if (!url && !cmdOpts.manual) {
          throw new Error('Provide a GitHub URL, or use --manual for a manually tracked repo.');
        }
        if (cmdOpts.manual && !cmdOpts.name) {
          throw new Error('--name is required for manual repos.');
        }

        // Verify project exists
        const projects = await readJsonl(projectsPath(nexus), ProjectSchema);
        const [, project] = findById(projects, cmdOpts.project);
        if (!project) {
          throw new Error(`Project not found: ${cmdOpts.project}`);
        }

        const rPath = reposPath(nexus);
        const repos = await readJsonl(rPath, RepoSchema);

        // Check for duplicate GitHub URL
        if (url) {
          const existing = repos.find((r) => r.github_url === url);
          if (existing) {
            throw new Error(`Repo with this GitHub URL already exists: ${existing.id}`);
          }
        }

        const id = cmdOpts.id ?? generateRepoId(url ?? cmdOpts.name ?? '', cmdOpts.name);

        // Check for duplicate ID
        const [idx] = findById(repos, id);
        if (idx >= 0) {
          throw new Error(`Repo with id '${id}' already exists`);
        }

        const now = new Date().toISOString();
        const newRepo: Repo = RepoSchema.parse({
          id,
          project: cmdOpts.project,
          type: cmdOpts.manual ? RepoType.Manual : RepoType.GitHub,
          name: cmdOpts.name ?? parseGitHubUrl(url ?? '')?.repo ?? id,
          github_url: url,
          description: cmdOpts.description,
          topics: cmdOpts.topics?.split(',').map((t) => t.trim()),
          created_at: now,
          updated_at: now,
        });

        await appendJsonl(rPath, newRepo);
        output(newRepo, opts.human(), () => `Added repo: ${newRepo.name} (${newRepo.id})`);
      },
    );

  repo
    .command('get')
    .description('Get a repo by ID')
    .argument('<id>', 'Repo ID')
    .action(async (id: string) => {
      const nexus = mustGetNexusPath();
      const repos = await readJsonl(reposPath(nexus), RepoSchema);
      const [, r] = findById(repos, id);

      if (!r) {
        throw new Error(`Repo not found: ${id}`);
      }

      output(r, opts.human(), () =>
        [
          `ID:          ${r.id}`,
          `Project:     ${r.project}`,
          `Type:        ${r.type}`,
          `Name:        ${r.name}`,
          r.github_url ? `GitHub URL:  ${r.github_url}` : '',
          r.description ? `Description: ${r.description}` : '',
          r.topics?.length ? `Topics:      ${r.topics.join(', ')}` : '',
          r.language ? `Language:    ${r.language}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    });

  repo
    .command('list')
    .description('List tracked repos')
    .option('-p, --project <id>', 'Filter by project ID')
    .action(async (cmdOpts: { project?: string }) => {
      const nexus = mustGetNexusPath();
      let repos = await readJsonl(reposPath(nexus), RepoSchema);

      if (cmdOpts.project) {
        repos = repos.filter((r) => r.project === cmdOpts.project);
      }

      output(repos, opts.human(), () => {
        if (repos.length === 0) return 'No repos.';
        const lines = repos.map((r) => `  ${r.id}\t${r.project}\t${r.type}\t${r.name}`);
        return `Repos (${repos.length}):\n${lines.join('\n')}`;
      });
    });

  repo
    .command('update')
    .description('Update a repo')
    .argument('<id>', 'Repo ID')
    .option('-n, --name <name>', 'New display name')
    .option('-d, --description <desc>', 'New description')
    .option('--topics <topics>', 'New comma-separated topic tags')
    .action(
      async (id: string, cmdOpts: { name?: string; description?: string; topics?: string }) => {
        if (!cmdOpts.name && cmdOpts.description === undefined && cmdOpts.topics === undefined) {
          throw new Error('Nothing to update. Specify --name, --description, or --topics.');
        }

        const nexus = mustGetNexusPath();
        const rPath = reposPath(nexus);
        const repos = await readJsonl(rPath, RepoSchema);
        const [idx, existing] = findById(repos, id);

        if (idx < 0 || !existing) {
          throw new Error(`Repo not found: ${id}`);
        }

        const updated: Repo = {
          ...existing,
          name: cmdOpts.name ?? existing.name,
          description: cmdOpts.description ?? existing.description,
          topics: cmdOpts.topics ? cmdOpts.topics.split(',').map((t) => t.trim()) : existing.topics,
          updated_at: new Date().toISOString(),
        };

        repos[idx] = updated;
        await writeJsonl(rPath, repos);
        output(updated, opts.human(), () => `Updated repo: ${updated.name} (${updated.id})`);
      },
    );

  repo
    .command('delete')
    .description('Delete a tracked repo')
    .argument('<id>', 'Repo ID')
    .action(async (id: string) => {
      const nexus = mustGetNexusPath();
      const rPath = reposPath(nexus);
      const repos = await readJsonl(rPath, RepoSchema);
      const [idx] = findById(repos, id);

      if (idx < 0) {
        throw new Error(`Repo not found: ${id}`);
      }

      repos.splice(idx, 1);
      await writeJsonl(rPath, repos);

      output({ status: 'deleted', id }, opts.human(), () => `Deleted repo: ${id}`);
    });
}
