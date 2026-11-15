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

/** Atomically replaces one file with a flushed, same-directory temporary file. */
function atomicWriteString(filePath: string, content: string): void {
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

function atomicWriteJson(filePath: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2) + "\n";
  atomicWriteString(filePath, content);
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
  serializedContent?: string,
): void {
  const envPath = validateAndResolveEnvelopePath(root, envelope.filename);
  if (
    !assertEnvelopeCompatible(envPath, envelope.content, conflictErrorMessage)
  ) {
    if (serializedContent !== undefined) {
      atomicWriteString(envPath, serializedContent);
    } else {
      atomicWriteJson(envPath, envelope.content);
    }
  }
}

function encodeJson(data: unknown, description: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data, null, 2);
  } catch (error) {
    throw new StorageError(
      `Invalid commit input: failed to serialize ${description} to JSON: ${String(error)}`,
      "STORAGE_INVALID_INPUT",
    );
  }
  if (serialized === undefined) {
    throw new StorageError(
      `Invalid commit input: ${description} cannot be serialized to JSON`,
      "STORAGE_INVALID_INPUT",
    );
  }
  return serialized + "\n";
}

interface PendingValidationResult {
  valid: boolean;
  error?: string;
}

function validatePendingStructure(raw: unknown): PendingValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, error: "pending commit record must be an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== "1.0") {
    return { valid: false, error: "pending commit version must be '1.0'" };
  }
  if (
    !("expected_previous_state" in record) ||
    record.expected_previous_state === undefined
  ) {
    return {
      valid: false,
      error: "pending commit must contain expected_previous_state",
    };
  }
  if (
    record.expected_previous_state !== null &&
    (typeof record.expected_previous_state !== "object" ||
      Array.isArray(record.expected_previous_state))
  ) {
    return {
      valid: false,
      error:
        "pending commit expected_previous_state must be an object or null",
    };
  }
  if (
    !("target_state" in record) ||
    record.target_state === null ||
    record.target_state === undefined ||
    typeof record.target_state !== "object" ||
    Array.isArray(record.target_state)
  ) {
    return {
      valid: false,
      error: "pending commit must contain non-null target_state",
    };
  }
  if (
    "envelope" in record &&
    record.envelope !== null &&
    record.envelope !== undefined
  ) {
    const env = record.envelope;
    if (typeof env !== "object" || Array.isArray(env) || env === null) {
      return {
        valid: false,
        error: "pending commit envelope must be an object",
      };
    }
    const envRec = env as Record<string, unknown>;
    if (!("filename" in envRec) || typeof envRec.filename !== "string") {
      return {
        valid: false,
        error: "pending commit envelope must have a string filename",
      };
    }
    if (!("content" in envRec) || envRec.content === undefined) {
      return {
        valid: false,
        error: "pending commit envelope content must not be undefined",
      };
    }
  }
  return { valid: true };
}

/** Reads and validates the persisted shape and envelope path before recovery. */
function readPendingCommit<TState>(
  root: string,
  pendingPath: string,
): PendingCommit<TState> {
  const malformed = `Malformed pending-commit record at ${pendingPath}`;
  const raw = readJson(pendingPath, malformed);
  const validation = validatePendingStructure(raw);
  if (!validation.valid) {
    throw new StorageInconsistentError(malformed);
  }

  const candidate = raw as PendingCommit<TState>;
  if (candidate.envelope) {
    validateAndResolveEnvelopePath(root, candidate.envelope.filename);
  }

  return candidate;
}

function readState<TState>(statePath: string): TState {
  const raw = readJson<TState>(
    statePath,
    `Malformed state file at ${statePath}`,
  );
  if (
    raw === null ||
    raw === undefined ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    throw new StorageInconsistentError("Persisted state cannot be null");
  }
  return raw;
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
    const diskState = stateExists ? readState<TState>(statePath) : undefined;
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
  if (!commit || typeof commit !== "object" || Array.isArray(commit)) {
    throw new StorageError(
      "Invalid commit input: commit must be an object",
      "STORAGE_INVALID_INPUT",
    );
  }

  if (
    !("expected_previous_state" in commit) ||
    commit.expected_previous_state === undefined
  ) {
    throw new StorageError(
      "Invalid commit input: expected_previous_state is required and cannot be undefined",
      "STORAGE_INVALID_INPUT",
    );
  }

  if (
    commit.expected_previous_state !== null &&
    (typeof commit.expected_previous_state !== "object" ||
      Array.isArray(commit.expected_previous_state))
  ) {
    throw new StorageError(
      "Invalid commit input: expected_previous_state must be an object or null",
      "STORAGE_INVALID_INPUT",
    );
  }

  if (
    !("target_state" in commit) ||
    commit.target_state === null ||
    commit.target_state === undefined ||
    typeof commit.target_state !== "object" ||
    Array.isArray(commit.target_state)
  ) {
    throw new StorageError(
      "Invalid commit input: target_state must be a non-null object",
      "STORAGE_INVALID_INPUT",
    );
  }

  const resolvedRoot = path.resolve(root);

  let envelopePath: string | null = null;
  if (commit.envelope !== undefined && commit.envelope !== null) {
    if (typeof commit.envelope !== "object" || Array.isArray(commit.envelope)) {
      throw new StorageError(
        "Invalid commit input: envelope must be an object",
        "STORAGE_INVALID_INPUT",
      );
    }
    if (
      !("content" in commit.envelope) ||
      commit.envelope.content === undefined
    ) {
      throw new StorageError(
        "Invalid commit input: envelope content must not be undefined",
        "STORAGE_INVALID_INPUT",
      );
    }
    envelopePath = validateAndResolveEnvelopePath(
      resolvedRoot,
      commit.envelope.filename,
    );
  }

  // Preflight serialization before any filesystem mutation
  const serializedTarget = encodeJson(commit.target_state, "target_state");
  const parsedTarget = JSON.parse(serializedTarget);

  let serializedEnvelopeContent: string | null = null;
  let parsedEnvelopeContent: unknown = undefined;
  if (commit.envelope) {
    serializedEnvelopeContent = encodeJson(
      commit.envelope.content,
      "envelope content",
    );
    parsedEnvelopeContent = JSON.parse(serializedEnvelopeContent);
  }

  if (commit.expected_previous_state !== null) {
    encodeJson(commit.expected_previous_state, "expected_previous_state");
  }

  const pendingRecord: PendingCommit<TState> = {
    version: "1.0",
    expected_previous_state: commit.expected_previous_state,
    target_state: commit.target_state,
    envelope: commit.envelope
      ? {
          filename: commit.envelope.filename,
          content: commit.envelope.content,
        }
      : null,
  };
  const serializedPending = encodeJson(pendingRecord, "pending commit");
  const parsedPending = JSON.parse(serializedPending);

  const pendingValidation = validatePendingStructure(parsedPending);
  if (!pendingValidation.valid) {
    throw new StorageError(
      `Invalid commit input: ${pendingValidation.error}`,
      "STORAGE_INVALID_INPUT",
    );
  }

  if (!isDeepStrictEqual(parsedPending.target_state, parsedTarget)) {
    throw new StorageError(
      "Invalid commit input: serialized target_state does not match pending-commit target_state",
      "STORAGE_INVALID_INPUT",
    );
  }

  if (commit.envelope) {
    if (
      !isDeepStrictEqual(
        parsedPending.envelope?.content,
        parsedEnvelopeContent,
      )
    ) {
      throw new StorageError(
        "Invalid commit input: serialized envelope content does not match pending-commit envelope content",
        "STORAGE_INVALID_INPUT",
      );
    }
  }

  const pendingPath = getPendingCommitPath(resolvedRoot);
  if (pathExists(pendingPath)) {
    throw new StorageError(
      `Pending commit exists at ${pendingPath}. Load the run to recover it before committing.`,
      "STORAGE_RECOVERY_REQUIRED",
    );
  }

  const statePath = getStateFilePath(resolvedRoot);
  const stateExists = pathExists(statePath);
  const diskState = stateExists ? readState<TState>(statePath) : undefined;

  if (commit.expected_previous_state === null) {
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

  atomicWriteString(pendingPath, serializedPending);

  if (commit.envelope) {
    applyEnvelope(
      resolvedRoot,
      commit.envelope,
      "Envelope file exists with conflicting content",
      serializedEnvelopeContent!,
    );
  }

  atomicWriteString(statePath, serializedTarget);

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

function validateAndSerializeTargetState(targetState: unknown): string {
  if (
    targetState === null ||
    targetState === undefined ||
    typeof targetState !== "object" ||
    Array.isArray(targetState)
  ) {
    throw new StorageError(
      "Invalid commit input: target_state must be a non-null object",
      "STORAGE_INVALID_INPUT",
    );
  }
  const serialized = encodeJson(targetState, "target_state");
  const parsed = JSON.parse(serialized);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new StorageError(
      "Invalid commit input: target_state cannot be serialized to a JSON object",
      "STORAGE_INVALID_INPUT",
    );
  }
  return serialized;
}

/**
 * Explicitly replaces any existing run with target_state (force semantics).
 * Validates targetState before inspecting old storage or archiving corrupt files.
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
  validateAndSerializeTargetState(targetState);
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
    expected_previous_state: existing,
    target_state: targetState,
  });
}
