/**
 * RunStore types and interfaces.
 * RunStore module owns file layouts, atomic writes, pending-commit record persistence,
 * and recovery of interrupted commits for state and envelope files.
 */

export interface PendingEnvelope {
  filename: string;
  content: unknown;
}

export interface PendingCommit<TState = unknown> {
  version: "1.0";
  expected_previous_state: TState | null;
  target_state: TState;
  envelope?: PendingEnvelope | null;
}

export interface RunCommit<TState = unknown> {
  is_initial?: boolean;
  expected_previous_state: TState | null;
  target_state: TState;
  envelope?: PendingEnvelope | null;
}

export class StorageError extends Error {
  constructor(
    message: string,
    public code: string = "STORAGE_ERROR",
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export class StorageInconsistentError extends StorageError {
  constructor(message: string) {
    super(message, "STORAGE_INCONSISTENT");
    this.name = "StorageInconsistentError";
  }
}

export class StorageIOError extends StorageError {
  constructor(message: string) {
    super(message, "STORAGE_IO_ERROR");
    this.name = "StorageIOError";
  }
}
