/**
 * Inspect state lifecycle operation.
 */
import path from "node:path";
import { loadRun } from "../run-store/index.js";
import { inspectDelivery } from "../workflow/index.js";
import { toDeliveryState } from "./domain-state.js";
import type { DecisionRecord, InspectOptions, RuntimeState } from "./types.js";

function lastDecisionReason(
  decisions: DecisionRecord[],
  decision: string,
  fallback: string,
): string {
  return (
    [...decisions].reverse().find((d) => d.decision === decision)?.reason ??
    fallback
  );
}

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

  // Legacy 1.0 runs remain read-only with explicit label
  if (state.schema_version === "1.0") {
    const budgets = state.budgets ?? {};
    const active = state.active_dispatch;
    const decisions = state.decisions ?? [];
    const completed = state.completed_stages ?? [];
    const reasons: string[] = ["Legacy run: schema_version '1.0' is read-only."];

    return {
      legacy: true,
      schema_version: "1.0",
      workflow: state.workflow ?? "default",
      root_issue_id: state.root_issue_id,
      current_issue_id: state.current_issue_id,
      current_stage: state.current_stage,
      stage_status: state.stage_status,
      orchestrator_decision: state.orchestrator_decision ?? null,
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
        `Active dispatch '${active.dispatch_id}' is a legacy prepared dispatch without launch authorization.`,
      );
    } else if (["handed_off", "running"].includes(active.status)) {
      reasons.push(
        `Active dispatch '${active.dispatch_id}' has launch authorization and its execution outcome is unconfirmed. Verify the original execution and submit its completion report and durable receipt.`,
      );
    } else {
      reasons.push(
        `Active dispatch '${active.dispatch_id}' is pending in status '${active.status}'.`,
      );
    }
  }

  if (state.orchestrator_decision === "halt") {
    reasons.push(
      `Workflow is halted (new tasks blocked; an authorized task can still be completed): ${lastDecisionReason(decisions, "halt", "Workflow halted")}`,
    );
  } else if (state.orchestrator_decision === "wait_user") {
    reasons.push(
      `Workflow is waiting for user (new tasks blocked; an authorized task can still be completed): ${lastDecisionReason(decisions, "wait_user", "Awaiting user input or prerequisite")}`,
    );
  }

  // Domain delivery inspection
  const deliveryInspection = inspectDelivery({
    workflow: state.workflow_snapshot,
    deliveryState: toDeliveryState(state),
    completedStages: completed,
  });

  if (
    (deliveryInspection.budgets.delivery_attempts_used ?? 0) >=
    (deliveryInspection.budgets.delivery_attempts_max ?? 3)
  ) {
    reasons.push(
      `Delivery attempt budget exhausted: ${deliveryInspection.budgets.delivery_attempts_used}/${deliveryInspection.budgets.delivery_attempts_max} attempts used.`,
    );
  }

  if (
    (deliveryInspection.budgets.replans_used ?? 0) >=
    (deliveryInspection.budgets.replans_max ?? 2)
  ) {
    reasons.push(
      `Replan budget exhausted: ${deliveryInspection.budgets.replans_used}/${deliveryInspection.budgets.replans_max} replans used.`,
    );
  }

  for (const reason of deliveryInspection.blockingReasons) {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  }

  return {
    schema_version: state.schema_version ?? "1.1",
    workflow: state.workflow ?? "default",
    root_issue_id: state.root_issue_id,
    current_issue_id: deliveryInspection.currentIssueId,
    current_stage: state.current_stage,
    stage_status: state.stage_status,
    orchestrator_decision: state.orchestrator_decision ?? null,
    active_dispatch: active,
    last_decision: decisions.at(-1) ?? null,
    protocol_error: state.protocol_error ?? null,
    budgets: deliveryInspection.budgets,
    completed_stages_count: completed.length,
    blocking_reasons: reasons,
    last_updated: state.last_updated,
    ...(state.delivery_sequence
      ? { delivery_sequence: state.delivery_sequence }
      : {}),
  };
}
