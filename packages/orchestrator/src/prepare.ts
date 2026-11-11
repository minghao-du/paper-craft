import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadState, getStateFilePath } from "./state.js";
import {
  atomicWriteJson,
  validateEnvelope,
  DEFAULT_RECEIPT_TEMPLATE,
} from "./envelope.js";

import type { Data } from "./workflow.js";

export interface PrepareOptions {
  receipt_root: string;
  stage: string;
  objective: string;
  provider_type?: "skill";
  provider_target?: string;
  provider_args?: string[];
  acceptance_criteria?: string[];
  predecessor_receipts?: string[];
  workdir?: string;
  scope?: string;
  parameters?: Record<string, unknown>;
  attempt_intent?: "same" | "new";
  branch?: string | null;
  commit?: string | null;
  receipt_template?: string;
  rework_issue?: string | number | null;
}

export interface PrepareResult {
  dispatch_id: string;
  step_index: number;
  envelope_path: string;
  receipt_path: string;
  attempt: number;
  status: string;
  stage: string;
  stage_context: Data;
}

/** Prepare one immutable dispatch; routing remains the orchestrator's decision. */
export function prepareTask(options: PrepareOptions): PrepareResult {
  const {
    receipt_root,
    stage,
    objective,
    provider_type,
    provider_target,
    provider_args,
    acceptance_criteria = [],
    predecessor_receipts = [],
    workdir,
    scope = "",
    parameters = {},
    attempt_intent = "same",
    branch,
    commit,
    receipt_template,
    rework_issue,
  } = options;
  const root = path.resolve(receipt_root);
  const state = loadState(root);
  if (
    state.stage_status === "halted" ||
    state.orchestrator_decision === "halt"
  ) {
    throw new Error(
      "Cannot prepare task: Workflow is halted. Run 'resolve --decision continue' to resume first.",
    );
  }
  const context = state.context ?? {};
  const config = state.config_snapshot ?? {};
  const workingDirectory =
    workdir ||
    context.worktree ||
    context.working_directory ||
    config.repo_checkout ||
    process.cwd();
  const resolvedBranch = branch || context.branch || null;
  const resolvedCommit = commit || context.commit || null;
  let stageDef = state.workflow_snapshot?.stages?.find(
    (item: Data) => item.id === stage || item.logical_task === stage,
  );
  if (!stageDef) {
    if (!provider_target)
      throw new Error(
        `Cannot prepare task: Stage '${stage}' is not defined in workflow snapshot and no provider was specified.`,
      );
    stageDef = {
      id: stage,
      provider: {
        type: provider_type || "skill",
        target: provider_target,
        args: provider_args || [],
      },
    };
  }
  const stageProvider = stageDef.provider ?? {};
  const provider = {
    type: provider_type || stageProvider.type || "skill",
    target: provider_target || stageProvider.target,
    args: provider_args ?? stageProvider.args ?? [],
  };
  if (provider.type !== "skill")
    throw new Error(
      `Provider 'type' must be 'skill', received '${provider.type}'`,
    );
  if (!provider.target)
    throw new Error(
      `Provider 'target' must be defined in stage '${stage}' or provided in prepare request.`,
    );
  const template =
    receipt_template ||
    stageDef.receipt_template ||
    stageDef.template ||
    DEFAULT_RECEIPT_TEMPLATE;
  const auxiliary = Boolean(
    stageDef.auxiliary ||
    ["workspace_prepare", "workspace_cleanup"].includes(stage),
  );
  const replan = Boolean(stageDef.replan || stage === "scope_replan");
  const predecessors = [...predecessor_receipts];
  for (const item of predecessors) {
    if (typeof item !== "string" || !item.trim())
      throw new Error("Predecessor receipt path must be a non-empty string.");
    const receipt = path.resolve(item);
    if (!fs.existsSync(receipt))
      throw new Error(`Predecessor receipt does not exist on disk: ${receipt}`);
    if (fs.statSync(receipt).size === 0)
      throw new Error(`Predecessor receipt at ${receipt} is empty.`);
    const relative = path.relative(root, receipt);
    const internal =
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative));
    if (
      internal &&
      !(state.completed_stages ?? []).some(
        (entry: Data) => path.resolve(entry.receipt_path ?? "") === receipt,
      )
    ) {
      throw new Error(
        `Predecessor receipt '${receipt}' does not match any completed stage in this workflow run.`,
      );
    }
  }
  const request = {
    objective,
    provider,
    logical_stage: stage,
    acceptance_criteria,
    predecessors,
    working_directory: workingDirectory,
    branch: resolvedBranch,
    commit: resolvedCommit,
  };
  const active = state.active_dispatch;
  if (active) {
    if (["handed_off", "running"].includes(active.status)) {
      throw new Error(
        `Cannot prepare task: Active dispatch '${active.dispatch_id}' has already been handed off to execution. Complete or resolve it first.`,
      );
    }
    const previous = active.request ?? {};
    const matches =
      active.task_name === stage &&
      previous.objective === objective &&
      isDeepStrictEqual(previous.provider, provider) &&
      isDeepStrictEqual(
        previous.acceptance_criteria ?? [],
        acceptance_criteria,
      ) &&
      isDeepStrictEqual(previous.predecessors ?? [], predecessors) &&
      previous.working_directory === workingDirectory &&
      (previous.branch ?? null) === resolvedBranch &&
      (previous.commit ?? null) === resolvedCommit;
    if (!matches)
      throw new Error(
        `Cannot prepare task: Active dispatch '${active.dispatch_id}' is already pending. Resolve or complete it before preparing a different task.`,
      );
    return dispatchResult(active, stage, stageDef);
  }
  const sequence = state.delivery_sequence;
  let currentItem: Data | null = null;
  let currentIssue = state.current_issue_id ?? state.root_issue_id ?? "0";
  const designated = rework_issue == null ? null : String(rework_issue).trim();
  if (designated !== null) {
    currentItem =
      sequence?.items?.find(
        (item: Data) => String(item.issue_id) === designated,
      ) ?? null;
    if (!currentItem && String(state.root_issue_id) !== designated) {
      throw new Error(
        `Cannot attribute rework to issue '${designated}': issue not found in delivery sequence. Gaps that cannot be attributed to an existing issue must be routed to replanning; do not guess attribution or replace plan.`,
      );
    }
    if (currentItem) sequence.active_rework_issue_id = designated;
    currentIssue = designated;
    state.current_issue_id = designated;
  } else if (sequence?.active_rework_issue_id && !replan) {
    currentIssue = String(sequence.active_rework_issue_id);
    currentItem =
      sequence.items?.find(
        (item: Data) => String(item.issue_id) === currentIssue,
      ) ?? null;
    state.current_issue_id = currentIssue;
  } else if (sequence && !sequence.completed && !replan) {
    currentItem = sequence.items?.[sequence.current_index ?? 0] ?? null;
    if (currentItem)
      state.current_issue_id = currentIssue = currentItem.issue_id;
  }
  const budgets = state.budgets ?? {};
  let attempt: number;
  let deliveryUsed: number;
  let deliveryMax: number;
  let replanUsed: number;
  let replanMax: number;
  if (replan) {
    let originStage = parameters.originating_stage as string | undefined;
    if (!originStage) {
      const currentStage = state.current_stage ?? "stage_1_plan";
      if (currentStage === "scope_replan")
        originStage = state.originating_stage_for_replan ?? "stage_1_plan";
      else {
        originStage = currentStage;
        state.originating_stage_for_replan = originStage;
      }
    }
    const target = currentItem ? (currentItem.budgets ??= {}) : state.budgets;
    const byStage = (target.replans_by_stage ??= {});
    const used = byStage[originStage ?? "stage_1_plan"] ?? 0;
    const max = target.replans_max ?? budgets.replans_max ?? 2;
    if (max <= 0 || used >= max)
      throw new Error(
        `Budget exceeded: replans used (${used}) reached maximum (${max}) for issue ${currentIssue} and stage ${originStage}.`,
      );
    byStage[originStage ?? "stage_1_plan"] = used + 1;
    target.replans_used = (target.replans_used ?? 0) + 1;
    if (currentItem) budgets.replans_used = (budgets.replans_used ?? 0) + 1;
    state.budgets = budgets;
    attempt = used + 1;
    deliveryUsed =
      target.delivery_attempts_used ?? budgets.delivery_attempts_used ?? 0;
    deliveryMax =
      target.delivery_attempts_max ?? budgets.delivery_attempts_max ?? 3;
    replanUsed = attempt;
    replanMax = max;
  } else {
    const target = currentItem ? (currentItem.budgets ??= {}) : budgets;
    if (currentItem) state.originating_stage_for_replan = null;
    const used = target.delivery_attempts_used ?? 0;
    const max =
      target.delivery_attempts_max ?? budgets.delivery_attempts_max ?? 3;
    if (max <= 0)
      throw new Error(
        `Budget exceeded: delivery attempts max (${max}) is exhausted${currentItem ? ` for issue ${currentIssue}` : ""}.`,
      );
    if (auxiliary) attempt = Math.max(1, used);
    else if (used === 0 || attempt_intent === "new") {
      if (used >= max)
        throw new Error(
          `Budget exceeded: delivery attempts used (${used}) reached maximum (${max})${currentItem ? ` for issue ${currentIssue}` : ""}.`,
        );
      attempt = used + 1;
      target.delivery_attempts_used = attempt;
    } else attempt = used;
    // Auxiliary preparation does not consume a delivery attempt.
    budgets.delivery_attempts_used = target.delivery_attempts_used ?? 0;
    if (currentItem) {
      budgets.delivery_attempts_max = max;
      if (!auxiliary) {
        currentItem.stage = stage;
        currentItem.status = "pending";
      }
    }
    state.budgets = budgets;
    deliveryUsed = target.delivery_attempts_used ?? 0;
    deliveryMax = max;
    replanUsed = target.replans_used ?? budgets.replans_used ?? 0;
    replanMax = target.replans_max ?? budgets.replans_max ?? 2;
  }
  const step = state.next_step_index ?? 1;
  state.next_step_index = step + 1;
  const prefix = String(step).padStart(2, "0");
  const dispatchId = `${prefix}-${stage}-issue-${currentIssue}-try-${attempt}`;
  const receiptPath = path.join(root, `${dispatchId}.md`);
  const envelopePath = path.join(root, `${prefix}-input.json`);
  const repository =
    config.delivery_target || context.delivery_target || context.repository;
  const baseBranch = config.base_branch || context.base_branch;
  const params = {
    ...(stageDef.parameters ?? {}),
    ...(stageDef.configs ?? {}),
    ...parameters,
  };
  const defaults = {
    delivery_target: repository,
    base_remote: config.base_remote || context.base_remote,
    push_remote: config.push_remote || context.push_remote,
    worktree_container: config.worktree_container || context.worktree_container,
  };
  for (const [key, value] of Object.entries(defaults))
    if (!(key in params) && value) params[key] = value;
  const envelope = {
    schema_version: "1.0",
    task: {
      logical_stage: stage,
      step_index: step,
      attempt,
      root_issue_id: String(state.root_issue_id ?? "0"),
      current_issue_id: String(currentIssue),
    },
    provider,
    environment: {
      working_directory: String(workingDirectory),
      repository,
      base_branch: baseBranch,
      branch: resolvedBranch,
      commit: resolvedCommit,
    },
    inputs: {
      objective,
      scope: scope || stageDef.scope || "",
      acceptance_criteria,
      predecessor_receipts: predecessors,
      parameters: params,
    },
    contract: { receipt_path: receiptPath, receipt_template: template },
    budgets: {
      delivery_attempts_used: deliveryUsed,
      delivery_attempts_max: deliveryMax,
      replans_used: replanUsed,
      replans_max: replanMax,
    },
  };
  const errors = validateEnvelope(envelope);
  if (errors.length)
    throw new Error(
      `Generated envelope schema validation failed:\n  - ${errors.join("\n  - ")}`,
    );
  atomicWriteJson(envelopePath, envelope);
  state.current_stage = stage;
  state.stage_status = "pending";
  state.active_dispatch = {
    dispatch_id: dispatchId,
    step_index: step,
    task_name: stage,
    issue_id: String(currentIssue),
    attempt,
    status: "prepared",
    authorized: false,
    envelope_path: envelopePath,
    receipt_path: receiptPath,
    stage_context: stageDef,
    request,
  };
  state.last_updated = new Date().toISOString();
  atomicWriteJson(getStateFilePath(root), state);
  return dispatchResult(state.active_dispatch, stage, stageDef);
}

function dispatchResult(
  active: Data,
  stage: string,
  stageContext: Data,
): PrepareResult {
  return {
    dispatch_id: active.dispatch_id,
    step_index: active.step_index,
    envelope_path: active.envelope_path,
    receipt_path: active.receipt_path,
    attempt: active.attempt,
    status: active.status,
    stage,
    stage_context: stageContext,
  };
}
