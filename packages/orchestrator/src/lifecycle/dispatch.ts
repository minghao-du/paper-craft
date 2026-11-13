import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { commitRun, loadRun } from "../run-store/index.js";
import {
  evaluateDispatch,
  resolveCanonicalStage,
} from "../workflow/index.js";
import { createEnvelope } from "./envelope.js";
import { toDeliveryState, applyNextDeliveryState } from "./domain-state.js";
import {
  assertNotPaused,
  assertMatchesPendingStageDecision,
  isFinished,
} from "./control.js";
import {
  parseDispatchRequest,
  parseHistoricalDispatchRequest,
} from "./requests.js";
import type {
  Dispatch,
  DispatchOptions,
  DispatchResult,
  NormalizedDispatchRequest,
  RuntimeState,
} from "./types.js";

export function dispatchTask(options: DispatchOptions): DispatchResult {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Dispatch options must be a JSON object");
  }
  const { receipt_root, ...requestInput } = options;
  if (typeof receipt_root !== "string" || !receipt_root.trim()) {
    throw new Error("--receipt-root is required");
  }
  const root = path.resolve(receipt_root);

  const rawRequestId = (requestInput as Record<string, unknown>).request_id;
  const requestId =
    typeof rawRequestId === "string" ? rawRequestId.trim() : undefined;

  const state = loadRun<RuntimeState>(root);
  if (state.schema_version === "1.0") {
    throw new Error(
      "Cannot dispatch task: legacy schema_version '1.0' run does not support writes. Finish it with the previous version or inspect read-only, or start a new run in a new receipt root.",
    );
  }
  if (state.schema_version !== "1.1") {
    throw new Error(
      `Unsupported schema_version '${state.schema_version}'. This version only supports '1.1'.`,
    );
  }

  const active = state.active_dispatch;
  const activeReplay =
    requestId !== undefined &&
    requestId !== "" &&
    active?.request?.request_id === requestId;
  const completed =
    activeReplay || requestId === undefined || requestId === ""
      ? undefined
      : (state.completed_stages ?? []).find(
          (entry) => entry.request?.request_id === requestId,
        );
  const replay = activeReplay ? active : completed;

  let request: NormalizedDispatchRequest;

  // 1-3. If matching request_id exists, resolve identity before applying admission rules or dynamic defaults.
  if (replay) {
    const idVersion = replay.request_identity_version;
    if (idVersion === 2) {
      request = parseDispatchRequest(requestInput);
    } else if (idVersion === undefined || idVersion === 1) {
      request = parseHistoricalDispatchRequest(requestInput);
    } else {
      throw new Error(
        `Unrecognized request_identity_version '${idVersion}'.`,
      );
    }

    if (!isDeepStrictEqual(replay.request, request)) {
      throw new Error(
        `Conflicting dispatch request: request_id '${request.request_id}' is already associated with different content.`,
      );
    }

    if (completed) {
      if (!completed.provider || !completed.envelope_path) {
        throw new Error(
          `Completed dispatch '${completed.dispatch_id}' is missing replay metadata.`,
        );
      }
      return {
        dispatch_id: completed.dispatch_id,
        step_index: completed.step_index,
        attempt: completed.attempt,
        stage: completed.stage,
        status: "completed",
        launch_granted: false,
        provider: completed.provider,
        envelope_path: completed.envelope_path,
        receipt_path: completed.receipt_path,
        completion: completed,
      };
    }

    if (active) {
      if (active.status === "prepared") {
        throw new Error(
          `Cannot dispatch task: legacy dispatch '${active.dispatch_id}' is prepared without a launch grant. Finish it with the previous version or verify it was never launched and start a new run in a new receipt root.`,
        );
      }
      if (!active.provider) {
        throw new Error(
          `Active dispatch '${active.dispatch_id}' is missing replay metadata.`,
        );
      }
      return {
        dispatch_id: active.dispatch_id,
        step_index: active.step_index,
        attempt: active.attempt,
        stage: active.task_name,
        status: active.status,
        launch_granted: false,
        provider: active.provider,
        envelope_path: active.envelope_path,
        receipt_path: active.receipt_path,
      };
    }
  }

  // 4. For an unmatched ID, validate and normalize using the strict new-request contract.
  request = parseDispatchRequest(requestInput);

  // 5. Only for a genuinely new request, check run admission and evaluate dynamic defaults/domain rules.
  if (active) {
    throw new Error(
      `Cannot dispatch task: Active dispatch '${active.dispatch_id}' already has launch authorization. Verify the original execution and submit its completion report with 'complete'.`,
    );
  }

  if (isFinished(state)) {
    throw new Error(
      "Cannot dispatch task: Workflow is completed. Start a new run in a new receipt root.",
    );
  }
  assertNotPaused(state, "dispatch a task");

  const context = state.context ?? {};
  const config = state.config_snapshot ?? {};
  const workingDirectory = path.resolve(
    request.workdir ||
      (context.worktree as string | undefined) ||
      (context.working_directory as string | undefined) ||
      (config.repo_checkout as string | undefined) ||
      process.cwd(),
  );
  const resolvedBranch =
    request.branch !== undefined
      ? request.branch
      : ((context.branch as string | null | undefined) ?? null);
  const resolvedCommit =
    request.commit !== undefined
      ? request.commit
      : ((context.commit as string | null | undefined) ?? null);
  for (const item of request.predecessor_receipts) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("Predecessor receipt path must be a non-empty string.");
    }
    const receipt = path.resolve(item);
    if (!fs.existsSync(receipt)) {
      throw new Error(`Predecessor receipt does not exist on disk: ${receipt}`);
    }
    if (fs.statSync(receipt).size === 0) {
      throw new Error(`Predecessor receipt at ${receipt} is empty.`);
    }
    const relative = path.relative(root, receipt);
    const internal =
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative));
    if (
      internal &&
      !(state.completed_stages ?? []).some(
        (entry) => path.resolve(entry.receipt_path ?? "") === receipt,
      )
    ) {
      throw new Error(
        `Predecessor receipt '${receipt}' does not match any completed stage in this workflow run.`,
      );
    }
  }

  const evaluation = evaluateDispatch({
    workflow: state.workflow_snapshot,
    deliveryState: toDeliveryState(state),
    request: {
      stage: request.stage,
      objective: request.objective,
      provider: request.provider,
      scope: request.scope,
      parameters: request.parameters,
      receipt_template: request.receipt_template,
      attempt_intent: request.attempt_intent,
      rework_issue: request.rework_issue,
      originating_stage: request.parameters?.originating_stage as string | undefined,
    },
    environmentDefaults: {
      delivery_target:
        (state.config_snapshot?.delivery_target as string | undefined) ||
        (context.delivery_target as string | undefined) ||
        (context.repository as string | undefined),
      base_remote:
        (state.config_snapshot?.base_remote as string | undefined) ||
        (context.base_remote as string | undefined),
      push_remote:
        (state.config_snapshot?.push_remote as string | undefined) ||
        (context.push_remote as string | undefined),
      worktree_container:
        (state.config_snapshot?.worktree_container as string | undefined) ||
        (context.worktree_container as string | undefined),
    },
    completedStages: state.completed_stages ?? [],
  });
  const task = evaluation.task;

  assertMatchesPendingStageDecision(state, task.stage, task.auxiliary);

  const step = state.next_step_index ?? 1;
  const prefix = String(step).padStart(2, "0");
  const dispatchId = `${prefix}-${task.stage}-issue-${task.issueId}-try-${task.attempt}`;
  const receiptPath = path.join(root, `${dispatchId}.md`);
  const envelopeFilename = `${prefix}-input.json`;
  const envelopePath = path.join(root, envelopeFilename);

  const repository =
    (state.config_snapshot?.delivery_target as string | undefined) ||
    (state.context?.delivery_target as string | undefined) ||
    (state.context?.repository as string | undefined) ||
    "local/repo";
  const baseBranch =
    (state.config_snapshot?.base_branch as string | undefined) ||
    (state.context?.base_branch as string | undefined) ||
    "main";

  const envelope = createEnvelope({
    schema_version: "1.0",
    task: {
      logical_stage: task.stage,
      step_index: step,
      attempt: task.attempt,
      root_issue_id: String(state.root_issue_id ?? "0"),
      current_issue_id: String(task.issueId),
    },
    provider: task.provider,
    environment: {
      working_directory: workingDirectory,
      repository,
      base_branch: baseBranch,
      branch: resolvedBranch,
      commit: resolvedCommit,
    },
    inputs: {
      objective: request.objective,
      scope: task.scope,
      acceptance_criteria: request.acceptance_criteria,
      predecessor_receipts: request.predecessor_receipts,
      parameters: task.parameters,
    },
    contract: {
      receipt_path: receiptPath,
      receipt_template: task.receiptTemplate,
    },
    budgets: {
      delivery_attempts_used: task.budgets.delivery_attempts_used,
      delivery_attempts_max: task.budgets.delivery_attempts_max,
      replans_used: task.budgets.replans_used,
      replans_max: task.budgets.replans_max,
    },
  });

  const nextPendingSelection = task.auxiliary
    ? (state.pending_stage_selection ?? null)
    : null;

  const nextState: RuntimeState = {
    ...state,
    ...applyNextDeliveryState(state, evaluation.nextDeliveryState),
    current_stage: task.stage,
    stage_status: "in_progress",
    next_step_index: step + 1,
    pending_stage_selection: nextPendingSelection,
    originating_stage_for_replan: task.originatingStage ?? null,
    active_dispatch: {
      dispatch_id: dispatchId,
      step_index: step,
      task_name: task.stage,
      issue_id: String(task.issueId),
      attempt: task.attempt,
      delivery_attempt: task.deliveryAttempt,
      originating_stage: task.originatingStage,
      status: "handed_off",
      authorized: true,
      envelope_path: envelopePath,
      receipt_path: receiptPath,
      provider: task.provider,
      request,
      request_identity_version: 2,
    },
    last_updated: new Date().toISOString(),
  };

  commitRun(root, {
    expected_previous_state: state,
    target_state: nextState,
    envelope: {
      filename: envelopeFilename,
      content: envelope,
    },
  });

  return {
    dispatch_id: dispatchId,
    step_index: step,
    envelope_path: envelopePath,
    receipt_path: receiptPath,
    attempt: task.attempt,
    status: "handed_off",
    launch_granted: true,
    stage: task.stage,
    provider: task.provider,
  };
}
