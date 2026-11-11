/**
 * Resolve decision lifecycle operation.
 */
import path from "node:path";
import { commitRun, loadRun } from "../run-store/index.js";
import { applyDeliveryDecision, assertCanFinish } from "../workflow/index.js";
import { parseResolveOptions } from "./requests.js";
import type { DecisionRecord, ResolveOptions, RuntimeState } from "./types.js";

export function resolveDecision(o: ResolveOptions): DecisionRecord {
  const options = parseResolveOptions(o as unknown as Record<string, unknown>);
  const root = path.resolve(o.receipt_root);
  const state = loadRun<RuntimeState>(root);
  const expectedPreviousState = JSON.parse(JSON.stringify(state));

  if (options.decision === "finish") {
    if (options.next_stage) {
      throw new Error("Cannot specify next_stage when finishing workflow.");
    }
    assertCanFinish({
      workflow: state.workflow_snapshot,
      completedStages: state.completed_stages ?? [],
      activeDispatch: state.active_dispatch,
      protocolError: state.protocol_error,
      rootIssueId: String(state.root_issue_id),
    });
  }

  const deliveryResult = applyDeliveryDecision({
    deliverySequence: state.delivery_sequence,
    budgets: state.budgets,
    currentIssueId: state.current_issue_id,
    rootIssueId: state.root_issue_id,
    decision: options.decision,
    action: options.decision,
    nextStage: options.next_stage,
    childIssues: options.child_issues,
    plan: options.plan,
    currentIssue:
      options.current_issue != null ? String(options.current_issue) : null,
    markLanded:
      options.mark_landed != null ? String(options.mark_landed) : null,
    completeSequence: options.complete_sequence,
    completedStages: state.completed_stages,
  });

  const now = new Date().toISOString();
  const record: DecisionRecord = {
    decision: options.decision,
    action: options.decision,
    reason: options.reason,
    options: options.options ?? [],
    timestamp: now,
  };
  if (options.next_stage) record.next_stage = options.next_stage;
  if (options.current_issue != null) {
    record.current_issue = String(options.current_issue);
  }
  if (options.mark_landed != null) {
    record.mark_landed = String(options.mark_landed);
  }
  if (options.complete_sequence) record.complete_sequence = true;

  let stageStatus = state.stage_status;
  let currentStage = state.current_stage;

  if (options.decision === "halt") {
    stageStatus = "halted";
  } else if (options.decision === "wait_user") {
    stageStatus = "blocked";
  } else if (options.decision === "finish") {
    stageStatus = "succeeded";
    currentStage = "completed";
  } else if (options.decision === "continue") {
    stageStatus = ["handed_off", "running"].includes(
      state.active_dispatch?.status ?? "",
    )
      ? "in_progress"
      : "pending";
  }

  if (options.next_stage) {
    currentStage = options.next_stage;
    stageStatus = "pending";
  }

  const nextState: RuntimeState = {
    ...state,
    current_issue_id: deliveryResult.currentIssueId,
    current_stage: currentStage,
    stage_status: stageStatus,
    budgets: deliveryResult.budgets,
    delivery_sequence: deliveryResult.deliverySequence,
    decisions: [...(state.decisions ?? []), record],
    orchestrator_decision: options.decision,
    last_updated: now,
  };

  commitRun(root, {
    expected_previous_state: expectedPreviousState,
    target_state: nextState,
  });

  return record;
}
