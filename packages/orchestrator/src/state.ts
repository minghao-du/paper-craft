import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./envelope.js";
import type { RuntimeState } from "./types.js";
export const now = (): string => new Date().toISOString();
export const getStateFilePath = (root: string): string =>
  path.join(path.resolve(root), "state.json");
export function recordProtocolError(
  root: string,
  state: RuntimeState,
  error_type: string,
  message: string,
): void {
  state.protocol_error = { error_type, message, timestamp: now() };
  state.last_updated = now();
  atomicWriteJson(getStateFilePath(root), state);
}
export function loadState(root: string): RuntimeState {
  root = path.resolve(root);
  const filename = getStateFilePath(root);
  if (!fs.existsSync(filename))
    throw Error(`State file not found at ${filename}. Run 'init' first.`);
  const state: RuntimeState = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (state.active_dispatch != null) return state;
  const idx = state.next_step_index ?? 1,
    envelopePath = path.join(
      root,
      `${String(idx).padStart(2, "0")}-input.json`,
    );
  if (!fs.existsSync(envelopePath)) return state;
  try {
    const env = JSON.parse(fs.readFileSync(envelopePath, "utf8")),
      task = env.task ?? {};
    if (task.step_index !== idx) return state;
    const stage = task.logical_stage ?? "",
      attempt = task.attempt ?? 1,
      issue = String(
        task.current_issue_id ??
          state.current_issue_id ??
          state.root_issue_id ??
          "0",
      );
    const id = `${String(idx).padStart(2, "0")}-${stage}-issue-${issue}-try-${attempt}`;
    state.active_dispatch = {
      dispatch_id: id,
      step_index: idx,
      task_name: stage,
      attempt,
      status: "prepared",
      authorized: false,
      envelope_path: envelopePath,
      receipt_path: env.contract?.receipt_path ?? path.join(root, `${id}.md`),
      request: {
        objective: env.inputs?.objective ?? "",
        provider: {
          type: env.provider?.type,
          target: env.provider?.target,
          args: env.provider?.args ?? [],
        },
        logical_stage: stage,
        acceptance_criteria: env.inputs?.acceptance_criteria ?? [],
        predecessors: env.inputs?.predecessor_receipts ?? [],
        working_directory: env.environment?.working_directory ?? "",
        branch: env.environment?.branch ?? null,
        commit: env.environment?.commit ?? null,
      },
    };
    state.next_step_index = idx + 1;
    state.budgets.delivery_attempts_used = Math.max(
      state.budgets.delivery_attempts_used ?? 0,
      attempt,
    );
    state.current_stage = stage;
    state.stage_status = "pending";
    state.last_updated = now();
    atomicWriteJson(filename, state);
  } catch (error) {
    process.stderr.write(
      `Warning: Failed to recover uncommitted dispatch envelope ${envelopePath}: ${error}\n`,
    );
  }
  return state;
}
