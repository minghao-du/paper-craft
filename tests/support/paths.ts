import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Absolute root path of the repository.
 */
export const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Absolute path to envelope CLI script (envelope-cli.ts).
 */
export const ENVELOPE_SCRIPT = path.join(
  REPO_ROOT,
  'packages/orchestrator/src/envelope-cli.ts',
);

/**
 * Absolute path to dispatch lifecycle kernel CLI script (cli.ts).
 */
export const LIFECYCLE_KERNEL_SCRIPT = path.join(
  REPO_ROOT,
  'packages/orchestrator/src/cli.ts',
);

/**
 * Absolute path to the workspace configuration CLI script (pc-workspace-config).
 */
export const WORKSPACE_CONFIG_SCRIPT = path.join(
  REPO_ROOT,
  'packages/workspace-config/src/cli.ts',
);

/**
 * Absolute path to the workspace CLI script (pc-workspace).
 */
export const PREPARE_WORKTREE_SCRIPT = path.join(
  REPO_ROOT,
  'packages/workspace/src/cli.ts',
);

/**
 * Absolute path to tsx loader.
 */
export const TSX_LOADER_PATH = path.join(
  REPO_ROOT,
  'node_modules/tsx/dist/loader.mjs',
);
