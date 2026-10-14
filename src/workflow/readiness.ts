/**
 * Workflow readiness check and cruft interception module.
 *
 * Inspects working tree status to categorize uncommitted changes into
 * legitimate source/config/doc files versus transient output artifacts (cruft).
 * Enforces zero-artifact quarantine by intercepting cruft files and blocking
 * gate passage.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Prefixes exempt from media and data file cruft interception.
 * Files in these directories are intended for version control (e.g. diagrams, test fixtures).
 */
export const EXEMPT_PREFIXES: readonly string[] = [
  'docs/',
  'assets/',
  'tests/fixtures/',
  'testdata/',
];

/**
 * Model checkpoint and serialization extensions that are always categorized as cruft.
 */
export const MODEL_CRUFT_EXTENSIONS: readonly string[] = [
  '.joblib',
  '.pt',
  '.pth',
  '.bin',
  '.onnx',
  '.pkl',
  '.pickle',
  '.h5',
  '.keras',
];

/**
 * Tabular and numerical data extensions categorized as cruft outside exempt paths.
 */
export const DATA_CRUFT_EXTENSIONS: readonly string[] = [
  '.tsv',
  '.csv',
  '.parquet',
  '.feather',
  '.arrow',
  '.npy',
  '.npz',
];

/**
 * Media and plot extensions categorized as cruft outside exempt paths.
 */
export const MEDIA_CRUFT_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.pdf',
];

/**
 * Determines whether a given repository file path represents transient cruft or an output artifact.
 *
 * @param filePath - Relative path of the file in the repository.
 * @returns True if the file matches cruft patterns; false if it is legitimate.
 */
export function isCruftFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^["']|["']$/g, '');

  // Any file or directory within output/ or results/ is cruft
  if (/(?:^|\/)(?:output|results)(?:\/|$)/i.test(normalized)) {
    return true;
  }

  // Cache or temporary compiler output directories
  if (/(?:^|\/)(?:__pycache__|\.cache)\//i.test(normalized) || /\.pyc$/i.test(normalized)) {
    return true;
  }

  const lower = normalized.toLowerCase();

  // Model checkpoints and weights are always intercepted anywhere in the repo
  if (MODEL_CRUFT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return true;
  }

  // If located in documentation or test fixture paths, media and data files are allowed
  if (EXEMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }

  // Data outputs and tabular dumps outside exempt paths are cruft
  if (DATA_CRUFT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return true;
  }

  // Plot and image outputs outside exempt paths are cruft
  if (MEDIA_CRUFT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return true;
  }

  return false;
}

/**
 * Parses a single line from `git status --short`.
 *
 * @param line - Raw line from git status output.
 * @returns Parsed status code and relative file path, or null if unparseable.
 */
export function parseGitStatusLine(line: string): { statusCode: string; path: string } | null {
  const trimmed = line.trimEnd();
  if (trimmed.length < 3) return null;

  const statusCode = trimmed.slice(0, 2);
  let pathPart = trimmed.slice(3).trim();

  // Handle renames (e.g. 'R  old -> new')
  if (pathPart.includes(' -> ')) {
    const parts = pathPart.split(' -> ');
    pathPart = parts[1] ?? pathPart;
  }

  // Strip surrounding quotes if path was quoted by git
  if (
    (pathPart.startsWith('"') && pathPart.endsWith('"')) ||
    (pathPart.startsWith("'") && pathPart.endsWith("'"))
  ) {
    pathPart = pathPart.slice(1, -1);
  }

  return { statusCode, path: pathPart };
}

/**
 * Result of categorizing uncommitted git status changes.
 */
export interface CategorizedChanges {
  /** Paths of transient cruft/output files */
  cruft: string[];
  /** Paths of legitimate modified or new source/config/doc files */
  legitimate: string[];
}

/**
 * Categorizes the output of `git status --short` into legitimate files and transient cruft.
 *
 * @param statusOutput - Combined stdout string from `git status --short`.
 * @returns Categorized uncommitted files.
 */
export function categorizeGitStatus(statusOutput: string): CategorizedChanges {
  const lines = statusOutput.split('\n').filter((l) => l.trim().length > 0);
  const cruft: string[] = [];
  const legitimate: string[] = [];

  for (const line of lines) {
    const parsed = parseGitStatusLine(line);
    if (!parsed) continue;

    if (isCruftFile(parsed.path)) {
      cruft.push(parsed.path);
    } else {
      legitimate.push(parsed.path);
    }
  }

  return { cruft, legitimate };
}

/**
 * Outcome of the worktree readiness evaluation.
 */
export interface ReadinessResult {
  /** True when the working tree contains zero uncommitted changes */
  clean: boolean;
  /** True when transient cruft files were detected */
  hasCruft: boolean;
  /** List of detected cruft file paths */
  cruftFiles: string[];
  /** List of detected legitimate uncommitted file paths */
  legitimateFiles: string[];
  /**
   * Whether the gate prompts the user/agent to stage and commit.
   * STRICTLY FALSE when cruft is present.
   */
  shouldPromptCommit: boolean;
  /** Process exit code representing gate result (0 for clean, 1 for blocked/uncommitted) */
  exitCode: number;
  /** Human-readable actionable guidance message */
  message: string;
}

/**
 * Options for evaluating worktree readiness.
 */
export interface ReadinessOptions {
  /** Working directory of the git repository to inspect (defaults to process.cwd()) */
  cwd?: string;
  /** Pre-captured output of `git status --short` (skips executing git if provided) */
  statusOutput?: string;
}

/**
 * Evaluates worktree readiness defensively.
 *
 * Inspects uncommitted changes, intercepts artifact cruft, and blocks gate passage
 * whenever transient cruft patterns exist in the working tree.
 *
 * @param options - Inspection options including optional cwd or statusOutput.
 * @returns Structured readiness evaluation result.
 */
export function checkWorktreeReadiness(options: ReadinessOptions = {}): ReadinessResult {
  let statusOutput = options.statusOutput;

  if (statusOutput === undefined) {
    try {
      statusOutput = execSync('git status --short -uall', {
        cwd: options.cwd ?? process.cwd(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        clean: false,
        hasCruft: false,
        cruftFiles: [],
        legitimateFiles: [],
        shouldPromptCommit: false,
        exitCode: 1,
        message: `Failed to inspect git status: ${errorMsg}`,
      };
    }
  }

  const { cruft, legitimate } = categorizeGitStatus(statusOutput);

  if (cruft.length > 0) {
    const cruftList = cruft.map((f) => `  - ${f}`).join('\n');
    const warning = [
      '🚨 Cruft / transient output artifacts detected in working tree.',
      'Cruft files must never be committed to git.',
      'Please clean them, ignore them in .gitignore, or move them to _ignore/ before proceeding:',
      cruftList,
    ].join('\n');

    return {
      clean: false,
      hasCruft: true,
      cruftFiles: cruft,
      legitimateFiles: legitimate,
      shouldPromptCommit: false,
      exitCode: 1,
      message: warning,
    };
  }

  if (legitimate.length > 0) {
    const legitimateList = legitimate.map((f) => `  - ${f}`).join('\n');
    const msg = [
      'Uncommitted legitimate changes detected:',
      legitimateList,
      'Prompt for selective per-file staging (git add <file>) before proceeding.',
    ].join('\n');

    return {
      clean: false,
      hasCruft: false,
      cruftFiles: [],
      legitimateFiles: legitimate,
      shouldPromptCommit: true,
      exitCode: 1,
      message: msg,
    };
  }

  return {
    clean: true,
    hasCruft: false,
    cruftFiles: [],
    legitimateFiles: [],
    shouldPromptCommit: false,
    exitCode: 0,
    message: 'Worktree is clean.',
  };
}

/**
 * Runs the worktree readiness check and logs the result to console.
 *
 * @param cwd - Repository working directory.
 * @returns Readiness check outcome.
 */
export function runReadinessCheck(cwd?: string): ReadinessResult {
  const result = checkWorktreeReadiness({ cwd });
  if (result.hasCruft) {
    console.error(result.message);
  } else if (!result.clean) {
    console.warn(result.message);
  } else {
    console.log(result.message);
  }
  return result;
}

// CLI entrypoint execution when run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runReadinessCheck();
  process.exit(result.exitCode);
}
