/**
 * Inspect state lifecycle operation.
 */
import path from "node:path";
import { loadRun } from "../run-store/index.js";
import type { InspectOptions, RuntimeState } from "./types.js";

export function inspectState(o: InspectOptions): unknown {
  const root = path.resolve(o.receipt_root);
  const state = loadRun<RuntimeState>(root);

  if (o.field) {
    let val: unknown = state;
    for (const part of o.field.split(".")) {
      if (!val || typeof val !== "object" || !(part in val)) {
        throw new Error(`Field '${o.field}' not found in state.`);
      }
      val = (val as Record<string, unknown>)[part];
    }
    return val;
  }

  const budgets = state.budgets ?? {};
  const active = state.active_dispatch;
  const decisions = state.decisions ?? [];
  const completed = state.completed_stages ?? [];
  const reasons: string[] = [];

  if (state.protocol_error) {
    reasons.push(
      `Protocol error [${state.protocol_error.error_type}]: ${state.protocol_error.message}`,
    );
  }

  if (active) {
    if (active.status === "prepared") {
      reasons.push(
        `Active dispatch '${active.dispatch_id}' is prepared but not yet handed off to execution.`,
      );
    } else if (["handed_off", "running"].includes(active.status)) {
      reasons.push(
        `Active dispatch '${active.dispatch_id}' was handed off and execution outcome is unconfirmed/in flight; awaiting completion report and durable receipt. Kernel will not auto-re-execute.`,
      );
    } else {
      reasons.push(
        `Active dispatch '${active.dispatch_id}' is pending in status '${active.status}'.`,
      );
    }
  }

  if (
    (budgets.delivery_attempts_used ?? 0) >=
    (budgets.delivery_attempts_max ?? 3)
  ) {
    reasons.push(
      `Delivery attempt budget exhausted: ${budgets.delivery_attempts_used}/${budgets.delivery_attempts_max} attempts used.`,
    );
  }

  if ((budgets.replans_used ?? 0) >= (budgets.replans_max ?? 2)) {
    reasons.push(
      `Replan budget exhausted: ${budgets.replans_used}/${budgets.replans_max} replans used.`,
    );
  }

  if (state.stage_status === "halted") {
    reasons.push(
      `Workflow is halted: ${decisions.at(-1)?.reason ?? "Workflow halted"}`,
    );
  } else if (state.stage_status === "blocked") {
    reasons.push(
      `Workflow is blocked: ${decisions.at(-1)?.reason ?? "Awaiting user input or prerequisite"}`,
    );
  } else if (state.stage_status === "needs_rework") {
    reasons.push(
      `Stage produced outcome '${completed.at(-1)?.result?.outcome ?? "rework_needed"}'; awaiting orchestrator rework routing, not accepted as business pass.`,
    );
  }

  return {
    workflow: state.workflow ?? "default",
    root_issue_id: state.root_issue_id,
    current_issue_id: state.current_issue_id,
    current_stage: state.current_stage,
    stage_status: state.stage_status,
    active_dispatch: active,
    last_decision: decisions.at(-1) ?? null,
    protocol_error: state.protocol_error ?? null,
    budgets,
    completed_stages_count: completed.length,
    blocking_reasons: reasons,
    last_updated: state.last_updated,
    ...(state.delivery_sequence
      ? { delivery_sequence: state.delivery_sequence }
      : {}),
  };
}
