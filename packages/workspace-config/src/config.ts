import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = '1.0';
export const CONFIG_REL_PATH = '.paper-craft/workspace-config.json';
export const DEFAULT_WORKTREE_CONTAINER = '../project-worktrees';
export const DEFAULT_WORKFLOW = 'default';
export const DEFAULT_DELIVERY_ATTEMPTS_MAX = 3;
export const DEFAULT_REPLANS_MAX = 2;

export interface ResolvedWorkspaceConfig {
  schema_version: string;
  delivery_target: string;
  base_remote: string;
  push_remote: string;
  base_branch: string;
  worktree_container: string;
  workflow: string;
  delivery_attempts_max: number;
  replans_max: number;
  repo_checkout: string;
  worktree_container_resolved: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Like pathlib.resolve(strict=False), resolve existing symlink prefixes too. */
function resolvePath(value: string): string {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(resolvePath(parent), path.basename(absolute));
}

export function runGit(directory: string, ...args: string[]): [number, string, string] {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  return [result.status ?? 1, result.stdout?.trim() ?? '', result.stderr?.trim() ?? String(result.error ?? '')];
}

export function findRepoRoot(directory: string): string {
  const [code, output] = runGit(directory, 'rev-parse', '--show-toplevel');
  return resolvePath(code === 0 && output ? output : directory);
}

export function getConfigFilePath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_REL_PATH);
}

export function parseRepoFromUrl(url: string): string | null {
  if (!url) return null;
  const match = /[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (match) return `${match[1]}/${match[2]}`;
  const parentPath = path.dirname(url);
  const parent = parentPath === '.' ? '' : path.basename(parentPath);
  const stem = path.parse(url).name;
  return parent && stem ? `${parent}/${stem}` : null;
}

export function probeGitRemotes(repoRoot: string): string[] {
  const [code, output] = runGit(repoRoot, 'remote');
  return code === 0 && output ? output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

export function probeDefaultBranch(repoRoot: string, remote = 'origin'): string | null {
  const [refCode, ref] = runGit(repoRoot, 'symbolic-ref', `refs/remotes/${remote}/HEAD`);
  if (refCode === 0 && ref) return ref.split('/').at(-1)!;
  const [urlCode, url] = runGit(repoRoot, 'remote', 'get-url', remote);
  if (urlCode === 0 && url) {
    const result = spawnSync('gh', ['repo', 'view', url, '--json', 'defaultBranchRef'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 5000,
    });
    if (result.status === 0) {
      try {
        const metadata: unknown = JSON.parse(result.stdout);
        if (isRecord(metadata) && isRecord(metadata.defaultBranchRef) && metadata.defaultBranchRef.name) {
          return String(metadata.defaultBranchRef.name);
        }
      } catch { /* Continue probing local repository facts. */ }
    }
  }
  const [headCode, head] = runGit(repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (headCode === 0 && head && head !== 'HEAD') return head;
  const [branchesCode, output] = runGit(repoRoot, 'branch', '--format=%(refname:short)');
  if (branchesCode === 0 && output) {
    const branches = output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (branches.length === 1) return branches[0];
    if (branches.includes('main') && !branches.includes('master')) return 'main';
    if (branches.includes('master') && !branches.includes('main')) return 'master';
  }
  return null;
}

export function loadWorkspaceConfig(repoRoot: string): Record<string, unknown> | null {
  const configPath = getConfigFilePath(repoRoot);
  if (!fs.existsSync(configPath)) return null;
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Malformed JSON in workspace configuration at ${configPath}: ${String(error)}. Please run 'pc-workspace-config' to reconfigure.`, { cause: error });
  }
  if (!isRecord(data)) {
    throw new Error(`Workspace configuration at ${configPath} must be a JSON object. Please run 'pc-workspace-config' to reconfigure.`);
  }
  return data;
}

export function validateWorkspaceConfig(data: unknown, repoRoot?: string): string[] {
  if (!isRecord(data)) return ['Workspace configuration must be a JSON object'];
  const errors: string[] = [];
  if (data.schema_version !== SCHEMA_VERSION) {
    errors.push(`Invalid schema_version '${String(data.schema_version)}'. Expected '${SCHEMA_VERSION}'`);
  }
  const fields: Record<string, string> = {
    delivery_target: "Target repository (e.g. 'owner/repo')",
    base_remote: "Mainline base git remote (e.g. 'origin')",
    push_remote: "Feature push git remote (e.g. 'origin')",
    base_branch: "Mainline base branch (e.g. 'main')",
    worktree_container: "Worktree container directory (e.g. '../project-worktrees')",
  };
  for (const [key, description] of Object.entries(fields)) {
    if (typeof data[key] !== 'string' || !data[key].trim()) {
      errors.push(`Missing or empty required field '${key}' (${description})`);
    }
  }
  for (const field of ['workflow', 'default_workflow']) {
    if (field in data && (typeof data[field] !== 'string' || !data[field].trim())) {
      errors.push(`Field '${field}' must be a non-empty string`);
    }
  }
  for (const field of ['delivery_attempts_max', 'replans_max']) {
    if (field in data && (!Number.isInteger(data[field]) || (data[field] as number) < 0)) {
      errors.push(`Field '${field}' must be an integer >= 0`);
    }
  }
  if (repoRoot && fs.existsSync(repoRoot)) {
    const remotes = probeGitRemotes(repoRoot);
    for (const field of ['base_remote', 'push_remote']) {
      if (remotes.length && data[field] && !remotes.includes(String(data[field]))) {
        errors.push(`Configured ${field} '${String(data[field])}' does not exist in git remotes: ${JSON.stringify(remotes)}`);
      }
    }
  }
  return errors;
}

/** Resolve a snapshot using explicit values, validated project configuration, then Git facts. */
export function resolveWorkspaceConfig(
  repoDir: string,
  overrides: Record<string, unknown> = {},
  requireFile = false,
): ResolvedWorkspaceConfig {
  const repoRoot = findRepoRoot(repoDir);
  const configPath = getConfigFilePath(repoRoot);
  if (requireFile && !fs.existsSync(configPath)) {
    throw new Error(`Workspace configuration missing at ${configPath}. Please run 'pc-workspace-config' to initialize.`);
  }
  const data = loadWorkspaceConfig(repoRoot) ?? {};
  if (fs.existsSync(configPath)) {
    const errors = validateWorkspaceConfig(data, repoRoot);
    if (errors.length) throw new Error(`Workspace configuration at ${configPath} is invalid:\n  - ${errors.join('\n  - ')}\nPlease run 'pc-workspace-config' to reconfigure.`);
  }
  const remotes = probeGitRemotes(repoRoot);
  const explicitOrFile = (key: string): string | undefined => {
    const value = overrides[key] || data[key];
    return value ? String(value).trim() : undefined;
  };
  const baseRemote = explicitOrFile('base_remote') ?? (
    remotes.includes('upstream') ? 'upstream' : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined
  );
  if (!baseRemote) {
    throw new Error("Cannot determine base_remote: configuration missing or undetectable from repository remotes. Do not guess fallback defaults. Please run 'pc-workspace-config' or specify --base-remote explicitly.");
  }
  const pushRemote = explicitOrFile('push_remote') ?? (remotes.includes('upstream') && remotes.includes('origin') ? 'origin' : baseRemote);
  let deliveryTarget = explicitOrFile('delivery_target');
  if (!deliveryTarget) {
    const [code, url] = runGit(repoRoot, 'remote', 'get-url', baseRemote);
    deliveryTarget = code === 0 ? parseRepoFromUrl(url) ?? undefined : undefined;
    if (!deliveryTarget && remotes.includes('origin') && baseRemote !== 'origin') {
      const [originCode, originUrl] = runGit(repoRoot, 'remote', 'get-url', 'origin');
      deliveryTarget = originCode === 0 ? parseRepoFromUrl(originUrl) ?? undefined : undefined;
    }
  }
  if (!deliveryTarget) {
    throw new Error(`Cannot determine delivery_target: configuration missing or undetectable from remote '${baseRemote}'. Do not guess fallback defaults like 'local/repo'. Please run 'pc-workspace-config' or specify --delivery-target explicitly.`);
  }
  const baseBranch = explicitOrFile('base_branch') ?? probeDefaultBranch(repoRoot, baseRemote);
  if (!baseBranch) {
    throw new Error(`Cannot determine base_branch from remote '${baseRemote}'. Do not guess fallback defaults like 'main'. Please run 'pc-workspace-config' or specify --base-branch explicitly.`);
  }
  const container = explicitOrFile('worktree_container') ?? DEFAULT_WORKTREE_CONTAINER;
  const resolved: ResolvedWorkspaceConfig = {
    schema_version: SCHEMA_VERSION,
    delivery_target: deliveryTarget,
    base_remote: baseRemote,
    push_remote: pushRemote,
    base_branch: baseBranch,
    worktree_container: container,
    workflow: explicitOrFile('workflow') ?? String(data.default_workflow || DEFAULT_WORKFLOW),
    delivery_attempts_max: Number(overrides.delivery_attempts_max ?? data.delivery_attempts_max ?? DEFAULT_DELIVERY_ATTEMPTS_MAX),
    replans_max: Number(overrides.replans_max ?? data.replans_max ?? DEFAULT_REPLANS_MAX),
    repo_checkout: repoRoot,
    worktree_container_resolved: resolvePath(path.resolve(repoRoot, container)),
  };
  const errors = validateWorkspaceConfig(resolved, repoRoot);
  if (errors.length) throw new Error(`Resolved workspace configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  return resolved;
}
