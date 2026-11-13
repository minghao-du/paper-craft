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

function filesystemOperation<T>(
  operation: string,
  filePath: string,
  perform: () => T,
  advice = "",
): T {
  try {
    return perform();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (!code || !/^E[A-Z0-9]+$/.test(code)) throw error;
    throw new StorageIOError(
      `Cannot ${operation} ${filePath}: ${String(error)}${advice}`,
    );
  }
}

function readJson<T>(filePath: string, malformedMessage: string): T {
  const raw = filesystemOperation("read", filePath, () =>
    fs.readFileSync(filePath, "utf8"),
  );
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new StorageInconsistentError(malformedMessage);
  }
}

function removePendingCommit(pendingPath: string): void {
  filesystemOperation("remove pending commit at", pendingPath, () =>
    fs.unlinkSync(pendingPath),
  );
}

/** Atomically replaces one JSON file with a flushed, same-directory temporary file. */
function atomicWriteJson(filePath: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2) + "\n";
  const dir = path.dirname(filePath);
  filesystemOperation("create directory", dir, () =>
    fs.mkdirSync(dir, { recursive: true }),
  );
  const temporary = `${filePath}.tmp.${process.pid}`;
  try {
    const descriptor = filesystemOperation("open", temporary, () =>
      fs.openSync(temporary, "w"),
    );
    try {
      filesystemOperation("write", temporary, () =>
        fs.writeFileSync(descriptor, content),
      );
      filesystemOperation("flush", temporary, () => fs.fsyncSync(descriptor));
    } catch (error) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the write or flush failure.
      }
      throw error;
    }
    filesystemOperation("close", temporary, () => fs.closeSync(descriptor));
    filesystemOperation(`rename ${temporary} to`, filePath, () =>
      fs.renameSync(temporary, filePath),
    );
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the primary persistence failure.
    }
    throw error;
  }
}

function getStateFilePath(root: string): string {
  return path.join(root, "state.json");
}

function getPendingCommitPath(root: string): string {
  return path.join(root, "pending-commit.json");
}

/**
 * Validates that an envelope filename is a non-empty relative path
 * that stays strictly within the resolved root directory.
 */
function validateAndResolveEnvelopePath(
  root: string,
  filename: unknown,
): string {
  if (
    typeof filename !== "string" ||
    !filename.trim() ||
    filename.includes("\0")
  ) {
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
  if (
    targetPath === getStateFilePath(resolvedRoot) ||
    targetPath === getPendingCommitPath(resolvedRoot)
  ) {
    throw new StorageInconsistentError(
      `Invalid envelope filename: reserved storage path (${filename})`,
    );
  }
  return targetPath;
}

/**
 * Verifies an existing envelope file against expectedContent if it already exists.
 * Returns true if the file exists and matches; false if it does not exist.
 * Throws StorageIOError on access failure and StorageInconsistentError for invalid or conflicting content.
 */
function assertEnvelopeCompatible(
  envPath: string,
  expectedContent: unknown,
  conflictErrorMessage: string,
): boolean {
  if (!pathExists(envPath)) {
    return false;
  }
  const existingContent = readJson(envPath, conflictErrorMessage);
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
  if (
    !assertEnvelopeCompatible(envPath, envelope.content, conflictErrorMessage)
  ) {
    atomicWriteJson(envPath, envelope.content);
  }
}

/** Reads and validates the persisted shape and envelope path before recovery. */
function readPendingCommit<TState>(
  root: string,
  pendingPath: string,
): PendingCommit<TState> {
  const malformed = `Malformed pending-commit record at ${pendingPath}`;
  const raw = readJson(pendingPath, malformed);
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !("version" in raw) ||
    raw.version !== "1.0" ||
    !("expected_previous_state" in raw) ||
    !("target_state" in raw)
  ) {
    throw new StorageInconsistentError(malformed);
  }

  if ("envelope" in raw && raw.envelope !== null) {
    const envelope = raw.envelope;
    if (
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      !("filename" in envelope) ||
      !("content" in envelope)
    ) {
      throw new StorageInconsistentError(malformed);
    }
    validateAndResolveEnvelopePath(root, envelope.filename);
  }

  return raw as PendingCommit<TState>;
}

function readState<TState>(statePath: string): TState {
  return readJson<TState>(statePath, `Malformed state file at ${statePath}`);
}

/**
 * Loads state and may complete an interrupted commit by writing files and
 * removing the pending record. Recovery requires the disk state to match the
 * recorded previous or target state, and any existing envelope must match.
 * Throws STATE_NOT_FOUND when neither a state file nor a pending record exists.
 */
export function loadRun<TState = unknown>(root: string): TState {
  const resolvedRoot = path.resolve(root);
  const pendingPath = getPendingCommitPath(resolvedRoot);
  const statePath = getStateFilePath(resolvedRoot);

  if (pathExists(pendingPath)) {
    const pending = readPendingCommit<TState>(resolvedRoot, pendingPath);
    const stateExists = pathExists(statePath);
    const diskState = stateExists ? readState(statePath) : undefined;
    const matchesExpected = stateExists
      ? isDeepStrictEqual(diskState, pending.expected_previous_state)
      : pending.expected_previous_state === null;
    const matchesTarget =
      stateExists && isDeepStrictEqual(diskState, pending.target_state);

    if (!matchesExpected && !matchesTarget) {
      throw new StorageInconsistentError(
        "Storage inconsistent: disk state matches neither expected previous state nor target state of pending commit",
      );
    }

    if (pending.envelope) {
      applyEnvelope(
        resolvedRoot,
        pending.envelope,
        "Envelope already exists with conflicting content during pending commit recovery",
      );
    }
    if (matchesExpected) {
      atomicWriteJson(statePath, pending.target_state);
    }
    removePendingCommit(pendingPath);
    return pending.target_state;
  }

  if (!pathExists(statePath)) {
    throw new StorageError(
      `State file not found at ${statePath}. Run 'init' first.`,
      "STATE_NOT_FOUND",
    );
  }

  return readState<TState>(statePath);
}

/**
 * Commits a state transition and optional envelope using individually atomic
 * file replacements and a pending record for recovery. Callers must serialize
 * operations on each run directory. Atomic replacement applies to each file.
 * Readers can observe partial progress, and recovery depends on the files
 * that survive an interruption.
 *
 * Preflight rejection performs no new writes. Once the pending record is
 * written, later failures may leave partial progress. Failure to remove it can
 * leave the target state on disk. Load the run to recover and check its actual
 * state before retrying.
 */
export function commitRun<TState = unknown>(
  root: string,
  commit: RunCommit<TState>,
): void {
  const resolvedRoot = path.resolve(root);
  const pendingPath = getPendingCommitPath(resolvedRoot);
  if (pathExists(pendingPath)) {
    throw new StorageError(
      `Pending commit exists at ${pendingPath}. Load the run to recover it before committing.`,
      "STORAGE_RECOVERY_REQUIRED",
    );
  }

  const envelopePath = commit.envelope
    ? validateAndResolveEnvelopePath(resolvedRoot, commit.envelope.filename)
    : null;

  const statePath = getStateFilePath(resolvedRoot);
  const stateExists = pathExists(statePath);
  const diskState = stateExists ? readState(statePath) : undefined;

  if (commit.is_initial || commit.expected_previous_state === null) {
    if (stateExists && !isDeepStrictEqual(diskState, commit.target_state)) {
      throw new StorageInconsistentError(
        "Initial commit conflict: state.json already exists",
      );
    }
  } else if (
    !stateExists ||
    !isDeepStrictEqual(diskState, commit.expected_previous_state)
  ) {
    throw new StorageInconsistentError(
      "Precondition failed: current state does not match expected_previous_state",
    );
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

  removePendingCommit(pendingPath);
}

/** Treats a directory entry as absent only when the probe reports ENOENT. */
function pathExists(filePath: string): boolean {
  return filesystemOperation("access", filePath, () => {
    try {
      fs.lstatSync(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
        return false;
      throw error;
    }
  });
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
  const entries = filesystemOperation(
    "inspect run directory",
    resolvedRoot,
    () => fs.readdirSync(resolvedRoot),
    ". Use a new run directory.",
  );
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
 * Does not modify any files or run pending-commit recovery. Lifecycle
 * inspection can recover the run because it loads through loadRun.
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
      state = readState<TState>(statePath);
    } catch (error) {
      if (!(error instanceof StorageInconsistentError)) throw error;
      stateCorrupt = true;
    }
  }

  const pendingPath = getPendingCommitPath(resolvedRoot);
  const pendingExists = pathExists(pendingPath);
  let pending: PendingCommit<TState> | null = null;
  let pendingCorrupt = false;
  if (pendingExists) {
    try {
      pending = readPendingCommit<TState>(resolvedRoot, pendingPath);
    } catch (error) {
      if (!(error instanceof StorageInconsistentError)) throw error;
      pendingCorrupt = true;
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
 * module supports recovery of interrupted commits.
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
 * Loading the old run may recover a pending commit before the dispatch artifact
 * check. When storage is inconsistent, dispatch artifacts block archiving.
 * Otherwise, corrupt evidence is renamed to `<name>.corrupt-<timestamp>`
 * before committing the replacement. I/O failures during loading propagate.
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
    for (const file of [
      getStateFilePath(resolvedRoot),
      getPendingCommitPath(resolvedRoot),
    ]) {
      if (pathExists(file)) {
        const archived = `${file}.corrupt-${stamp}`;
        filesystemOperation(`archive corrupt file ${file} at`, archived, () =>
          fs.renameSync(file, archived),
        );
      }
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
