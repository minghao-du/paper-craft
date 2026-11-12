import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { commitRun, loadRun } from "../run-store/index.js";
import {
  calculateDeliveryChange,
  resolveTaskIntent,
} from "../workflow/index.js";
import { createEnvelope } from "./envelope.js";
import {
  assertNotPaused,
  assertMatchesPendingStageDecision,
  isFinished,
} from "./control.js";
import { parseDispatchRequest } from "./requests.js";
import type { DispatchOptions, DispatchResult, RuntimeState } from "./types.js";

export function dispatchTask(options: DispatchOptions): DispatchResult {
  const {
    receipt_root,
    provider_type,
    provider_target,
    provider_args,
    ...input
  } = options;
  const root = path.resolve(receipt_root);
  const request = parseDispatchRequest({
    ...input,
    provider:
      input.provider ??
      (provider_target
        ? {
            type: provider_type ?? "skill",
            target: provider_target,
            args: provider_args,
          }
        : undefined),
  });
  const state = loadRun<RuntimeState>(root);
  const active = state.active_dispatch;
  const activeReplay = active?.request?.request_id === request.request_id;
  const completed = activeReplay
    ? undefined
    : (state.completed_stages ?? []).find(
        (entry) => entry.request?.request_id === request.request_id,
      );
  const replay = activeReplay ? active : completed;

  // Resolve identity before applying current admission rules or dynamic defaults.
  if (replay && !isDeepStrictEqual(replay.request, request)) {
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
    if (activeReplay) {
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
  const intent = resolveTaskIntent(
    state.workflow_snapshot,
    request.stage,
    request.provider,
    {
      template: request.receipt_template,
      scope: request.scope,
      parameters: request.parameters,
      configSnapshot: state.config_snapshot,
      context: state.context,
    },
  );
  assertMatchesPendingStageDecision(
    state,
    intent.canonical_stage,
    intent.auxiliary,
  );

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

  const deliveryChange = calculateDeliveryChange({
    intent,
    deliverySequence: structuredClone(state.delivery_sequence),
    budgets: structuredClone(state.budgets),
    currentIssueId: state.current_issue_id,
    rootIssueId: state.root_issue_id,
    reworkIssue: request.rework_issue,
    attemptIntent: request.attempt_intent,
    originatingStageForReplan: state.originating_stage_for_replan,
    parameters: intent.parameters,
  });

  const step = state.next_step_index ?? 1;
  const prefix = String(step).padStart(2, "0");
  const dispatchId = `${prefix}-${intent.canonical_stage}-issue-${deliveryChange.current_issue_id}-try-${deliveryChange.attempt}`;
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
      logical_stage: intent.canonical_stage,
      step_index: step,
      attempt: deliveryChange.attempt,
      root_issue_id: String(state.root_issue_id ?? "0"),
      current_issue_id: String(deliveryChange.current_issue_id),
    },
    provider: intent.provider,
    environment: {
      working_directory: workingDirectory,
      repository,
      base_branch: baseBranch,
      branch: resolvedBranch,
      commit: resolvedCommit,
    },
    inputs: {
      objective: request.objective,
      scope: intent.scope,
      acceptance_criteria: request.acceptance_criteria,
      predecessor_receipts: request.predecessor_receipts,
      parameters: intent.parameters,
    },
    contract: {
      receipt_path: receiptPath,
      receipt_template: intent.template,
    },
    budgets: {
      delivery_attempts_used: deliveryChange.delivery_attempts_used,
      delivery_attempts_max: deliveryChange.delivery_attempts_max,
      replans_used: deliveryChange.replan_attempts_used,
      replans_max: deliveryChange.replan_attempts_max,
    },
  });

  const nextState: RuntimeState = {
    ...state,
    current_issue_id: deliveryChange.current_issue_id,
    current_stage: intent.canonical_stage,
    stage_status: "in_progress",
    next_step_index: step + 1,
    budgets: deliveryChange.budgets,
    delivery_sequence: deliveryChange.delivery_sequence,
    originating_stage_for_replan: deliveryChange.originating_stage_for_replan,
    active_dispatch: {
      dispatch_id: dispatchId,
      step_index: step,
      task_name: intent.canonical_stage,
      issue_id: String(deliveryChange.current_issue_id),
      attempt: deliveryChange.attempt,
      status: "handed_off",
      authorized: true,
      envelope_path: envelopePath,
      receipt_path: receiptPath,
      provider: intent.provider,
      request,
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
    attempt: deliveryChange.attempt,
    status: "handed_off",
    launch_granted: true,
    stage: intent.canonical_stage,
    provider: intent.provider,
  };
}
