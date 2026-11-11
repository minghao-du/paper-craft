import fs from 'node:fs';
import path from 'node:path';
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
  resolveWorkspaceConfig,
  runGit,
  validateWorkspaceConfig,
  type ResolvedWorkspaceConfig,
} from './config.js';

export interface WorkspaceConfigDraft {
  schema_version: string;
  delivery_target: string;
  base_remote: string;
  push_remote: string;
  base_branch: string;
  worktree_container: string;
  workflow: string;
  delivery_attempts_max: number;
  replans_max: number;
  [key: string]: unknown;
}

export interface WorkspaceConfigInitOverrides {
  delivery_target?: string;
  deliveryTarget?: string;
  'delivery-target'?: string;
  base_remote?: string;
  baseRemote?: string;
  'base-remote'?: string;
  push_remote?: string;
  pushRemote?: string;
  'push-remote'?: string;
  base_branch?: string;
  baseBranch?: string;
  'base-branch'?: string;
  worktree_container?: string;
  worktreeContainer?: string;
  'worktree-container'?: string;
  workflow?: string;
  delivery_attempts_max?: number | string;
  deliveryAttemptsMax?: number | string;
  'delivery-attempts-max'?: number | string;
  replans_max?: number | string;
  replansMax?: number | string;
  'replans-max'?: number | string;
  [key: string]: unknown;
}

export interface WorkspaceConfigInitPreparation {
  primaryCheckout: string;
  configPath: string;
  configExists: boolean;
  remotes: string[];
  isFork: boolean;
  draft: WorkspaceConfigDraft;
}

export interface SaveWorkspaceConfigInitializationOptions {
  primaryCheckout: string;
  config: unknown;
  force?: boolean;
  configPath?: string;
}

export interface SaveWorkspaceConfigResult {
  configPath: string;
  config: WorkspaceConfigDraft;
  resolved: ResolvedWorkspaceConfig;
}

function getOverride<T = unknown>(overrides: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    if (key in overrides && overrides[key] !== undefined && overrides[key] !== null) {
      return overrides[key] as T;
    }
  }
  return undefined;
}

/**
 * Derives initial workspace configuration and context from git facts and overrides.
 * Pure business logic: does not write files or interact with terminal I/O.
 */
export function prepareWorkspaceConfigInitialization(
  repoDir: string = '.',
  overrides: Record<string, unknown> = {},
): WorkspaceConfigInitPreparation {
  const primaryCheckout = findPrimaryCheckout(repoDir);
  const configPath = getConfigFilePath(primaryCheckout);
  const configExists = fs.existsSync(configPath);

  const remotes = probeGitRemotes(primaryCheckout);

  let baseRemote: string;
  const rawBaseRemote = getOverride<string>(overrides, 'base_remote', 'base-remote', 'baseRemote');
  if (rawBaseRemote !== undefined && String(rawBaseRemote).trim()) {
    baseRemote = String(rawBaseRemote).trim();
    if (remotes.length && !remotes.includes(baseRemote)) {
      throw new Error(
        `Specified base_remote '${baseRemote}' does not exist in git remotes: ${JSON.stringify(remotes)}`,
      );
    }
  } else {
    if (remotes.includes('upstream')) {
      baseRemote = 'upstream';
    } else if (remotes.includes('origin')) {
      baseRemote = 'origin';
    } else if (remotes.length === 1) {
      baseRemote = remotes[0];
    } else if (remotes.length === 0) {
      throw new Error(
        'No git remotes configured in repository. Cannot determine remote without explicit --base-remote.',
      );
    } else {
      throw new Error(
        `Multiple remotes configured (${JSON.stringify(remotes)}) without origin or upstream. Please specify --base-remote explicitly.`,
      );
    }
  }

  let pushRemote: string;
  const rawPushRemote = getOverride<string>(overrides, 'push_remote', 'push-remote', 'pushRemote');
  if (rawPushRemote !== undefined && String(rawPushRemote).trim()) {
    pushRemote = String(rawPushRemote).trim();
    if (remotes.length && !remotes.includes(pushRemote)) {
      throw new Error(
        `Specified push_remote '${pushRemote}' does not exist in git remotes: ${JSON.stringify(remotes)}`,
      );
    }
  } else {
    if (remotes.includes('upstream') && remotes.includes('origin')) {
      pushRemote = 'origin';
    } else {
      pushRemote = baseRemote;
    }
  }

  let deliveryTarget: string;
  const rawDeliveryTarget = getOverride<string>(overrides, 'delivery_target', 'delivery-target', 'deliveryTarget');
  if (rawDeliveryTarget !== undefined && String(rawDeliveryTarget).trim()) {
    deliveryTarget = String(rawDeliveryTarget).trim();
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
      throw new Error(
        `Cannot determine delivery_target from remote '${baseRemote}'. Facts cannot be confirmed. Please specify --delivery-target explicitly.`,
      );
    }
    deliveryTarget = probedTarget;
  }

  let baseBranch: string;
  const rawBaseBranch = getOverride<string>(overrides, 'base_branch', 'base-branch', 'baseBranch');
  if (rawBaseBranch !== undefined && String(rawBaseBranch).trim()) {
    baseBranch = String(rawBaseBranch).trim();
  } else {
    const probedBranch = probeDefaultBranch(primaryCheckout, baseRemote);
    if (!probedBranch) {
      throw new Error(
        `Cannot determine base_branch from remote '${baseRemote}'. Facts cannot be confirmed. Please specify --base-branch explicitly.`,
      );
    }
    baseBranch = probedBranch;
  }

  const rawWorktreeContainer = getOverride<string>(
    overrides,
    'worktree_container',
    'worktree-container',
    'worktreeContainer',
  );
  const worktreeContainer =
    rawWorktreeContainer !== undefined && String(rawWorktreeContainer).trim()
      ? String(rawWorktreeContainer).trim()
      : DEFAULT_WORKTREE_CONTAINER;

  const rawWorkflow = getOverride<string>(overrides, 'workflow');
  const workflow =
    rawWorkflow !== undefined && String(rawWorkflow).trim()
      ? String(rawWorkflow).trim()
      : DEFAULT_WORKFLOW;

  let deliveryAttemptsMax = DEFAULT_DELIVERY_ATTEMPTS_MAX;
  const rawAttempts = getOverride<number | string>(
    overrides,
    'delivery_attempts_max',
    'delivery-attempts-max',
    'deliveryAttemptsMax',
  );
  if (rawAttempts !== undefined) {
    deliveryAttemptsMax = typeof rawAttempts === 'number' ? rawAttempts : Number(rawAttempts);
    if (!Number.isInteger(deliveryAttemptsMax) || deliveryAttemptsMax < 0) {
      throw new Error("Field 'delivery_attempts_max' must be an integer >= 0");
    }
  }

  let replansMax = DEFAULT_REPLANS_MAX;
  const rawReplans = getOverride<number | string>(
    overrides,
    'replans_max',
    'replans-max',
    'replansMax',
  );
  if (rawReplans !== undefined) {
    replansMax = typeof rawReplans === 'number' ? rawReplans : Number(rawReplans);
    if (!Number.isInteger(replansMax) || replansMax < 0) {
      throw new Error("Field 'replans_max' must be an integer >= 0");
    }
  }

  const isFork = baseRemote !== pushRemote;

  const draft: WorkspaceConfigDraft = {
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

  return {
    primaryCheckout,
    configPath,
    configExists,
    remotes,
    isFork,
    draft,
  };
}

/**
 * Validates, writes atomically, and resolves workspace configuration.
 * Pure business logic: does not produce terminal output.
 */
export function saveWorkspaceConfigInitialization(
  options: SaveWorkspaceConfigInitializationOptions,
): SaveWorkspaceConfigResult {
  if (!options || typeof options !== 'object') {
    throw new Error('saveWorkspaceConfigInitialization requires an options object');
  }
  const { primaryCheckout, config, force = false, configPath } = options;
  if (!primaryCheckout || typeof primaryCheckout !== 'string') {
    throw new Error('primaryCheckout is required and must be a string');
  }

  const targetPath =
    configPath !== undefined
      ? path.isAbsolute(configPath)
        ? configPath
        : path.resolve(primaryCheckout, configPath)
      : getConfigFilePath(primaryCheckout);

  if (!force && fs.existsSync(targetPath)) {
    throw new Error(`Configuration already exists at ${targetPath}. Use force to overwrite.`);
  }

  const errors = validateWorkspaceConfig(config, primaryCheckout);
  if (errors.length) {
    throw new Error(`Validation failed during initialization:\n  - ${errors.join('\n  - ')}`);
  }

  atomicWriteJson(targetPath, config);

  const resolved = resolveWorkspaceConfig({
    repoDir: primaryCheckout,
    configPath: targetPath,
    requireFile: true,
  });

  return {
    configPath: targetPath,
    config: config as WorkspaceConfigDraft,
    resolved,
  };
}
