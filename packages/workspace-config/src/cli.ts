#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  type SavedWorkspaceConfig,
} from './config.js';
import {
  prepareWorkspaceConfigInitialization,
  saveWorkspaceConfigInitialization,
  type WorkspaceConfigInitPreparation,
} from './initialization.js';

const options = {
  'repo-dir': { type: 'string' as const },
  'delivery-target': { type: 'string' as const },
  'base-remote': { type: 'string' as const },
  'push-remote': { type: 'string' as const },
  'base-branch': { type: 'string' as const },
  'worktree-container': { type: 'string' as const },
  workflow: { type: 'string' as const },
  'delivery-attempts-max': { type: 'string' as const },
  'replans-max': { type: 'string' as const },
  defaults: { type: 'boolean' as const },
  yes: { type: 'boolean' as const },
  force: { type: 'boolean' as const },
  help: { type: 'boolean' as const, short: 'h' },
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printHelp(): void {
  console.log(`Usage: pc-workspace-config [options] [command]

Commands:
  init      Initialize workspace configuration (.paper-craft/workspace-config.json)
  show      Show current workspace configuration
  validate  Validate workspace configuration against repository and schema

Options:
  --repo-dir <path>             Path to Git repository checkout (defaults to '.')
  --delivery-target <owner/repo> Upstream delivery target repository
  --base-remote <remote>        Remote to fetch mainline from (e.g. origin, upstream)
  --push-remote <remote>        Remote to push feature branches to (e.g. origin)
  --base-branch <branch>        Mainline base branch (e.g. main)
  --worktree-container <path>   Container directory for disposable worktrees
  --workflow <name>             Workflow name (default: 'default')
  --delivery-attempts-max <n>   Max delivery attempts (default: 3)
  --replans-max <n>             Max replans (default: 2)
  --defaults, --yes             Accept defaults non-interactively
  --force                       Overwrite existing configuration
  -h, --help                    Show this help message
`);
}

async function cmdInit(values: Record<string, unknown>, repoDir: string): Promise<number> {
  let preparation: WorkspaceConfigInitPreparation;
  try {
    preparation = prepareWorkspaceConfigInitialization(repoDir, values);
  } catch (err: unknown) {
    process.stderr.write(`Error: ${errorMessage(err)}\n`);
    return 1;
  }

  const isDefaults = Boolean(values.defaults || values.yes);

  if (preparation.configExists && !values.force && !isDefaults) {
    if (process.stdin.isTTY) {
      process.stderr.write(`Configuration already exists at ${preparation.configPath}. Use --force to overwrite.\n`);
      return 1;
    }
  }

  let { draft } = preparation;
  const { primaryCheckout, isFork } = preparation;

  if (process.stdin.isTTY && !isDefaults) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('=== Paper-craft Workspace Configuration Wizard ===');
      console.log(`Repository Root:    ${primaryCheckout}`);
      if (isFork) {
        console.log('\nFork repository setup detected (distinct upstream and origin remotes):');
        console.log('  - delivery_target: Upstream repository for Issues, PRs, and landing (e.g. upstream-owner/repo)');
        console.log('  - base_remote:     Remote to fetch latest mainline code from (e.g. upstream)');
        console.log('  - push_remote:     Remote to push personal feature branches to (e.g. origin)');
        console.log('  - base_branch:     Mainline base branch on base_remote (e.g. main)');
        console.log('  - worktree_container: Directory container for disposable git worktrees\n');
      } else {
        console.log('\nStandard repository setup detected (origin is canonical base and push remote).\n');
      }

      console.log('delivery_target: Upstream repository for Issues, PRs, and landing (e.g. owner/repo)');
      const ansTarget = (await rl.question(`  Delivery Target [${draft.delivery_target}]: `)).trim();
      const deliveryTarget = ansTarget || draft.delivery_target;

      console.log('base_remote: Remote to fetch latest mainline code from (e.g. upstream or origin)');
      const ansBaseRemote = (await rl.question(`  Base Remote [${draft.base_remote}]: `)).trim();
      const baseRemote = ansBaseRemote || draft.base_remote;

      console.log('push_remote: Remote to push personal feature branches to (e.g. origin)');
      const ansPushRemote = (await rl.question(`  Push Remote [${draft.push_remote}]: `)).trim();
      const pushRemote = ansPushRemote || draft.push_remote;

      console.log('base_branch: Mainline base branch on base_remote (e.g. main)');
      const ansBaseBranch = (await rl.question(`  Base Branch [${draft.base_branch}]: `)).trim();
      const baseBranch = ansBaseBranch || draft.base_branch;

      console.log('worktree_container: Directory container for disposable git worktrees');
      const ansContainer = (await rl.question(`  Worktree Container [${draft.worktree_container}]: `)).trim();
      const worktreeContainer = ansContainer || draft.worktree_container;

      draft = {
        ...draft,
        delivery_target: deliveryTarget,
        base_remote: baseRemote,
        push_remote: pushRemote,
        base_branch: baseBranch,
        worktree_container: worktreeContainer,
      };
    } catch {
      process.stderr.write('\nConfiguration wizard aborted.\n');
      rl.close();
      return 1;
    } finally {
      rl.close();
    }
  }

  const force = Boolean(values.force || isDefaults || !process.stdin.isTTY);

  try {
    const result = saveWorkspaceConfigInitialization({
      primaryCheckout,
      config: draft,
      force,
    });
    console.log(JSON.stringify(result.config, null, 2));
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`${errorMessage(err)}\n`);
    return 1;
  }
}

async function cmdShow(repoDir: string): Promise<number> {
  let saved: SavedWorkspaceConfig | null;
  try {
    saved = loadWorkspaceConfig({ repoDir });
  } catch (err: unknown) {
    process.stderr.write(`Error: ${errorMessage(err)}\n`);
    return 1;
  }

  if (!saved) {
    process.stderr.write(
      `Error: Workspace configuration missing for repository at ${repoDir}.\nPlease run 'pc-workspace-config' to initialize configuration.\n`,
    );
    return 1;
  }

  console.log(JSON.stringify(saved.data, null, 2));
  return 0;
}

async function cmdValidate(repoDir: string): Promise<number> {
  let saved: SavedWorkspaceConfig | null;
  try {
    saved = loadWorkspaceConfig({ repoDir });
  } catch (err: unknown) {
    process.stderr.write(`Error: Workspace configuration is invalid: ${errorMessage(err)}\n`);
    return 1;
  }

  if (!saved) {
    process.stderr.write(
      `Error: Workspace configuration is missing for repository at ${repoDir}.\nPlease run 'pc-workspace-config' to initialize.\n`,
    );
    return 1;
  }

  const errors = validateWorkspaceConfig(saved.data, saved.primaryCheckout);
  if (errors.length) {
    process.stderr.write(
      `Error: Workspace configuration at ${saved.configPath} is invalid:\n  - ${errors.join('\n  - ')}\nPlease run 'pc-workspace-config' to reconfigure.\n`,
    );
    return 1;
  }

  console.log(`Workspace configuration is valid: ${saved.configPath}`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (err: unknown) {
    process.stderr.write(`Error: ${errorMessage(err)}\n`);
    return 1;
  }

  if (parsed.values.help) {
    printHelp();
    return 0;
  }

  const repoDir = parsed.values['repo-dir'] ? String(parsed.values['repo-dir']) : '.';

  if (parsed.positionals.length > 1) {
    process.stderr.write(`Error: Unexpected extra argument(s): ${parsed.positionals.slice(1).join(' ')}\n`);
    return 1;
  }

  const subcommand = parsed.positionals[0];
  if (!subcommand) {
    let saved: SavedWorkspaceConfig | null;
    try {
      saved = loadWorkspaceConfig({ repoDir });
    } catch (err: unknown) {
      process.stderr.write(`Error: ${errorMessage(err)}\n`);
      return 1;
    }
    if (!saved) {
      process.stderr.write(
        `Error: Workspace configuration is missing for repository at ${repoDir}.\nPlease run 'pc-workspace-config init' to initialize.\n`,
      );
      return 1;
    }
    console.log(JSON.stringify(saved.data, null, 2));
    return 0;
  }

  switch (subcommand) {
    case 'init':
      return cmdInit(parsed.values, repoDir);
    case 'show':
      return cmdShow(repoDir);
    case 'validate':
      return cmdValidate(repoDir);
    default:
      process.stderr.write(`Error: Unknown subcommand '${subcommand}'. Expected 'init', 'show', or 'validate'.\n`);
      return 1;
  }
}

function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
