import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  loadState,
  getStateFilePath,
  recordProtocolError,
  now,
} from "./state.js";
import { atomicWriteJson } from "./envelope.js";
import type { Data } from "./workflow.js";

export type ExecutionStatus = "succeeded" | "failed" | "blocked";
export interface CompactExecutionReport {
  execution_status: ExecutionStatus;
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
  dispatch_id?: string;
}
export interface HandoffOptions {
  receipt_root: string;
  dispatch_id?: string;
  platform_handle?: string;
}
export interface HandoffResult {
  authorized: boolean;
  dispatch_id: string;
  status: string;
  platform_handle: string | null;
  envelope_path: string;
  receipt_path: string;
  message: string;
}
export interface CompleteOptions {
  receipt_root: string;
  report: unknown;
  dispatch_id?: string;
}
export interface CompletedDispatch {
  dispatch_id: string;
  step_index: number;
  stage: string;
  attempt: number;
  execution_status: ExecutionStatus;
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
  completed_at: string;
}

/** Grant launch authorization once; later queries never authorize a second launch. */
export function handoffDispatch(o: HandoffOptions): HandoffResult {
  const root = path.resolve(o.receipt_root);
  const state = loadState(root);
  if (
    state.stage_status === "halted" ||
    state.orchestrator_decision === "halt"
  ) {
    throw new Error(
      "Cannot handoff dispatch: Workflow is halted. Run 'resolve --decision continue' to resume first.",
    );
  }
  const active = state.active_dispatch;
  if (!active)
    throw new Error(
      "No active dispatch found to hand off. Run 'prepare' first.",
    );
  if (o.dispatch_id && active.dispatch_id !== o.dispatch_id) {
    throw new Error(
      `Active dispatch ID '${active.dispatch_id}' does not match requested dispatch ID '${o.dispatch_id}'.`,
    );
  }
  const authorized = active.status === "prepared" && !active.authorized;
  if (authorized) {
    active.status = "handed_off";
    active.authorized = true;
    if (o.platform_handle) active.platform_handle = o.platform_handle;
    active.handed_off_at = now();
    state.stage_status = "in_progress";
    state.last_updated = now();
    atomicWriteJson(getStateFilePath(root), state);
  }
  return {
    authorized,
    dispatch_id: active.dispatch_id,
    status: active.status ?? "unknown",
    platform_handle: active.platform_handle ?? null,
    envelope_path: active.envelope_path,
    receipt_path: active.receipt_path,
    message: authorized
      ? "Execution launch authorized."
      : "Dispatch was already authorized previously. New launch authorization not granted.",
  };
}

/** Verify the external report and durable receipt; completion never advances routing. */
export function completeDispatch(o: CompleteOptions): CompletedDispatch {
  const root = path.resolve(o.receipt_root);
  const state = loadState(root);
  const fail = (type: string, message: string): never => {
    recordProtocolError(root, state, type, message);
    throw new Error(message);
  };
  let report: Data;
  if (typeof o.report === "string") {
    const raw = o.report.trim();
    if (raw.startsWith("{")) {
      try {
        report = JSON.parse(raw);
      } catch (error) {
        return fail(
          "invalid_json",
          `Invalid compact report JSON: ${String(error)}`,
        );
      }
    } else {
      const file = path.resolve(raw);
      if (!fs.existsSync(file))
        return fail("report_file_missing", `Report file not found: ${file}`);
      try {
        report = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        return fail(
          "invalid_json",
          `Invalid report file JSON: ${String(error)}`,
        );
      }
    }
  } else report = o.report as Data;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return fail(
      "invalid_report_type",
      "Report must be a JSON object dictionary or JSON string.",
    );
  }
  for (const key of ["execution_status", "result", "receipt_path", "summary"]) {
    if (!(key in report))
      return fail(
        "missing_field",
        `Compact execution report missing required field: '${key}'`,
      );
  }
  const status = report.execution_status as ExecutionStatus;
  if (!["succeeded", "failed", "blocked"].includes(status)) {
    return fail(
      "invalid_status",
      `Invalid execution_status '${status}'. Expected 'succeeded' | 'failed' | 'blocked'.`,
    );
  }
  if (
    !report.result ||
    typeof report.result !== "object" ||
    Array.isArray(report.result)
  ) {
    return fail(
      "invalid_result",
      `Field 'result' must be a JSON object (dict), got ${report.result === null ? "NoneType" : typeof report.result}.`,
    );
  }
  if (typeof report.receipt_path !== "string" || !report.receipt_path.trim()) {
    return fail(
      "invalid_receipt_path",
      "Field 'receipt_path' must be a non-empty string.",
    );
  }
  if (typeof report.summary !== "string" || !report.summary.trim()) {
    return fail(
      "invalid_summary",
      "Field 'summary' must be a non-empty string.",
    );
  }
  const active = state.active_dispatch;
  const dispatchId = o.dispatch_id;
  if (!active) {
    const resolvedReceipt = path.resolve(report.receipt_path);
    const settled = [...(state.completed_stages ?? [])]
      .reverse()
      .find((entry: Data) =>
        dispatchId
          ? entry.dispatch_id === dispatchId
          : entry.receipt_path === resolvedReceipt,
      );
    if (settled) {
      if (
        settled.execution_status === status &&
        isDeepStrictEqual(settled.result, report.result)
      )
        return settled;
      return fail(
        "report_conflict",
        `Conflicting report for already settled dispatch '${settled.dispatch_id}': execution_status or result differs.`,
      );
    }
    return fail(
      "no_active_dispatch",
      "No active dispatch in flight to complete.",
    );
  }
  const reportDispatchId = report.dispatch_id;
  if (dispatchId && reportDispatchId && dispatchId !== reportDispatchId) {
    return fail(
      "dispatch_mismatch",
      `dispatch_mismatch: Requested dispatch_id '${dispatchId}' does not match report dispatch_id '${reportDispatchId}'.`,
    );
  }
  if (dispatchId && active.dispatch_id !== dispatchId) {
    return fail(
      "dispatch_mismatch",
      `dispatch_mismatch: Active dispatch ID '${active.dispatch_id}' does not match requested '${dispatchId}'.`,
    );
  }
  if (reportDispatchId && active.dispatch_id !== reportDispatchId) {
    return fail(
      "dispatch_mismatch",
      `dispatch_mismatch: Active dispatch ID '${active.dispatch_id}' does not match report dispatch_id '${reportDispatchId}'.`,
    );
  }
  if (active.status !== "handed_off") {
    return fail(
      "not_handed_off",
      `Cannot complete dispatch '${active.dispatch_id}': task has not been handed off to execution. Run 'handoff' first.`,
    );
  }
  const assignedReceipt = path.resolve(active.receipt_path);
  if (assignedReceipt !== path.resolve(report.receipt_path)) {
    return fail(
      "receipt_mismatch",
      `Report receipt_path '${report.receipt_path}' does not match assigned receipt_path '${active.receipt_path}'.`,
    );
  }
  if (!fs.existsSync(assignedReceipt))
    return fail(
      "receipt_missing",
      `Receipt file missing on disk at: ${assignedReceipt}`,
    );
  if (fs.statSync(assignedReceipt).size === 0)
    return fail(
      "receipt_empty",
      `Receipt file at ${assignedReceipt} is empty (0 bytes).`,
    );
  const completedAt = now();
  const entry = {
    dispatch_id: active.dispatch_id,
    step_index: active.step_index,
    stage: active.task_name,
    attempt: active.attempt,
    execution_status: status,
    result: report.result,
    receipt_path: assignedReceipt,
    summary: report.summary,
    completed_at: completedAt,
  };
  (state.completed_stages ??= []).push(entry);
  state.active_dispatch = null;
  state.protocol_error = null;
  state.stage_status =
    report.result.outcome === "rework_needed" ? "needs_rework" : status;
  state.last_updated = completedAt;
  atomicWriteJson(getStateFilePath(root), state);
  return entry;
}
