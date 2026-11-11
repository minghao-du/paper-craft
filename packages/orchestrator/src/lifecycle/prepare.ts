/**
 * Prepare task operation for Lifecycle.
 */
import fs from "node:fs";
import path from "node:path";
import { commitRun, loadRun } from "../run-store/index.js";
import { calculateDeliveryChange, resolveTaskIntent } from "../workflow/index.js";
import { createEnvelope } from "./envelope.js";
import { compareNormalizedRequests, parsePrepareRequest } from "./requests.js";
import type { PrepareOptions, PrepareResult, RuntimeState } from "./types.js";

export function prepareTask(options: PrepareOptions): PrepareResult {
  const root = path.resolve(options.receipt_root);
  const state = loadRun<RuntimeState>(root);
  const expectedPreviousState = JSON.parse(JSON.stringify(state));

  if (
    state.stage_status === "halted" ||
    state.orchestrator_decision === "halt"
  ) {
    throw new Error(
      "Cannot prepare task: Workflow is halted. Run 'resolve --decision continue' to resume first.",
    );
  }

  if (
    state.stage_status === "succeeded" &&
    state.current_stage === "completed"
  ) {
    throw new Error(
      "Cannot prepare task: Workflow is completed. Start a new run in a new receipt root.",
    );
  }

  const context = state.context ?? {};
  const config = state.config_snapshot ?? {};
  const workingDirectory =
    options.workdir ||
    (context.worktree as string | undefined) ||
    (context.working_directory as string | undefined) ||
    (config.repo_checkout as string | undefined) ||
    process.cwd();
  const resolvedBranch =
    options.branch !== undefined
      ? options.branch
      : ((context.branch as string | null | undefined) ?? null);
  const resolvedCommit =
    options.commit !== undefined
      ? options.commit
      : ((context.commit as string | null | undefined) ?? null);

  const rawRequest: Record<string, unknown> = {
    stage: options.stage,
    objective: options.objective,
    workdir: workingDirectory,
    branch: resolvedBranch,
    commit: resolvedCommit,
  };

  if (options.provider) {
    rawRequest.provider = options.provider;
  } else if (options.provider_target) {
    rawRequest.provider = {
      type: options.provider_type || "skill",
      target: options.provider_target,
      args: options.provider_args ?? [],
    };
  }

  if (options.acceptance_criteria !== undefined) {
    rawRequest.acceptance_criteria = options.acceptance_criteria;
  }
  if (options.predecessor_receipts !== undefined) {
    rawRequest.predecessor_receipts = options.predecessor_receipts;
  }
  if (options.scope !== undefined) {
    rawRequest.scope = options.scope;
  }
  if (options.parameters !== undefined) {
    rawRequest.parameters = options.parameters;
  }
  if (options.attempt_intent !== undefined) {
    rawRequest.attempt_intent = options.attempt_intent;
  }
  if (options.receipt_template !== undefined) {
    rawRequest.receipt_template = options.receipt_template;
  }
  if (options.rework_issue !== undefined) {
    rawRequest.rework_issue = options.rework_issue;
  }

  const normalizedRequest = parsePrepareRequest(rawRequest);

  const intent = resolveTaskIntent(
    state.workflow_snapshot,
    normalizedRequest.stage,
    normalizedRequest.provider,
    {
      template: normalizedRequest.receipt_template,
      scope: normalizedRequest.scope,
      parameters: normalizedRequest.parameters,
      configSnapshot: state.config_snapshot,
      context: state.context,
    },
  );

  normalizedRequest.stage = intent.canonical_stage;
  normalizedRequest.logical_stage = intent.canonical_stage;
  normalizedRequest.provider = intent.provider;
  normalizedRequest.scope = intent.scope;
  normalizedRequest.parameters = intent.parameters;
  normalizedRequest.receipt_template = intent.template;

  const active = state.active_dispatch;
  if (active) {
    if (["handed_off", "running"].includes(active.status)) {
      throw new Error(
        `Cannot prepare task: Active dispatch '${active.dispatch_id}' has already been handed off to execution. Complete or resolve it first.`,
      );
    }
    if (active.status === "prepared") {
      if (compareNormalizedRequests(active.request, normalizedRequest)) {
        return {
          dispatch_id: active.dispatch_id,
          step_index: active.step_index,
          envelope_path: active.envelope_path,
          receipt_path: active.receipt_path,
          attempt: active.attempt,
          status: active.status,
          stage: active.task_name,
          stage_context: active.stage_context ?? {},
        };
      }
      throw new Error(
        `Cannot prepare task: Active dispatch '${active.dispatch_id}' is already pending. Resolve or complete it before preparing a different task.`,
      );
    }
  }

  for (const item of normalizedRequest.predecessor_receipts) {
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
    deliverySequence: state.delivery_sequence,
    budgets: state.budgets,
    currentIssueId: state.current_issue_id,
    rootIssueId: state.root_issue_id,
    reworkIssue: normalizedRequest.rework_issue,
    attemptIntent: normalizedRequest.attempt_intent,
    originatingStageForReplan: state.originating_stage_for_replan,
    parameters: normalizedRequest.parameters,
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
      objective: normalizedRequest.objective,
      scope: intent.scope,
      acceptance_criteria: normalizedRequest.acceptance_criteria,
      predecessor_receipts: normalizedRequest.predecessor_receipts,
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

  normalizedRequest.stage = intent.canonical_stage;
  normalizedRequest.logical_stage = intent.canonical_stage;
  normalizedRequest.provider = intent.provider;
  normalizedRequest.scope = intent.scope;
  normalizedRequest.parameters = intent.parameters;
  normalizedRequest.receipt_template = intent.template;

  const nextState: RuntimeState = {
    ...state,
    current_issue_id: deliveryChange.current_issue_id,
    current_stage: intent.canonical_stage,
    stage_status: "pending",
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
      status: "prepared",
      authorized: false,
      envelope_path: envelopePath,
      receipt_path: receiptPath,
      stage_context: intent.stage_def as Record<string, unknown>,
      request: normalizedRequest,
    },
    last_updated: new Date().toISOString(),
  };

  commitRun(root, {
    expected_previous_state: expectedPreviousState,
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
    status: "prepared",
    stage: intent.canonical_stage,
    stage_context: intent.stage_def as Record<string, unknown>,
  };
}
