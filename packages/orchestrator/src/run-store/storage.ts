import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type PendingCommit,
  type PendingEnvelope,
  type RunCommit,
  type RunStorageInspection,
  StorageError,
  StorageInconsistentError,
  StorageIOError,
} from "./types.js";

/**
 * Atomically writes data to filePath serialized as formatted JSON.
 * Writes to a temporary file in the same directory, flushes via fsync,
 * and renames to target path. Cleans up temp file on failure.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}`;
  try {
    const descriptor = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(descriptor, JSON.stringify(data, null, 2) + "\n");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Temp file cleanup failure should not mask the primary error
      }
    }
  }
}

/**
 * Returns the absolute path to state.json in the specified root directory.
 */
export function getStateFilePath(root: string): string {
  return path.join(path.resolve(root), "state.json");
}

/**
 * Returns the absolute path to pending-commit.json in the specified root directory.
 */
export function getPendingCommitPath(root: string): string {
  return path.join(path.resolve(root), "pending-commit.json");
}

/**
 * Validates that an envelope filename is a non-empty relative path
 * that stays strictly within the resolved root directory.
 */
function validateAndResolveEnvelopePath(root: string, filename: unknown): string {
  if (typeof filename !== "string" || !filename.trim()) {
    throw new StorageInconsistentError(
      "Invalid envelope filename: must be a non-empty relative filename",
    );
  }
  if (path.isAbsolute(filename)) {
    throw new StorageInconsistentError(
      `Invalid envelope filename: absolute path not allowed (${filename})`,
    );
  }
  const resolvedRoot = path.resolve(root);
  const targetPath = path.resolve(resolvedRoot, filename);
  const rel = path.relative(resolvedRoot, targetPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new StorageInconsistentError(
      `Invalid envelope filename: path traversal not allowed (${filename})`,
    );
  }
  return targetPath;
}

/**
 * Verifies an existing envelope file against expectedContent if it already exists.
 * Returns true if the file exists and matches; false if it does not exist.
 * Throws StorageInconsistentError if unreadable, malformed JSON, or unequal.
 */
function assertEnvelopeCompatible(
  envPath: string,
  expectedContent: unknown,
  conflictErrorMessage: string,
): boolean {
  if (!pathExists(envPath)) {
    return false;
  }
  let existingContent: unknown;
  try {
    existingContent = JSON.parse(fs.readFileSync(envPath, "utf8"));
  } catch {
    throw new StorageInconsistentError(conflictErrorMessage);
  }
  if (!isDeepStrictEqual(existingContent, expectedContent)) {
    throw new StorageInconsistentError(conflictErrorMessage);
  }
  return true;
}

/**
 * Verifies or writes an envelope file during commit or recovery.
 * If the file exists, validates that its content matches; otherwise writes it atomically.
 */
function applyEnvelope(
  root: string,
  envelope: PendingEnvelope,
  conflictErrorMessage: string,
): void {
  const envPath = validateAndResolveEnvelopePath(root, envelope.filename);
  if (!assertEnvelopeCompatible(envPath, envelope.content, conflictErrorMessage)) {
    atomicWriteJson(envPath, envelope.content);
  }
}

/**
 * Validates the persisted shape of a pending-commit.json record.
 */
function isValidPendingCommit<TState = unknown>(
  raw: unknown,
): raw is PendingCommit<TState> {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as { version?: unknown }).version !== "1.0" ||
    !("target_state" in raw)
  ) {
    return false;
  }
  const envelope = (raw as { envelope?: unknown }).envelope;
  if (envelope !== undefined && envelope !== null) {
    if (
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      typeof (envelope as { filename?: unknown }).filename !== "string" ||
      !("content" in envelope)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Loads the current run state from the specified root directory.
 * If an interrupted commit record (pending-commit.json) exists, applies
 * recovery according to durable 2-phase commit rules:
 * - Case A: State matches expected_previous_state (or neither state.json exists nor expected_previous_state):
 *   completes envelope & state write, removes pending-commit.json, returns target_state.
 * - Case B: State already matches target_state:
 *   ensures envelope is consistent/written, removes pending-commit.json, returns target_state.
 * - Case C: State matches neither expected_previous_state nor target_state:
 *   throws StorageInconsistentError and preserves files without modifying them.
 *
 * If no pending-commit.json exists:
 * - Reads and returns state.json, throwing StorageError(..., "STATE_NOT_FOUND") if not found.
 */
export function loadRun<TState = unknown>(root: string): TState {
  const resolvedRoot = path.resolve(root);
  const pendingPath = getPendingCommitPath(resolvedRoot);
  const statePath = getStateFilePath(resolvedRoot);

  if (fs.existsSync(pendingPath)) {
    let pendingRaw: unknown;
    try {
      pendingRaw = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    } catch {
      throw new StorageInconsistentError(
        `Malformed pending-commit record at ${pendingPath}`,
      );
    }

    if (!isValidPendingCommit<TState>(pendingRaw)) {
      throw new StorageInconsistentError(
        `Malformed pending-commit record at ${pendingPath}`,
      );
    }

    const pending = pendingRaw;

    const stateExists = fs.existsSync(statePath);
    let diskState: unknown = undefined;
    let stateReadFailed = false;

    if (stateExists) {
      try {
        diskState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      } catch {
        stateReadFailed = true;
      }
    }

    const matchesExpected =
      (!stateExists && pending.expected_previous_state === null) ||
      (stateExists &&
        !stateReadFailed &&
        isDeepStrictEqual(diskState, pending.expected_previous_state));

    const matchesTarget =
      stateExists &&
      !stateReadFailed &&
      isDeepStrictEqual(diskState, pending.target_state);

    if (matchesExpected) {
      if (pending.envelope) {
        applyEnvelope(
          resolvedRoot,
          pending.envelope,
          "Envelope already exists with conflicting content during pending commit recovery",
        );
      }
      atomicWriteJson(statePath, pending.target_state);
      if (fs.existsSync(pendingPath)) {
        fs.unlinkSync(pendingPath);
      }
      return pending.target_state;
    }

    if (matchesTarget) {
      if (pending.envelope) {
        applyEnvelope(
          resolvedRoot,
          pending.envelope,
          "Envelope already exists with conflicting content during pending commit recovery",
        );
      }
      if (fs.existsSync(pendingPath)) {
        fs.unlinkSync(pendingPath);
      }
      return pending.target_state;
    }

    throw new StorageInconsistentError(
      "Storage inconsistent: disk state matches neither expected previous state nor target state of pending commit",
    );
  }

  if (!fs.existsSync(statePath)) {
    throw new StorageError(
      `State file not found at ${statePath}. Run 'init' first.`,
      "STATE_NOT_FOUND",
    );
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as TState;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StorageInconsistentError(
        `Malformed state file at ${statePath}: ${error.message}`,
      );
    }
    throw new StorageIOError(
      `Failed to read state file at ${statePath}: ${String(error)}`,
    );
  }
}

/**
 * Commits a state transition and optional envelope atomically to disk.
 * Uses a pending-commit record (pending-commit.json) as a durable 2-phase write log:
 * 1. Validates preconditions (expected_previous_state, relative envelope path,
 *    and preflight compatibility of any pre-existing envelope file).
 * 2. Writes pending-commit.json atomically.
 * 3. Writes envelope atomically (verifying content if already exists).
 * 4. Writes state.json atomically.
 * 5. Cleans up pending-commit.json.
 */
export function commitRun<TState = unknown>(
  root: string,
  commit: RunCommit<TState>,
): void {
  const resolvedRoot = path.resolve(root);
  const envelopePath = commit.envelope
    ? validateAndResolveEnvelopePath(resolvedRoot, commit.envelope.filename)
    : null;

  const statePath = getStateFilePath(resolvedRoot);
  const stateExists = fs.existsSync(statePath);
  let diskState: unknown = undefined;
  let stateReadFailed = false;

  if (stateExists) {
    try {
      diskState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      stateReadFailed = true;
    }
  }

  if (commit.is_initial || commit.expected_previous_state === null) {
    if (stateExists) {
      if (stateReadFailed || !isDeepStrictEqual(diskState, commit.target_state)) {
        throw new StorageInconsistentError(
          "Initial commit conflict: state.json already exists",
        );
      }
    }
  } else {
    if (
      !stateExists ||
      stateReadFailed ||
      !isDeepStrictEqual(diskState, commit.expected_previous_state)
    ) {
      throw new StorageInconsistentError(
        "Precondition failed: current state does not match expected_previous_state",
      );
    }
  }

  // Preflight any pre-existing envelope file before persisting pending-commit.json
  // so predictable conflicts leave both state.json and pending-commit.json untouched.
  if (commit.envelope && envelopePath) {
    assertEnvelopeCompatible(
      envelopePath,
      commit.envelope.content,
      "Envelope file exists with conflicting content",
    );
  }

  const pendingPath = getPendingCommitPath(resolvedRoot);
  const pending: PendingCommit<TState> = {
    version: "1.0",
    expected_previous_state: commit.expected_previous_state,
    target_state: commit.target_state,
    envelope: commit.envelope ?? null,
  };
  atomicWriteJson(pendingPath, pending);

  if (commit.envelope) {
    applyEnvelope(
      resolvedRoot,
      commit.envelope,
      "Envelope file exists with conflicting content",
    );
  }

  atomicWriteJson(statePath, commit.target_state);

  if (fs.existsSync(pendingPath)) {
    fs.unlinkSync(pendingPath);
  }
}

/** Returns false only for ENOENT; any other stat failure (e.g. EACCES) throws. */
function pathExists(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new StorageIOError(
      `Cannot access ${filePath}: ${(error as Error).message}`,
    );
  }
}

const INPUT_ENVELOPE_ARTIFACT_RE = /^\d+-input\.json$/;
const DISPATCH_RECEIPT_ARTIFACT_RE = /^\d+-.+\.md$/;

function isDispatchArtifact(filename: string): boolean {
  return (
    INPUT_ENVELOPE_ARTIFACT_RE.test(filename) ||
    DISPATCH_RECEIPT_ARTIFACT_RE.test(filename)
  );
}

/**
 * Lists recognized dispatch artifacts (numbered input envelopes and receipt files)
 * directly inside resolvedRoot, sorted lexicographically.
 * Throws StorageIOError advising a new run directory if resolvedRoot is not a
 * readable directory.
 */
function findDispatchArtifacts(resolvedRoot: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(resolvedRoot);
  } catch (error) {
    throw new StorageIOError(
      `Cannot inspect run directory ${resolvedRoot}: ${(error as Error).message}. Use a new run directory.`,
    );
  }
  return entries.filter(isDispatchArtifact).sort();
}

function rejectIfDispatchArtifactsExist(resolvedRoot: string): void {
  const dispatchArtifacts = findDispatchArtifacts(resolvedRoot);
  if (dispatchArtifacts.length > 0) {
    throw new StorageError(
      `Cannot replace run in ${resolvedRoot}: dispatch artifacts exist (${dispatchArtifacts.join(", ")}). Use a new run directory.`,
      "STORAGE_REPLACE_REJECTED",
    );
  }
}

/**
 * Purely observational inspection of a run directory's storage artifacts.
 * Does not modify any files or run pending-commit recovery.
 */
export function inspectRunStorage<TState = unknown>(
  root: string,
): RunStorageInspection<TState> {
  const resolvedRoot = path.resolve(root);
  if (!pathExists(resolvedRoot)) {
    return {
      exists: false,
      stateExists: false,
      pendingExists: false,
      state: null,
      stateCorrupt: false,
      pending: null,
      pendingCorrupt: false,
      dispatchArtifacts: [],
    };
  }

  const dispatchArtifacts = findDispatchArtifacts(resolvedRoot);

  const statePath = getStateFilePath(resolvedRoot);
  const stateExists = pathExists(statePath);
  let state: TState | null = null;
  let stateCorrupt = false;
  if (stateExists) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8")) as TState;
    } catch (error) {
      if (error instanceof SyntaxError) {
        stateCorrupt = true;
      } else {
        throw new StorageIOError(
          `Failed to read state file at ${statePath}: ${String(error)}`,
        );
      }
    }
  }

  const pendingPath = getPendingCommitPath(resolvedRoot);
  const pendingExists = pathExists(pendingPath);
  let pending: PendingCommit<TState> | null = null;
  let pendingCorrupt = false;
  if (pendingExists) {
    try {
      const pendingRaw: unknown = JSON.parse(
        fs.readFileSync(pendingPath, "utf8"),
      );
      if (isValidPendingCommit<TState>(pendingRaw)) {
        pending = pendingRaw;
      } else {
        pendingCorrupt = true;
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        pendingCorrupt = true;
      } else {
        throw new StorageIOError(
          `Failed to read pending-commit file at ${pendingPath}: ${String(error)}`,
        );
      }
    }
  }

  return {
    exists: true,
    stateExists,
    pendingExists,
    state,
    stateCorrupt,
    pending,
    pendingCorrupt,
    dispatchArtifacts,
  };
}

/**
 * Loads the run state if one exists, otherwise returns null.
 * Null is returned only when neither state.json nor pending-commit.json
 * exists. Pending-commit recovery still runs; malformed or unreadable
 * storage throws instead of being treated as "no run".
 *
 * Operations on one run directory must be serialized by the caller; this
 * module provides crash recovery, not cross-process locking.
 */
export function loadRunIfExists<TState = unknown>(root: string): TState | null {
  const resolvedRoot = path.resolve(root);
  if (
    !pathExists(getStateFilePath(resolvedRoot)) &&
    !pathExists(getPendingCommitPath(resolvedRoot))
  ) {
    return null;
  }
  return loadRun<TState>(resolvedRoot);
}

/**
 * Explicitly replaces any existing run with target_state (force semantics).
 * - Valid or recoverable old state is replaced through a normal commit.
 * - Corrupt/inconsistent old state or pending files are preserved as
 *   `<name>.corrupt-<timestamp>` evidence files before replacement, unless
 *   dispatch artifacts exist in the directory (in which case replacement is
 *   rejected without modifying or renaming any files).
 * - I/O and permission errors are never treated as "not found"; if the old
 *   files cannot be safely replaced a StorageError is thrown advising a new
 *   run directory.
 *
 * Operations on one run directory must be serialized by the caller.
 */
export function replaceRun<TState = unknown>(
  root: string,
  targetState: TState,
): void {
  const resolvedRoot = path.resolve(root);
  let existing: TState | null;
  let checkedArtifacts = false;
  try {
    existing = loadRunIfExists<TState>(resolvedRoot);
  } catch (error) {
    if (!(error instanceof StorageInconsistentError)) throw error;
    rejectIfDispatchArtifactsExist(resolvedRoot);
    checkedArtifacts = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      for (const file of [
        getStateFilePath(resolvedRoot),
        getPendingCommitPath(resolvedRoot),
      ]) {
        if (pathExists(file)) fs.renameSync(file, `${file}.corrupt-${stamp}`);
      }
    } catch (renameError) {
      throw new StorageError(
        `Cannot safely replace corrupt run state in ${resolvedRoot}: ${(renameError as Error).message}. Use a new run directory.`,
        "STORAGE_REPLACE_FAILED",
      );
    }
    existing = null;
  }
  if (!checkedArtifacts && pathExists(resolvedRoot)) {
    rejectIfDispatchArtifactsExist(resolvedRoot);
  }
  commitRun<TState>(resolvedRoot, {
    is_initial: existing === null,
    expected_previous_state: existing,
    target_state: targetState,
  });
}
