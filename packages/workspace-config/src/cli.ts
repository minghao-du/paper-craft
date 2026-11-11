#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_DELIVERY_ATTEMPTS_MAX,
  DEFAULT_REPLANS_MAX,
  DEFAULT_WORKFLOW,
  DEFAULT_WORKTREE_CONTAINER,
  SCHEMA_VERSION,
  atomicWriteJson,
  findPrimaryCheckout,
  getConfigFilePath,
  parseRepoFromUrl,
  probeDefaultBranch,
  probeGitRemotes,
  runGit,
  validateWorkspaceConfig,
} from './config.js';

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
  let primaryCheckout: string;
  try {
    primaryCheckout = findPrimaryCheckout(repoDir);
  } catch (err: unknown) {
    process.stderr.write(`Error: ${errorMessage(err)}\n`);
    return 1;
  }

  const configPath = getConfigFilePath(primaryCheckout);
  const isDefaults = Boolean(values.defaults || values.yes);

  if (fs.existsSync(configPath) && !values.force && !isDefaults) {
    if (process.stdin.isTTY) {
      process.stderr.write(`Configuration already exists at ${configPath}. Use --force to overwrite.\n`);
      return 1;
    }
  }

  const remotes = probeGitRemotes(primaryCheckout);

  let baseRemote: string;
  if (values['base-remote']) {
    baseRemote = String(values['base-remote']).trim();
    if (remotes.length && !remotes.includes(baseRemote)) {
      process.stderr.write(
        `Error: Specified base_remote '${baseRemote}' does not exist in git remotes: ${JSON.stringify(remotes)}\n`,
      );
      return 1;
    }
  } else {
    if (remotes.includes('upstream')) {
      baseRemote = 'upstream';
    } else if (remotes.includes('origin')) {
      baseRemote = 'origin';
    } else if (remotes.length === 1) {
      baseRemote = remotes[0];
    } else if (remotes.length === 0) {
      process.stderr.write(
        'Error: No git remotes configured in repository. Cannot determine remote without explicit --base-remote.\n',
      );
      return 1;
    } else {
      process.stderr.write(
        `Error: Multiple remotes configured (${JSON.stringify(remotes)}) without origin or upstream. Please specify --base-remote explicitly.\n`,
      );
      return 1;
    }
  }

  let pushRemote: string;
  if (values['push-remote']) {
    pushRemote = String(values['push-remote']).trim();
    if (remotes.length && !remotes.includes(pushRemote)) {
      process.stderr.write(
        `Error: Specified push_remote '${pushRemote}' does not exist in git remotes: ${JSON.stringify(remotes)}\n`,
      );
      return 1;
    }
  } else {
    if (remotes.includes('upstream') && remotes.includes('origin')) {
      pushRemote = 'origin';
    } else {
      pushRemote = baseRemote;
    }
  }

  let deliveryTarget: string;
  if (values['delivery-target']) {
    deliveryTarget = String(values['delivery-target']).trim();
  } else {
    let probedTarget: string | null = null;
    const [code, remoteUrl] = runGit(primaryCheckout, 'remote', 'get-url', baseRemote);
    if (code === 0 && remoteUrl) {
      probedTarget = parseRepoFromUrl(remoteUrl);
    }
    if (!probedTarget && remotes.includes('origin') && baseRemote !== 'origin') {
      const [originCode, originUrl] = runGit(primaryCheckout, 'remote', 'get-url', 'origin');
      if (originCode === 0 && originUrl) {
        probedTarget = parseRepoFromUrl(originUrl);
      }
    }
    if (!probedTarget) {
      process.stderr.write(
        `Error: Cannot determine delivery_target from remote '${baseRemote}'. Facts cannot be confirmed. Please specify --delivery-target explicitly.\n`,
      );
      return 1;
    }
    deliveryTarget = probedTarget;
  }

  let baseBranch: string;
  if (values['base-branch']) {
    baseBranch = String(values['base-branch']).trim();
  } else {
    const probedBranch = probeDefaultBranch(primaryCheckout, baseRemote);
    if (!probedBranch) {
      process.stderr.write(
        `Error: Cannot determine base_branch from remote '${baseRemote}'. Facts cannot be confirmed. Please specify --base-branch explicitly.\n`,
      );
      return 1;
    }
    baseBranch = probedBranch;
  }

  let worktreeContainer = values['worktree-container']
    ? String(values['worktree-container']).trim()
    : DEFAULT_WORKTREE_CONTAINER;

  const workflow = values.workflow ? String(values.workflow).trim() : DEFAULT_WORKFLOW;

  let deliveryAttemptsMax = DEFAULT_DELIVERY_ATTEMPTS_MAX;
  if (values['delivery-attempts-max'] !== undefined) {
    deliveryAttemptsMax = Number(values['delivery-attempts-max']);
    if (!Number.isInteger(deliveryAttemptsMax) || deliveryAttemptsMax < 0) {
      process.stderr.write("Error: Field 'delivery_attempts_max' must be an integer >= 0\n");
      return 1;
    }
  }

  let replansMax = DEFAULT_REPLANS_MAX;
  if (values['replans-max'] !== undefined) {
    replansMax = Number(values['replans-max']);
    if (!Number.isInteger(replansMax) || replansMax < 0) {
      process.stderr.write("Error: Field 'replans_max' must be an integer >= 0\n");
      return 1;
    }
  }

  const isFork = baseRemote !== pushRemote;

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
      const ansTarget = (await rl.question(`  Delivery Target [${deliveryTarget}]: `)).trim();
      if (ansTarget) deliveryTarget = ansTarget;

      console.log('base_remote: Remote to fetch latest mainline code from (e.g. upstream or origin)');
      const ansBaseRemote = (await rl.question(`  Base Remote [${baseRemote}]: `)).trim();
      if (ansBaseRemote) baseRemote = ansBaseRemote;

      console.log('push_remote: Remote to push personal feature branches to (e.g. origin)');
      const ansPushRemote = (await rl.question(`  Push Remote [${pushRemote}]: `)).trim();
      if (ansPushRemote) pushRemote = ansPushRemote;

      console.log('base_branch: Mainline base branch on base_remote (e.g. main)');
      const ansBaseBranch = (await rl.question(`  Base Branch [${baseBranch}]: `)).trim();
      if (ansBaseBranch) baseBranch = ansBaseBranch;

      console.log('worktree_container: Directory container for disposable git worktrees');
      const ansContainer = (await rl.question(`  Worktree Container [${worktreeContainer}]: `)).trim();
      if (ansContainer) worktreeContainer = ansContainer;
    } catch {
      process.stderr.write('\nConfiguration wizard aborted.\n');
      rl.close();
      return 1;
    } finally {
      rl.close();
    }
  }

  const configData = {
    schema_version: SCHEMA_VERSION,
    delivery_target: deliveryTarget,
    base_remote: baseRemote,
    push_remote: pushRemote,
    base_branch: baseBranch,
    worktree_container: worktreeContainer,
    workflow,
    delivery_attempts_max: deliveryAttemptsMax,
    replans_max: replansMax,
  };

  const errors = validateWorkspaceConfig(configData, primaryCheckout);
  if (errors.length) {
    process.stderr.write(`Validation failed during initialization:\n  - ${errors.join('\n  - ')}\n`);
    return 1;
  }

  atomicWriteJson(configPath, configData);
  console.log(JSON.stringify(configData, null, 2));
  return 0;
}

async function cmdShow(repoDir: string): Promise<number> {
  let primaryCheckout: string;
  try {
    primaryCheckout = findPrimaryCheckout(repoDir);
  } catch (err: unknown) {
    process.stderr.write(`Error: ${errorMessage(err)}\n`);
    return 1;
  }

  const configPath = getConfigFilePath(primaryCheckout);
  if (!fs.existsSync(configPath)) {
    process.stderr.write(
      `Error: Workspace configuration missing at ${configPath}.\nPlease run 'pc-workspace-config' to initialize configuration.\n`,
    );
    return 1;
  }

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err: unknown) {
    process.stderr.write(`Error: Corrupted workspace config at ${configPath}: ${errorMessage(err)}\n`);
    return 1;
  }

  console.log(JSON.stringify(data, null, 2));
  return 0;
}

async function cmdValidate(repoDir: string): Promise<number> {
  let primaryCheckout: string;
  try {
    primaryCheckout = findPrimaryCheckout(repoDir);
  } catch (err: unknown) {
    process.stderr.write(`Error: ${errorMessage(err)}\n`);
    return 1;
  }

  const configPath = getConfigFilePath(primaryCheckout);
  if (!fs.existsSync(configPath)) {
    process.stderr.write(
      `Error: Workspace configuration is missing at ${configPath}.\nPlease run 'pc-workspace-config' to initialize.\n`,
    );
    return 1;
  }

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err: unknown) {
    process.stderr.write(`Error: Workspace configuration at ${configPath} is invalid: ${errorMessage(err)}\n`);
    return 1;
  }

  const errors = validateWorkspaceConfig(data, primaryCheckout);
  if (errors.length) {
    process.stderr.write(
      `Error: Workspace configuration at ${configPath} is invalid:\n  - ${errors.join('\n  - ')}\nPlease run 'pc-workspace-config' to reconfigure.\n`,
    );
    return 1;
  }

  console.log(`Workspace configuration is valid: ${configPath}`);
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
    let primaryCheckout: string;
    try {
      primaryCheckout = findPrimaryCheckout(repoDir);
    } catch (err: unknown) {
      process.stderr.write(`Error: ${errorMessage(err)}\n`);
      return 1;
    }
    const configPath = getConfigFilePath(primaryCheckout);
    if (!fs.existsSync(configPath)) {
      process.stderr.write(
        `Error: Workspace configuration is missing at ${configPath}.\nPlease run 'pc-workspace-config init' to initialize.\n`,
      );
      return 1;
    }
    return cmdShow(repoDir);
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
