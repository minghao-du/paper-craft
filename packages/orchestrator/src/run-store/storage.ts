import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type PendingCommit,
  type PendingEnvelope,
  type RunCommit,
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
 * Verifies or writes an envelope file during commit or recovery.
 * If the file exists, validates that its content matches; otherwise writes it atomically.
 */
function applyEnvelope(
  root: string,
  envelope: PendingEnvelope,
  conflictErrorMessage: string,
): void {
  const envPath = validateAndResolveEnvelopePath(root, envelope.filename);
  if (fs.existsSync(envPath)) {
    let existingContent: unknown;
    try {
      existingContent = JSON.parse(fs.readFileSync(envPath, "utf8"));
    } catch {
      throw new StorageInconsistentError(conflictErrorMessage);
    }
    if (!isDeepStrictEqual(existingContent, envelope.content)) {
      throw new StorageInconsistentError(conflictErrorMessage);
    }
  } else {
    atomicWriteJson(envPath, envelope.content);
  }
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

    if (
      pendingRaw === null ||
      typeof pendingRaw !== "object" ||
      Array.isArray(pendingRaw) ||
      (pendingRaw as { version?: unknown }).version !== "1.0" ||
      !("target_state" in pendingRaw)
    ) {
      throw new StorageInconsistentError(
        `Malformed pending-commit record at ${pendingPath}`,
      );
    }

    const pending = pendingRaw as PendingCommit<TState>;

    if (pending.envelope !== undefined && pending.envelope !== null) {
      if (
        typeof pending.envelope !== "object" ||
        Array.isArray(pending.envelope) ||
        typeof pending.envelope.filename !== "string" ||
        !("content" in pending.envelope)
      ) {
        throw new StorageInconsistentError(
          `Malformed pending-commit record at ${pendingPath}`,
        );
      }
    }

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
 * 1. Validates preconditions (expected_previous_state, relative envelope path).
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

  if (commit.envelope) {
    validateAndResolveEnvelopePath(resolvedRoot, commit.envelope.filename);
  }

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
