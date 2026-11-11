/**
 * Resolve decision lifecycle operation.
 *
 * Contract: control decisions (halt / wait_user / continue / finish) are separated from
 * domain updates (stage selection, delivery sequence). The whole request is validated
 * before any state is built or committed.
 */
import fs from "node:fs";
import path from "node:path";
import { commitRun, loadRun } from "../run-store/index.js";
import { applyDeliveryDecision, assertCanFinish } from "../workflow/index.js";
import { isFinished } from "./control.js";
import { parseResolveOptions } from "./requests.js";
import type {
  Completion,
  DecisionRecord,
  ResolveOptions,
  RuntimeState,
} from "./types.js";

const ADVANCE_FIELDS = [
  "next_stage",
  "current_issue",
  "plan",
  "child_issues",
  "mark_landed",
  "complete_sequence",
] as const;

function hasValue(options: ResolveOptions, field: string): boolean {
  const value = options[field];
  if (field === "child_issues") return Array.isArray(value) && value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function assertResolveShape(
  options: ResolveOptions,
  state: RuntimeState,
): void {
  const supplied = ADVANCE_FIELDS.filter((f) => hasValue(options, f));
  const landingGiven = options.landing_dispatch_id != null;

  if (options.decision !== "continue" && (supplied.length || landingGiven)) {
    throw new Error(
      `Decision '${options.decision}' only controls the run and cannot carry ${[...supplied, ...(landingGiven ? ["landing_dispatch_id"] : [])].join(", ")}. Apply delivery updates with 'continue' first${options.decision === "finish" ? ", then finish" : ""}.`,
    );
  }
  if (hasValue(options, "plan") && hasValue(options, "child_issues")) {
    throw new Error("Provide either plan or child_issues, not both.");
  }
  if (
    (options.mark_landed != null) !== landingGiven
  ) {
    throw new Error(
      "mark_landed and landing_dispatch_id must be provided together.",
    );
  }
  if (options.next_stage) {
    const known = state.workflow_snapshot.stages.some(
      (s) => s.id === options.next_stage,
    );
    if (!known) {
      throw new Error(
        `next_stage '${options.next_stage}' is not a stage of workflow '${state.workflow_snapshot.name}'.`,
      );
    }
  }
  if (supplied.length && state.active_dispatch) {
    throw new Error(
      `Cannot change ${supplied.join(", ")} while dispatch '${state.active_dispatch.dispatch_id}' is active. Complete it first; a pure continue/halt/wait_user is still allowed.`,
    );
  }
  if (options.current_issue != null) {
    const issue = String(options.current_issue).trim();
    const items = state.delivery_sequence?.items ?? [];
    const inSequence = items.some((i) => String(i.issue_id) === issue);
    if (!inSequence && issue !== String(state.root_issue_id)) {
      throw new Error(
        `current_issue '${issue}' is not in the delivery sequence and is not the root issue; declare it with plan/child_issues first.`,
      );
    }
  }
}

/** Legacy completions lack issue_id; recover it from their immutable input envelope. */
function withRecoveredIssueIds(
  root: string,
  completed: Completion[],
  landingDispatchId: string | null,
): Completion[] {
  return completed.map((entry) => {
    if (entry.dispatch_id !== landingDispatchId || entry.issue_id) return entry;
    const prefix = String(entry.step_index).padStart(2, "0");
    try {
      const envelope = JSON.parse(
        fs.readFileSync(path.join(root, `${prefix}-input.json`), "utf8"),
      ) as { task?: { logical_stage?: string; current_issue_id?: string } };
      if (
        envelope.task?.logical_stage === entry.stage &&
        envelope.task.current_issue_id
      ) {
        return { ...entry, issue_id: String(envelope.task.current_issue_id) };
      }
    } catch {
      // fall through: delivery validation reports the missing identity
    }
    return entry;
  });
}

export function resolveDecision(o: ResolveOptions): DecisionRecord {
  const options = parseResolveOptions(o as unknown as Record<string, unknown>);
  const root = path.resolve(o.receipt_root);
  const state = loadRun<RuntimeState>(root);
  const expectedPreviousState = JSON.parse(JSON.stringify(state));

  if (isFinished(state)) {
    const existing = [...(state.decisions ?? [])]
      .reverse()
      .find((d) => d.decision === "finish");
    if (options.decision === "finish" && existing) return existing;
    throw new Error(
      "Workflow is already finished. Use 'inspect' to read it, or start a new run in a new receipt root.",
    );
  }

  assertResolveShape(options, state);

  if (options.decision === "finish") {
    assertCanFinish({
      workflow: state.workflow_snapshot,
      completedStages: state.completed_stages ?? [],
      activeDispatch: state.active_dispatch,
      protocolError: state.protocol_error,
      rootIssueId: String(state.root_issue_id),
    });
  }

  const landingId =
    options.landing_dispatch_id != null
      ? String(options.landing_dispatch_id).trim()
      : null;

  const deliveryResult = applyDeliveryDecision({
    workflow: state.workflow_snapshot,
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
    landingDispatchId: landingId,
    completeSequence: options.complete_sequence,
    completedStages: withRecoveredIssueIds(
      root,
      state.completed_stages ?? [],
      landingId,
    ),
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
    record.landing_dispatch_id = landingId;
  }
  if (options.complete_sequence) record.complete_sequence = true;

  const activeRunning = ["handed_off", "running"].includes(
    state.active_dispatch?.status ?? "",
  );
  let stageStatus = state.stage_status;
  let currentStage = state.current_stage;

  if (options.decision === "halt") {
    if (!activeRunning) stageStatus = "halted";
  } else if (options.decision === "wait_user") {
    if (!activeRunning) stageStatus = "blocked";
  } else if (options.decision === "finish") {
    stageStatus = "succeeded";
    currentStage = "completed";
  } else {
    stageStatus = activeRunning ? "in_progress" : "pending";
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
