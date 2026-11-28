/**
 * Completion lifecycle operation.
 */
import fs from "node:fs";
import path from "node:path";
import { commitRun, loadRun } from "../run-store/index.js";
import {
  missingFinalizationEvidence,
  missingWorkEvidence,
  resolveCanonicalStage,
} from "../workflow-policy/index.js";
import { compareCompleteReports } from "./requests.js";
import { parseReportInput, ProtocolError } from "../protocol/index.js";
import type {
  CompactReport,
  CompletedDispatch,
  CompleteOptions,
  RuntimeState,
} from "./types.js";

interface IncompleteWork {
  action: "continue_same_dispatch";
  dispatch_id: string;
  missing_evidence: string[];
  execution_status?: never;
}

export function completeDispatch(o: CompleteOptions): CompletedDispatch | IncompleteWork {
  const explicitId = o.dispatch_id?.trim();
  if (o.dispatch_id !== undefined && !explicitId) {
    throw new Error("--dispatch-id must be a non-empty string when provided");
  }

  const root = path.resolve(o.receipt_root);
  const state = loadRun<RuntimeState>(root);
  if (state.schema_version === "1.0") {
    throw new Error(
      "Cannot complete dispatch: legacy schema_version '1.0' run does not support writes. Finish it with the previous version or inspect read-only, or start a new run in a new receipt root.",
    );
  }
  if (state.schema_version !== "1.1") {
    throw new Error(
      `Unsupported schema_version '${state.schema_version}'. This version only supports '1.1'.`,
    );
  }
  const expectedPreviousState = JSON.parse(JSON.stringify(state));

  let dispatchId = explicitId;
  const active = state.active_dispatch;
  const history = state.completed_stages ?? [];

  // Correctable defects of the *current* dispatch are recorded against it; input that
  // cannot be correlated to the active dispatch is rejected without touching state.
  const reject = (errorType: string, message: string): never => {
    if (dispatchId && active?.dispatch_id === dispatchId) {
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

  if (explicitId && report.dispatch_id && report.dispatch_id !== explicitId) {
    throw new Error(
      `dispatch_mismatch: Requested dispatch_id '${explicitId}' does not match report dispatch_id '${report.dispatch_id}'.`,
    );
  }

  const reportReceipt = path.resolve(report.receipt_path);
  dispatchId ??= report.dispatch_id;
  if (dispatchId === undefined) {
    const matches = (active ? [active, ...history] : history).filter(
      (entry) => entry.receipt_path && path.resolve(entry.receipt_path) === reportReceipt,
    );
    const [match] = matches;
    if (!match) {
      throw new Error(`No dispatch has assigned receipt_path '${report.receipt_path}'.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple dispatches have assigned receipt_path '${report.receipt_path}'. Specify --dispatch-id or report.dispatch_id.`,
      );
    }
    dispatchId = match.dispatch_id;
  }

  // Historical completion replay must work even when a later dispatch is active.
  const settled = history.findLast((entry) => entry.dispatch_id === dispatchId);
  if (settled) {
    if (compareCompleteReports(settled, report)) return settled;
    throw new Error(
      `Conflicting report for already settled dispatch '${settled.dispatch_id}': execution_status, result, receipt_path, or summary differs. The recorded completion is unchanged.`,
    );
  }

  if (!active) {
    throw new Error("No active dispatch in flight to complete.");
  }

  if (active.dispatch_id !== dispatchId) {
    throw new Error(
      `dispatch_mismatch: Active dispatch ID '${active.dispatch_id}' does not match requested '${dispatchId}'.`,
    );
  }

  if (active.status !== "handed_off" && active.status !== "running") {
    return reject(
      "not_handed_off",
      `Cannot complete dispatch '${active.dispatch_id}': legacy prepared state has no launch authorization. Finish it with the previous version or verify it was never launched and start a new run.`,
    );
  }

  const assignedReceipt = path.resolve(active.receipt_path);
  if (assignedReceipt !== reportReceipt) {
    return reject(
      "receipt_mismatch",
      `Report receipt_path '${report.receipt_path}' does not match assigned receipt_path '${active.receipt_path}'.`,
    );
  }

  const stage = resolveCanonicalStage(state.workflow_snapshot, active.task_name);
  const missing = missingWorkEvidence(stage, report);
  if (missing.length) {
    return { action: "continue_same_dispatch", dispatch_id: dispatchId, missing_evidence: missing };
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

  const missingFinalization = missingFinalizationEvidence({
    workflow: state.workflow_snapshot,
    stage,
    deliveryState: { rootIssueId: state.root_issue_id, sequence: state.delivery_sequence },
    history,
    issueId: String(active.issue_id ?? state.root_issue_id),
    assignedScope: (active.request?.scope ?? stage.scope)?.trim(),
    report,
  });
  if (missingFinalization.length > 0) {
    return { action: "continue_same_dispatch", dispatch_id: dispatchId, missing_evidence: missingFinalization };
  }

  const completedAt = new Date().toISOString();
  const entry: CompletedDispatch = {
    dispatch_id: active.dispatch_id,
    step_index: active.step_index,
    stage: active.task_name,
    attempt: active.attempt,
    delivery_attempt: active.delivery_attempt ?? active.attempt,
    originating_stage: active.originating_stage,
    ...(active.issue_id ? { issue_id: String(active.issue_id) } : {}),
    execution_status: report.execution_status,
    result: report.result,
    receipt_path: assignedReceipt,
    summary: report.summary,
    completed_at: completedAt,
    ...(active.request?.request_id ? { request: active.request } : {}),
    ...(active.provider ? { provider: active.provider } : {}),
    ...(active.request_identity_version !== undefined
      ? { request_identity_version: active.request_identity_version }
      : {}),
    envelope_path: active.envelope_path,
  };

  const nextStatus =
    report.result.outcome === "rework_needed"
      ? "needs_rework"
      : report.execution_status;

  const nextState: RuntimeState = {
    ...state,
    completed_stages: [...history, entry],
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
