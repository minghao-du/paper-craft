/**
 * Workspace configuration package public API.
 *
 * Implements Section 4 & 5 of WORKSPACE_TYPESCRIPT_REFACTOR_PLAN.md
 * and Section 6.3 of DIRECTORY_STRUCTURE_REFACTOR_PLAN.md.
 */

export {
  SCHEMA_VERSION,
  CONFIG_REL_PATH,
  DEFAULT_WORKTREE_CONTAINER,
  DEFAULT_WORKFLOW,
  DEFAULT_DELIVERY_ATTEMPTS_MAX,
  DEFAULT_REPLANS_MAX,
  type ResolvedWorkspaceConfig,
  type WorkspaceConfigOverrides,
  type ResolveWorkspaceConfigOptions,
  type LoadWorkspaceConfigOptions,
  type SavedWorkspaceConfig,
  atomicWriteJson,
  runGit,
  findRepoRoot,
  findPrimaryCheckout,
  getConfigFilePath,
  parseRepoFromUrl,
  probeGitRemotes,
  probeDefaultBranch,
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  resolveWorkspaceConfig,
} from './config.js';

export {
  prepareWorkspaceConfigInitialization,
  saveWorkspaceConfigInitialization,
  type WorkspaceConfigDraft,
  type WorkspaceConfigInitOverrides,
  type WorkspaceConfigInitPreparation,
  type SaveWorkspaceConfigInitializationOptions,
  type SaveWorkspaceConfigResult,
} from './initialization.js';
