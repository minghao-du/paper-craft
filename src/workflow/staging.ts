/**
 * Workflow selective staging and pre-commit cached diff audit module.
 *
 * Enforces zero-artifact git discipline by auditing staged files (`git diff --cached --name-only`)
 * against forbidden transient patterns, providing automatic cruft unstaging (`git reset HEAD <file>`),
 * and enforcing per-file selective staging.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isCruftFile, categorizeGitStatus, normalizeRepoPath } from './readiness.js';

/**
 * Options for staged diff inspection.
 */
export interface StagedDiffAuditOptions {
  /** Repository working directory (defaults to process.cwd()). */
  cwd?: string;
  /** Pre-captured output of `git diff --cached --name-only` (skips executing git if provided). */
  diffOutput?: string;
  /** Custom classifier function returning true if path represents cruft (defaults to isCruftFile). */
  cruftClassifier?: (filePath: string) => boolean;
}

/**
 * Result of auditing the git staged cache.
 */
export interface StagedDiffAuditResult {
  /** True when the staged diff contains zero cruft files. */
  clean: boolean;
  /** True when transient cruft files are present in the staged cache. */
  hasCruft: boolean;
  /** All files currently staged in the index. */
  stagedFiles: string[];
  /** Staged files matching forbidden transient patterns. */
  cruftFiles: string[];
  /** Staged files that are legitimate source, config, or documentation. */
  legitimateFiles: string[];
  /** Human-readable status or warning message. */
  message: string;
}

/**
 * Audits staged git cache (`git diff --cached --name-only`) against forbidden transient patterns.
 *
 * @param options - Audit options including optional cwd, diffOutput, or custom classifier.
 * @returns Structured audit result categorizing staged files into legitimate changes vs cruft.
 */
export function auditStagedDiff(options: StagedDiffAuditOptions = {}): StagedDiffAuditResult {
  let diffOutput = options.diffOutput;

  if (diffOutput === undefined) {
    try {
      diffOutput = execSync('git diff --cached --name-only', {
        cwd: options.cwd ?? process.cwd(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        clean: false,
        hasCruft: false,
        stagedFiles: [],
        cruftFiles: [],
        legitimateFiles: [],
        message: `Failed to inspect git cached diff: ${errorMsg}`,
      };
    }
  }

  const classifier = options.cruftClassifier ?? isCruftFile;
  const rawLines = diffOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const stagedFiles: string[] = [];
  const cruftFiles: string[] = [];
  const legitimateFiles: string[] = [];

  for (const rawLine of rawLines) {
    const line = normalizeRepoPath(rawLine);
    stagedFiles.push(line);

    if (classifier(line)) {
      cruftFiles.push(line);
    } else {
      legitimateFiles.push(line);
    }
  }

  if (cruftFiles.length > 0) {
    const cruftList = cruftFiles.map((f) => `  - ${f}`).join('\n');
    return {
      clean: false,
      hasCruft: true,
      stagedFiles,
      cruftFiles,
      legitimateFiles,
      message: [
        '🚨 Staged diff contains forbidden transient output artifacts.',
        'These files must be un-staged before committing:',
        cruftList,
        'Run `git reset HEAD <file>` to unstage them.',
      ].join('\n'),
    };
  }

  if (stagedFiles.length === 0) {
    return {
      clean: true,
      hasCruft: false,
      stagedFiles: [],
      cruftFiles: [],
      legitimateFiles: [],
      message: 'No changes staged for commit.',
    };
  }

  return {
    clean: true,
    hasCruft: false,
    stagedFiles,
    cruftFiles: [],
    legitimateFiles,
    message: `Staged diff is clean (${stagedFiles.length} file(s) ready for commit).`,
  };
}

/**
 * Options for unstaging files.
 */
export interface UnstageOptions {
  /** Working directory of the repository. */
  cwd?: string;
  /** Custom cruft classifier function (defaults to isCruftFile). */
  cruftClassifier?: (filePath: string) => boolean;
  /** Pre-existing audit result to avoid re-evaluating cached diff. */
  auditResult?: StagedDiffAuditResult;
}

/**
 * Result of an unstaging operation.
 */
export interface UnstageCruftResult {
  /** List of cruft file paths that were un-staged. */
  unstaged: string[];
  /** Staged diff audit result after unstaging. */
  audit: StagedDiffAuditResult;
}

/**
 * Unstages a specific list of files from the git index via `git reset HEAD <file>`.
 *
 * @param files - Array of relative file paths to unstage.
 * @param options - Options including working directory.
 * @returns Array of file paths that were un-staged.
 */
export function unstageFiles(files: string[], options: { cwd?: string } = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const unstaged: string[] = [];

  for (const rawFile of files) {
    const file = normalizeRepoPath(rawFile);
    try {
      execSync(`git reset HEAD -- ${JSON.stringify(file)}`, {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      unstaged.push(file);
    } catch {
      // In case HEAD doesn't exist yet (e.g. empty initial repo), fallback to git rm --cached
      try {
        execSync(`git rm --cached -- ${JSON.stringify(file)}`, {
          cwd,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        unstaged.push(file);
      } catch {
        // Failed to unstage
      }
    }
  }

  return unstaged;
}

/**
 * Audits staged files and automatically unstages any transient cruft via `git reset HEAD <file>`.
 *
 * @param options - Unstage options including cwd and optional pre-existing audit result.
 * @returns Object containing list of un-staged files and refreshed audit result.
 */
export function unstageCruft(options: UnstageOptions = {}): UnstageCruftResult {
  const audit = options.auditResult ?? auditStagedDiff(options);

  if (!audit.hasCruft || audit.cruftFiles.length === 0) {
    return {
      unstaged: [],
      audit,
    };
  }

  const unstaged = unstageFiles(audit.cruftFiles, { cwd: options.cwd });
  const refreshedAudit = auditStagedDiff({
    cwd: options.cwd,
    cruftClassifier: options.cruftClassifier,
  });

  return {
    unstaged,
    audit: refreshedAudit,
  };
}

/**
 * Options for selective staging.
 */
export interface SelectiveStageOptions {
  /** Working directory of the repository. */
  cwd?: string;
  /** Explicit files to stage. If omitted, discovers uncommitted legitimate files from git status. */
  files?: string[];
  /** Custom cruft classifier function (defaults to isCruftFile). */
  cruftClassifier?: (filePath: string) => boolean;
  /** Automatically unstage any cruft files present in git index after staging (defaults to true). */
  autoUnstageCruft?: boolean;
}

/**
 * Result of selective staging.
 */
export interface SelectiveStageResult {
  /** Files that were successfully staged into the git index. */
  staged: string[];
  /** Files that were refused / skipped because they match cruft patterns. */
  skippedCruft: string[];
  /** Updated audit result of the staged diff after staging. */
  audit: StagedDiffAuditResult;
}

/**
 * Selectively stages legitimate source and documentation files, refusing cruft.
 *
 * Runs per-file `git add <file>` only for files that pass cruft inspection,
 * skips transient artifacts, and audits the staged index to ensure clean diff.
 *
 * @param filesOrOptions - Array of files to stage, or options object.
 * @param maybeOptions - Options when files array is provided as first argument.
 * @returns Structured staging result.
 */
export function selectiveStage(
  filesOrOptions?: string[] | SelectiveStageOptions,
  maybeOptions?: SelectiveStageOptions
): SelectiveStageResult {
  let options: SelectiveStageOptions;
  if (Array.isArray(filesOrOptions)) {
    options = { ...maybeOptions, files: filesOrOptions };
  } else {
    options = filesOrOptions ?? {};
  }

  const cwd = options.cwd ?? process.cwd();
  const classifier = options.cruftClassifier ?? isCruftFile;
  const autoUnstage = options.autoUnstageCruft !== false;

  let candidates: string[] = [];
  const skippedCruft: string[] = [];

  if (options.files !== undefined) {
    for (const f of options.files) {
      const normalized = normalizeRepoPath(f);
      if (classifier(normalized)) {
        skippedCruft.push(normalized);
      } else {
        candidates.push(normalized);
      }
    }
  } else {
    try {
      const statusOutput = execSync('git status --short -uall', {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const categorized = categorizeGitStatus(statusOutput);
      candidates = categorized.legitimate;
      skippedCruft.push(...categorized.cruft);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        staged: [],
        skippedCruft: [],
        audit: {
          clean: false,
          hasCruft: false,
          stagedFiles: [],
          cruftFiles: [],
          legitimateFiles: [],
          message: `Failed to inspect git status for selective staging: ${errorMsg}`,
        },
      };
    }
  }

  const staged: string[] = [];
  for (const file of candidates) {
    try {
      execSync(`git add -- ${JSON.stringify(file)}`, {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      staged.push(file);
    } catch {
      // Ignore failure to add file
    }
  }

  if (autoUnstage) {
    unstageCruft({ cwd, cruftClassifier: classifier });
  }

  const audit = auditStagedDiff({ cwd, cruftClassifier: classifier });

  return {
    staged,
    skippedCruft,
    audit,
  };
}

/**
 * Runs the staged diff audit from the CLI and prints findings.
 *
 * @param cwd - Repository working directory.
 * @returns Staged diff audit result.
 */
export function runStagedDiffAudit(cwd?: string): StagedDiffAuditResult {
  const result = auditStagedDiff({ cwd });
  if (result.hasCruft) {
    console.error(result.message);
  } else {
    console.log(result.message);
  }
  return result;
}

// CLI entrypoint execution when run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runStagedDiffAudit();
  process.exit(result.clean ? 0 : 1);
}
