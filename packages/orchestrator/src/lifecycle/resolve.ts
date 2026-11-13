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
import {
  applyDeliveryDecision,
  assertCanFinish,
  resolveCanonicalStage,
} from "../workflow/index.js";
import { toDeliveryState, applyNextDeliveryState } from "./domain-state.js";
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
  "mark_landed",
  "complete_sequence",
] as const;

function hasValue(options: ResolveOptions, field: string): boolean {
  const value = options[field];
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
  if ((options.mark_landed != null) !== landingGiven) {
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
        `current_issue '${issue}' is not in the delivery sequence and is not the root issue.`,
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
  if (state.schema_version === "1.0") {
    throw new Error(
      "Cannot resolve decision: legacy schema_version '1.0' run does not support writes. Finish it with the previous version or inspect read-only, or start a new run in a new receipt root.",
    );
  }
  if (state.schema_version !== "1.1") {
    throw new Error(
      `Unsupported schema_version '${state.schema_version}'. This version only supports '1.1'.`,
    );
  }
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

  // --- Plan Acceptance Branch ---
  if (options.plan_dispatch_id) {
    const targetPlanId = options.plan_dispatch_id;

    if (
      !options.next_stage ||
      typeof options.next_stage !== "string" ||
      !options.next_stage.trim()
    ) {
      throw new Error("Plan acceptance requires an explicit 'next_stage'.");
    }

    const canonicalNextStage = resolveCanonicalStage(
      state.workflow_snapshot,
      options.next_stage,
    ).id;

    // 1. Look for existing acceptance record for this exact plan_dispatch_id
    const accepted = (state.decisions ?? []).find(
      (d) => d.plan_dispatch_id === targetPlanId,
    );

    if (accepted) {
      if (
        accepted.decision !== options.decision ||
        accepted.next_stage !== canonicalNextStage
      ) {
        throw new Error(
          `Conflicting plan acceptance retry: original accepted decision was '${accepted.decision}' with next_stage '${accepted.next_stage}', received '${options.decision}' with next_stage '${options.next_stage}'.`,
        );
      }
      if (!state.delivery_sequence || !state.delivery_sequence.items?.length) {
        throw new Error(
          "Inconsistent state: plan acceptance record exists but delivery sequence is missing.",
        );
      }
      // Return original record without modifying state or updating timestamps
      return accepted;
    }

    // 2. Control guards
    if (state.active_dispatch) {
      throw new Error(
        `Cannot accept plan while dispatch '${state.active_dispatch.dispatch_id}' is active. Complete it first.`,
      );
    }
    if (state.protocol_error) {
      throw new Error(
        `Cannot accept plan while protocol error '${state.protocol_error.error_type}' is present.`,
      );
    }
    if (state.delivery_sequence) {
      throw new Error(
        "Cannot accept plan: a delivery sequence already exists for this workflow run.",
      );
    }
    const otherAccepted = (state.decisions ?? []).find(
      (d) => Boolean(d.plan_dispatch_id),
    );
    if (otherAccepted) {
      throw new Error(
        `Cannot accept plan '${targetPlanId}': plan '${otherAccepted.plan_dispatch_id}' has already been accepted.`,
      );
    }

    // Physical receipt check in Lifecycle
    const source = (state.completed_stages ?? []).find(
      (c) => c.dispatch_id === targetPlanId,
    );
    if (!source) {
      throw new Error(
        `Planning dispatch '${targetPlanId}' not found in completed stages.`,
      );
    }

    if (
      !source.receipt_path ||
      typeof source.receipt_path !== "string" ||
      !source.receipt_path.trim()
    ) {
      throw new Error(
        `Planning dispatch '${targetPlanId}' has no valid receipt_path.`,
      );
    }
    const resolvedReceipt = path.resolve(source.receipt_path);
    if (
      !fs.existsSync(resolvedReceipt) ||
      fs.statSync(resolvedReceipt).size === 0
    ) {
      throw new Error(
        `Planning receipt at '${resolvedReceipt}' does not exist or is empty.`,
      );
    }

    const deliveryResult = applyDeliveryDecision({
      workflow: state.workflow_snapshot,
      deliveryState: toDeliveryState(state),
      decision: {
        kind: "accept_plan",
        planDispatchId: targetPlanId,
        nextStage: canonicalNextStage,
      },
      completedStages: state.completed_stages ?? [],
    });

    const now = new Date().toISOString();
    const decisionIndex = (state.decisions ?? []).length;
    const record: DecisionRecord = {
      decision: "continue",
      action: "continue",
      reason: options.reason,
      plan_dispatch_id: targetPlanId,
      next_stage: canonicalNextStage,
      timestamp: now,
    };

    const nextState: RuntimeState = {
      ...state,
      ...applyNextDeliveryState(state, deliveryResult.nextDeliveryState),
      current_stage: canonicalNextStage,
      stage_status: "pending",
      pending_stage_selection: {
        stage: canonicalNextStage,
        decision_index: decisionIndex,
      },
      decisions: [...(state.decisions ?? []), record],
      orchestrator_decision: "continue",
      last_updated: now,
    };

    commitRun(root, {
      expected_previous_state: expectedPreviousState,
      target_state: nextState,
    });

    return record;
  }

  // --- Regular Resolve Branch ---
  assertResolveShape(options, state);

  if (options.decision === "finish") {
    if (state.active_dispatch) {
      throw new Error(
        `Cannot finish workflow: active dispatch '${state.active_dispatch.dispatch_id}' is still in flight.`,
      );
    }
    if (state.protocol_error) {
      throw new Error(
        `Cannot finish workflow: active protocol error exists: ${state.protocol_error.message}`,
      );
    }
    assertCanFinish({
      workflow: state.workflow_snapshot,
      deliveryState: toDeliveryState(state),
      completedStages: state.completed_stages ?? [],
    });
  }

  const landingId =
    options.landing_dispatch_id != null
      ? String(options.landing_dispatch_id).trim()
      : null;

  const canonicalNextStage = options.next_stage
    ? resolveCanonicalStage(state.workflow_snapshot, options.next_stage).id
    : undefined;

  let nextDeliveryState = toDeliveryState(state);
  const hasDomainUpdates =
    canonicalNextStage !== undefined ||
    options.current_issue != null ||
    options.mark_landed != null ||
    options.complete_sequence;

  if (hasDomainUpdates) {
    const landing =
      options.mark_landed != null
        ? {
            issueId: String(options.mark_landed).trim(),
            dispatchId: landingId!,
          }
        : undefined;

    const deliveryResult = applyDeliveryDecision({
      workflow: state.workflow_snapshot,
      deliveryState: toDeliveryState(state),
      decision: {
        kind: "update_delivery",
        nextStage: canonicalNextStage,
        currentIssueId:
          options.current_issue != null
            ? String(options.current_issue).trim()
            : undefined,
        landing,
        completeSequence: options.complete_sequence,
      },
      completedStages: withRecoveredIssueIds(
        root,
        state.completed_stages ?? [],
        landingId,
      ),
    });
    nextDeliveryState = deliveryResult.nextDeliveryState;
  }

  const now = new Date().toISOString();
  const decisionIndex = (state.decisions ?? []).length;
  const record: DecisionRecord = {
    decision: options.decision,
    action: options.decision,
    reason: options.reason,
    options: options.options ?? [],
    timestamp: now,
  };
  if (canonicalNextStage) record.next_stage = canonicalNextStage;
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

  let nextPendingSelection = state.pending_stage_selection ?? null;
  if (canonicalNextStage) {
    currentStage = canonicalNextStage;
    stageStatus = "pending";
    nextPendingSelection = {
      stage: canonicalNextStage,
      decision_index: decisionIndex,
    };
  }

  const nextState: RuntimeState = {
    ...state,
    ...applyNextDeliveryState(state, nextDeliveryState),
    current_stage: currentStage,
    stage_status: stageStatus,
    pending_stage_selection: nextPendingSelection,
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
