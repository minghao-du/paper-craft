/**
 * Configuration loading and path resolution.
 *
 * Two tiers:
 *   1. Global config at `~/.config/pc/config.yml` — nexus_path, API tokens
 *   2. Nexus config at `$NEXUS_PATH/.paper-craft/config.yml` — pdf_root, pdf_reader
 *
 * Environment variables override config file values (e.g., `PC_PDF_ROOT`).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// -- Path constants --

const GLOBAL_CONFIG_DIR = 'pc';
const GLOBAL_CONFIG_FILE = 'config.yml';
const NEXUS_DIR = '.paper-craft';
const CACHE_DIR = 'cache';
const DB_FILE = 'refs.db';
const REFS_FILE = 'refs.jsonl';
const PROJECTS_FILE = 'projects.jsonl';
const REPOS_FILE = 'repos.jsonl';
const NEXUS_CONFIG_FILE = 'config.yml';

// -- Global config --

/** Global configuration stored at `~/.config/pc/config.yml`. */
export interface GlobalConfig {
  nexus_path?: string;
  zotero_path?: string;
  asta_api_key?: string;
  slack_bot_token?: string;
  github_token?: string;
  slack_webhooks?: Record<string, string>;
  spawn_agent?: string;
  ntfy_topic?: string;
}

/** Nexus-level configuration stored at `$NEXUS_PATH/.paper-craft/config.yml`. */
export interface NexusConfig {
  pdf_root?: string;
  pdf_reader?: string;
  papers_repo?: string;
}

const VALID_READERS = ['system', 'skim', 'zathura', 'evince', 'okular'] as const;

/** Expand `~` to the user's home directory. */
export function expandTilde(path: string): string {
  if (!path.startsWith('~')) return path;
  const home = process.env['HOME'] || homedir();
  return join(home, path.slice(1));
}

/** Return the path to the global config file. Respects `XDG_CONFIG_HOME`. */
export function globalConfigPath(): string {
  const home = process.env['HOME'] || homedir();
  const configHome = process.env['XDG_CONFIG_HOME'] || join(home, '.config');
  return join(configHome, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE);
}

let globalConfigCache: GlobalConfig | null = null;

/** Load the global config. Returns empty object if file doesn't exist. Cached. */
export function loadGlobalConfig(): GlobalConfig {
  if (globalConfigCache) return globalConfigCache;

  const path = globalConfigPath();
  if (!existsSync(path)) {
    globalConfigCache = {};
    return globalConfigCache;
  }

  const content = readFileSync(path, 'utf-8');
  const cfg = (parseYaml(content) as GlobalConfig) ?? {};

  // Expand tilde in path fields
  if (cfg.nexus_path) {
    cfg.nexus_path = expandTilde(cfg.nexus_path);
  }
  if (cfg.zotero_path) {
    cfg.zotero_path = expandTilde(cfg.zotero_path);
  }

  globalConfigCache = cfg;
  return cfg;
}

/** Clear the cached global config (useful for tests). */
export function resetGlobalConfigCache(): void {
  globalConfigCache = null;
}

/** Return the first non-empty env var value, falling back to the config value. */
function envOrConfig(envNames: string[], configValue?: string): string {
  for (const name of envNames) {
    const v = process.env[name];
    if (v) return v;
  }
  return configValue ?? '';
}

// -- Nexus path resolution --

/**
 * Walk up from the starting directory to find a `.paper-craft` repository directory.
 * Returns the absolute directory path containing `.paper-craft`, or null if not found.
 */
export function findNexusUp(startDir?: string): string | null {
  const callerDir = process.env['INIT_CWD'] || process.env['PWD'] || process.cwd();
  let curr = startDir ?? callerDir;
  while (true) {
    const candidate = join(curr, NEXUS_DIR);
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) {
          return curr;
        }
      } catch {
        // Continue walking up if permission error or dangling link
      }
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

/** Get the configured nexus path. Prioritizes PC_NEXUS_PATH, then local .paper-craft directory, then global config. */
export function getNexusPath(): string {
  const envNexus = process.env['PC_NEXUS_PATH'];
  if (envNexus) return expandTilde(envNexus);
  const localNexus = findNexusUp();
  if (localNexus) return localNexus;
  const cfg = loadGlobalConfig();
  return cfg.nexus_path ?? '';
}

/** Validate and return the nexus path. Throws if not configured or doesn't exist. */
export function mustGetNexusPath(): string {
  const path = getNexusPath();
  if (!path) {
    const configPath = globalConfigPath();
    throw new Error(
      `No nexus path configured.\n\n` +
        `Tip: Create ${configPath} to set a default nexus:\n` +
        `  mkdir -p ${dirname(configPath)}\n` +
        `  echo 'nexus_path: /path/to/your/nexus' > ${configPath}\n`,
    );
  }
  if (!existsSync(path)) {
    throw new Error(`Configured nexus_path does not exist: ${path}`);
  }
  return path;
}

// -- Nexus-relative paths --

/** Path to the .paper-craft directory inside the nexus. */
export function nexusDir(nexusPath: string): string {
  return join(nexusPath, NEXUS_DIR);
}

/** Path to refs.jsonl. */
export function refsPath(nexusPath: string): string {
  return join(nexusPath, NEXUS_DIR, REFS_FILE);
}

/** Path to projects.jsonl. */
export function projectsPath(nexusPath: string): string {
  return join(nexusPath, NEXUS_DIR, PROJECTS_FILE);
}

/** Path to repos.jsonl. */
export function reposPath(nexusPath: string): string {
  return join(nexusPath, NEXUS_DIR, REPOS_FILE);
}

/** Path to the cache directory. */
export function cachePath(nexusPath: string): string {
  return join(nexusPath, NEXUS_DIR, CACHE_DIR);
}

/** Path to the SQLite database. */
export function dbPath(nexusPath: string): string {
  return join(nexusPath, NEXUS_DIR, CACHE_DIR, DB_FILE);
}

/** All JSONL source paths (for staleness checks). */
export function allJsonlPaths(nexusPath: string): string[] {
  return [refsPath(nexusPath), projectsPath(nexusPath), reposPath(nexusPath)];
}

// -- Nexus config --

/** Path to the nexus config file. */
export function nexusConfigPath(nexusPath: string): string {
  return join(nexusPath, NEXUS_DIR, NEXUS_CONFIG_FILE);
}

/** Load the nexus-level config. Returns empty object if file doesn't exist. */
export function loadNexusConfig(nexusPath: string): NexusConfig {
  const path = nexusConfigPath(nexusPath);
  if (!existsSync(path)) return {};

  const content = readFileSync(path, 'utf-8');
  const cfg = (parseYaml(content) as NexusConfig) ?? {};
  if (cfg.pdf_root) {
    cfg.pdf_root = expandTilde(cfg.pdf_root);
  }
  return cfg;
}

/** Get the configured PDF root directory (env: `PC_PDF_ROOT`, then nexus config). */
export function getPdfRoot(nexusPath: string): string {
  const envVal = process.env['PC_PDF_ROOT'];
  if (envVal) return expandTilde(envVal);
  const cfg = loadNexusConfig(nexusPath);
  return cfg.pdf_root ? expandTilde(cfg.pdf_root) : '';
}

/**
 * Resolve Zotero data directory path with hierarchical precedence:
 *   1. Explicit CLI argument (`cliPath`)
 *   2. Environment variable `PC_ZOTERO_PATH`
 *   3. Global config property `zotero_path` in `~/.config/pc/config.yml`
 *   4. Platform default `~/Zotero`
 */
export function resolveZoteroPath(cliPath?: string): string {
  if (cliPath) return expandTilde(cliPath);
  const envPath = process.env['PC_ZOTERO_PATH'];
  if (envPath) return expandTilde(envPath);
  const cfg = loadGlobalConfig();
  if (cfg.zotero_path) return expandTilde(cfg.zotero_path);
  return expandTilde('~/Zotero');
}

/** Save the nexus-level config. */
export function saveNexusConfig(nexusPath: string, cfg: NexusConfig): void {
  const path = nexusConfigPath(nexusPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(cfg), 'utf-8');
}

// -- Token accessors with env override --

/** Get the ASTA API key (env: `PC_ASTA_API_KEY`, `ASTA_API_KEY`). */
export function getAstaApiKey(): string {
  return envOrConfig(['PC_ASTA_API_KEY', 'ASTA_API_KEY'], loadGlobalConfig().asta_api_key);
}

/** Get the GitHub token (env: `PC_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`). */
export function getGitHubToken(): string {
  return envOrConfig(
    ['PC_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'],
    loadGlobalConfig().github_token,
  );
}

/** Get the Slack bot token (env: `PC_SLACK_TOKEN`, `SLACK_BOT_TOKEN`). */
export function getSlackBotToken(): string {
  return envOrConfig(
    ['PC_SLACK_TOKEN', 'SLACK_BOT_TOKEN'],
    loadGlobalConfig().slack_bot_token,
  );
}

/** Validate that a PDF reader value is known. */
export function validatePdfReader(reader: string): void {
  if (reader && !VALID_READERS.includes(reader as (typeof VALID_READERS)[number])) {
    throw new Error(`Invalid pdf_reader: ${reader} (valid: ${VALID_READERS.join(', ')})`);
  }
}

/** Validate that a path exists and is a directory. */
export function validateDirectoryPath(path: string): void {
  if (!path) return;
  const expanded = expandTilde(path);
  if (!existsSync(expanded)) {
    throw new Error(`Path does not exist: ${expanded}`);
  }
  if (!statSync(expanded).isDirectory()) {
    throw new Error(`Path is not a directory: ${expanded}`);
  }
}
