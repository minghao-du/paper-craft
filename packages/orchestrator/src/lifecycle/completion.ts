/**
 * Handoff and Completion lifecycle operations.
 */
import fs from "node:fs";
import path from "node:path";
import { commitRun, loadRun } from "../run-store/index.js";
import { compareCompleteReports } from "./requests.js";
import type {
  CompactReport,
  CompletedDispatch,
  CompleteOptions,
  ExecutionStatus,
  HandoffOptions,
  HandoffResult,
  RuntimeState,
} from "./types.js";

export function handoffDispatch(o: HandoffOptions): HandoffResult {
  if (!o.dispatch_id || !o.dispatch_id.trim()) {
    throw new Error("--dispatch-id is required for handoff");
  }

  const root = path.resolve(o.receipt_root);
  const state = loadRun<RuntimeState>(root);
  const expectedPreviousState = JSON.parse(JSON.stringify(state));

  if (
    state.stage_status === "halted" ||
    state.orchestrator_decision === "halt"
  ) {
    throw new Error(
      "Cannot handoff dispatch: Workflow is halted. Run 'resolve --decision continue' to resume first.",
    );
  }

  const active = state.active_dispatch;
  if (!active) {
    throw new Error(
      "No active dispatch found to hand off. Run 'prepare' first.",
    );
  }

  if (active.dispatch_id !== o.dispatch_id) {
    throw new Error(
      `Active dispatch ID '${active.dispatch_id}' does not match requested dispatch ID '${o.dispatch_id}'.`,
    );
  }

  const authorized = active.status === "prepared" && !active.authorized;
  if (authorized) {
    const now = new Date().toISOString();
    const updatedActive = {
      ...active,
      status: "handed_off" as const,
      authorized: true,
      platform_handle: o.platform_handle ?? active.platform_handle ?? null,
      handed_off_at: now,
    };
    const nextState: RuntimeState = {
      ...state,
      active_dispatch: updatedActive,
      stage_status: "in_progress",
      last_updated: now,
    };
    commitRun(root, {
      expected_previous_state: expectedPreviousState,
      target_state: nextState,
    });
    return {
      authorized: true,
      dispatch_id: active.dispatch_id,
      status: "handed_off",
      platform_handle: updatedActive.platform_handle ?? null,
      envelope_path: active.envelope_path,
      receipt_path: active.receipt_path,
      message: "Execution launch authorized.",
    };
  }

  return {
    authorized: false,
    dispatch_id: active.dispatch_id,
    status: active.status ?? "unknown",
    platform_handle: active.platform_handle ?? null,
    envelope_path: active.envelope_path,
    receipt_path: active.receipt_path,
    message:
      "Dispatch was already authorized previously. New launch authorization not granted.",
  };
}

export function completeDispatch(o: CompleteOptions): CompletedDispatch {
  if (!o.dispatch_id || !o.dispatch_id.trim()) {
    throw new Error("--dispatch-id is required for complete");
  }

  const root = path.resolve(o.receipt_root);
  const state = loadRun<RuntimeState>(root);
  const expectedPreviousState = JSON.parse(JSON.stringify(state));

  const recordError = (errorType: string, message: string): never => {
    const now = new Date().toISOString();
    const errorState: RuntimeState = {
      ...state,
      protocol_error: {
        error_type: errorType,
        message,
        timestamp: now,
      },
      last_updated: now,
    };
    try {
      commitRun(root, {
        expected_previous_state: expectedPreviousState,
        target_state: errorState,
      });
    } catch {}
    throw new Error(message);
  };

  let reportData: unknown = o.report;
  if (typeof reportData === "string") {
    const raw = reportData.trim();
    if (raw.startsWith("{")) {
      try {
        reportData = JSON.parse(raw);
      } catch (error) {
        return recordError(
          "invalid_json",
          `Invalid compact report JSON: ${String(error)}`,
        );
      }
    } else {
      const file = path.resolve(raw);
      if (!fs.existsSync(file)) {
        return recordError(
          "report_file_missing",
          `Report file not found: ${file}`,
        );
      }
      try {
        reportData = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        return recordError(
          "invalid_json",
          `Invalid report file JSON: ${String(error)}`,
        );
      }
    }
  }

  if (!reportData || typeof reportData !== "object" || Array.isArray(reportData)) {
    return recordError(
      "invalid_report_type",
      "Report must be a JSON object dictionary or JSON string.",
    );
  }

  const repObj = reportData as Record<string, unknown>;

  for (const key of ["execution_status", "result", "receipt_path", "summary"]) {
    if (!(key in repObj)) {
      return recordError(
        "missing_field",
        `Compact execution report missing required field: '${key}'`,
      );
    }
  }

  const status = repObj.execution_status;
  if (status !== "succeeded" && status !== "failed" && status !== "blocked") {
    return recordError(
      "invalid_status",
      `Invalid execution_status '${status}'. Expected 'succeeded' | 'failed' | 'blocked'.`,
    );
  }

  if (
    !repObj.result ||
    typeof repObj.result !== "object" ||
    Array.isArray(repObj.result)
  ) {
    return recordError(
      "invalid_result",
      `Field 'result' must be a JSON object (dict), got ${repObj.result === null ? "NoneType" : typeof repObj.result}.`,
    );
  }

  if (typeof repObj.receipt_path !== "string" || !repObj.receipt_path.trim()) {
    return recordError(
      "invalid_receipt_path",
      "Field 'receipt_path' must be a non-empty string.",
    );
  }

  if (typeof repObj.summary !== "string" || !repObj.summary.trim()) {
    return recordError(
      "invalid_summary",
      "Field 'summary' must be a non-empty string.",
    );
  }

  const report: CompactReport = {
    execution_status: status as ExecutionStatus,
    result: repObj.result as Record<string, unknown>,
    receipt_path: repObj.receipt_path.trim(),
    summary: repObj.summary.trim(),
    ...(repObj.dispatch_id
      ? { dispatch_id: String(repObj.dispatch_id).trim() }
      : {}),
  };

  const dispatchId = o.dispatch_id.trim();

  if (report.dispatch_id && report.dispatch_id !== dispatchId) {
    return recordError(
      "dispatch_mismatch",
      `dispatch_mismatch: Requested dispatch_id '${dispatchId}' does not match report dispatch_id '${report.dispatch_id}'.`,
    );
  }

  const active = state.active_dispatch;

  if (!active) {
    const settled = [...(state.completed_stages ?? [])]
      .reverse()
      .find((entry) => entry.dispatch_id === dispatchId);
    if (settled) {
      if (compareCompleteReports(settled, report)) {
        return settled;
      }
      return recordError(
        "report_conflict",
        `Conflicting report for already settled dispatch '${settled.dispatch_id}': execution_status or result differs.`,
      );
    }
    return recordError(
      "no_active_dispatch",
      "No active dispatch in flight to complete.",
    );
  }

  if (active.dispatch_id !== dispatchId) {
    return recordError(
      "dispatch_mismatch",
      `dispatch_mismatch: Active dispatch ID '${active.dispatch_id}' does not match requested '${dispatchId}'.`,
    );
  }

  if (active.status !== "handed_off") {
    return recordError(
      "not_handed_off",
      `Cannot complete dispatch '${active.dispatch_id}': task has not been handed off to execution. Run 'handoff' first.`,
    );
  }

  const assignedReceipt = path.resolve(active.receipt_path);
  if (assignedReceipt !== path.resolve(report.receipt_path)) {
    return recordError(
      "receipt_mismatch",
      `Report receipt_path '${report.receipt_path}' does not match assigned receipt_path '${active.receipt_path}'.`,
    );
  }

  if (!fs.existsSync(assignedReceipt)) {
    return recordError(
      "receipt_missing",
      `Receipt file missing on disk at: ${assignedReceipt}`,
    );
  }

  if (fs.statSync(assignedReceipt).size === 0) {
    return recordError(
      "receipt_empty",
      `Receipt file at ${assignedReceipt} is empty (0 bytes).`,
    );
  }

  const completedAt = new Date().toISOString();
  const entry: CompletedDispatch = {
    dispatch_id: active.dispatch_id,
    step_index: active.step_index,
    stage: active.task_name,
    attempt: active.attempt,
    execution_status: report.execution_status,
    result: report.result,
    receipt_path: assignedReceipt,
    summary: report.summary,
    completed_at: completedAt,
  };

  const nextStatus =
    report.result.outcome === "rework_needed"
      ? "needs_rework"
      : report.execution_status;

  const nextState: RuntimeState = {
    ...state,
    completed_stages: [...(state.completed_stages ?? []), entry],
    active_dispatch: null,
    protocol_error: null,
    stage_status: nextStatus,
    last_updated: completedAt,
  };

  commitRun(root, {
    expected_previous_state: expectedPreviousState,
    target_state: nextState,
  });

  return entry;
}
