/**
 * Handoff and Completion lifecycle operations.
 */
import fs from "node:fs";
import path from "node:path";
import { commitRun, loadRun } from "../run-store/index.js";
import { compareCompleteReports } from "./requests.js";
import { parseReportInput, ProtocolError } from "../protocol/index.js";
import { assertNotPaused } from "./control.js";
import type {
  CompactReport,
  CompletedDispatch,
  CompleteOptions,
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
    assertNotPaused(state, "hand off a dispatch");
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

  const dispatchId = o.dispatch_id.trim();
  const active = state.active_dispatch;
  const currentIsTarget = active?.dispatch_id === dispatchId;

  // Correctable defects of the *current* dispatch are recorded against it; input that
  // cannot be correlated to the active dispatch is rejected without touching state.
  const reject = (errorType: string, message: string): never => {
    if (currentIsTarget) {
      const now = new Date().toISOString();
      try {
        commitRun(root, {
          expected_previous_state: expectedPreviousState,
          target_state: {
            ...state,
            protocol_error: {
              error_type: errorType,
              message,
              dispatch_id: dispatchId,
              timestamp: now,
            },
            last_updated: now,
          },
        });
      } catch {
        // the original protocol error is more useful than a secondary storage failure
      }
    }
    throw new Error(message);
  };

  let report: CompactReport;
  try {
    report = parseReportInput(o.report);
  } catch (error) {
    if (!(error instanceof ProtocolError)) throw error;
    return reject(error.code ?? "invalid_report", error.message);
  }

  if (report.dispatch_id && report.dispatch_id !== dispatchId) {
    throw new Error(
      `dispatch_mismatch: Requested dispatch_id '${dispatchId}' does not match report dispatch_id '${report.dispatch_id}'.`,
    );
  }

  if (!active) {
    const settled = [...(state.completed_stages ?? [])]
      .reverse()
      .find((entry) => entry.dispatch_id === dispatchId);
    if (settled) {
      if (compareCompleteReports(settled, report)) return settled;
      throw new Error(
        `Conflicting report for already settled dispatch '${settled.dispatch_id}': execution_status or result differs. The recorded completion is unchanged.`,
      );
    }
    throw new Error("No active dispatch in flight to complete.");
  }

  if (!currentIsTarget) {
    throw new Error(
      `dispatch_mismatch: Active dispatch ID '${active.dispatch_id}' does not match requested '${dispatchId}'.`,
    );
  }

  if (active.status !== "handed_off") {
    return reject(
      "not_handed_off",
      `Cannot complete dispatch '${active.dispatch_id}': task has not been handed off to execution. Run 'handoff' first.`,
    );
  }

  const assignedReceipt = path.resolve(active.receipt_path);
  if (assignedReceipt !== path.resolve(report.receipt_path)) {
    return reject(
      "receipt_mismatch",
      `Report receipt_path '${report.receipt_path}' does not match assigned receipt_path '${active.receipt_path}'.`,
    );
  }

  if (!fs.existsSync(assignedReceipt)) {
    return reject(
      "receipt_missing",
      `Receipt file missing on disk at: ${assignedReceipt}`,
    );
  }

  if (fs.statSync(assignedReceipt).size === 0) {
    return reject(
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
    ...(active.issue_id ? { issue_id: String(active.issue_id) } : {}),
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
    // Only the corrected dispatch's own protocol error is cleared.
    protocol_error:
      state.protocol_error &&
      state.protocol_error.dispatch_id &&
      state.protocol_error.dispatch_id !== dispatchId
        ? state.protocol_error
        : null,
    stage_status: nextStatus,
    last_updated: completedAt,
  };

  commitRun(root, {
    expected_previous_state: expectedPreviousState,
    target_state: nextState,
  });

  return entry;
}
