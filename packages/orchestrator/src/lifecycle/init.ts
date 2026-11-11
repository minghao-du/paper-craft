/**
 * Workflow run initialization.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceConfig } from "../../../workspace-config/src/config.js";
import { commitRun, getStateFilePath, getPendingCommitPath, loadRun } from "../run-store/index.js";
import {
  loadAndValidateWorkflow,
  makeDeliverySequence,
  readPlan,
  validatePlanOrder,
} from "../workflow/index.js";
import type { InitOptions, RuntimeState } from "./types.js";

export function initWorkflow(o: InitOptions): RuntimeState {
  const repo = path.resolve(o.repo_dir ?? ".");
  if (!fs.existsSync(repo)) {
    throw new Error(`Repository directory does not exist: ${repo}`);
  }

  const overrides: Record<string, unknown> = {};
  for (const key of [
    "workflow",
    "delivery_attempts_max",
    "replans_max",
    "delivery_target",
    "base_remote",
    "push_remote",
    "base_branch",
    "worktree_container",
  ]) {
    if (o[key] != null) overrides[key] = o[key];
  }

  const config = resolveWorkspaceConfig({
    repoDir: repo,
    overrides,
    requireFile: o.require_config ?? false,
  });

  const root = path.resolve(
    o.receipt_root?.trim() ||
      path.join(
        config.worktree_container_resolved,
        ".paper-craft",
        "receipts",
        `issue-${o.root_issue ?? 0}`,
      ),
  );

  const nested = (a: string, b: string): boolean => {
    const rel = path.relative(a, b);
    return (
      !rel ||
      (!rel.startsWith(".." + path.sep) &&
        rel !== ".." &&
        !path.isAbsolute(rel))
    );
  };

  if (nested(repo, root) || nested(root, repo)) {
    throw new Error(
      `Receipt root '${root}' violates isolation constraints: cannot be within or contain repository checkout '${repo}'.`,
    );
  }

  const configSnapshot: Record<string, unknown> = {
    ...config,
    receipt_root: root,
  };

  const snapshot = loadAndValidateWorkflow(o.workflow || config.workflow, repo);
  const rootIssue = String(o.root_issue ?? 0);
  const stateFile = getStateFilePath(root);

  if (fs.existsSync(stateFile) && !o.force) {
    const existing = loadRun<RuntimeState>(root);
    const oldRepo =
      existing.config_snapshot?.repo_checkout ??
      (existing.context?.repo_checkout as string | undefined);
    if (
      String(existing.root_issue_id) !== rootIssue ||
      (existing.workflow !== config.workflow &&
        existing.workflow !== snapshot.name) ||
      (oldRepo && path.resolve(String(oldRepo)) !== path.resolve(config.repo_checkout))
    ) {
      throw new Error(
        "Run identity conflict: existing state belongs to another issue, workflow, or repository. Use --force to overwrite.",
      );
    }
    return existing;
  }

  const children = o.child_issues?.length
    ? validatePlanOrder(o.child_issues)
    : o.plan
      ? readPlan(o.plan)
      : null;

  const ids = new Set(snapshot.stages.map((s) => s.id));
  if (o.initial_stage && !ids.has(o.initial_stage)) {
    throw new Error(
      `Requested initial_stage '${o.initial_stage}' not found in workflow snapshot.`,
    );
  }

  const stage =
    o.initial_stage ||
    (children
      ? ids.has("stage_2_work")
        ? "stage_2_work"
        : snapshot.stages[0].id
      : snapshot.initial_stage || snapshot.stages[0].id);

  const current = String(o.current_issue || children?.[0] || rootIssue);

  const state: RuntimeState = {
    schema_version: "1.0",
    root_issue_id: rootIssue,
    current_issue_id: current,
    workflow: snapshot.name,
    workflow_snapshot: snapshot,
    current_stage: stage,
    stage_status: "pending",
    next_step_index: 1,
    active_dispatch: null,
    completed_stages: [],
    decisions: [],
    budgets: {
      delivery_attempts_used: 0,
      delivery_attempts_max: config.delivery_attempts_max,
      replans_used: 0,
      replans_max: config.replans_max,
    },
    context: {
      repository: config.delivery_target,
      delivery_target: config.delivery_target,
      base_branch: config.base_branch,
      base_remote: config.base_remote,
      push_remote: config.push_remote,
      worktree_container: config.worktree_container,
      repo_checkout: config.repo_checkout,
    },
    config_snapshot: configSnapshot,
    last_updated: new Date().toISOString(),
  };

  if (children) {
    state.delivery_sequence = makeDeliverySequence(
      children,
      config.delivery_attempts_max,
    );
  } else if (
    ["stage_2_work", "issue_work"].includes(o.initial_stage ?? "") ||
    (o.current_issue && String(o.current_issue) !== rootIssue)
  ) {
    state.delivery_sequence = makeDeliverySequence(
      [current],
      config.delivery_attempts_max,
    );
  }

  let existingState: RuntimeState | null = null;
  if (fs.existsSync(stateFile) && o.force) {
    try {
      existingState = loadRun<RuntimeState>(root);
    } catch {
      if (fs.existsSync(getPendingCommitPath(root))) {
        try {
          fs.unlinkSync(getPendingCommitPath(root));
        } catch {}
      }
      try {
        fs.unlinkSync(stateFile);
      } catch {}
      existingState = null;
    }
  }

  commitRun(root, {
    is_initial: existingState === null,
    expected_previous_state: existingState,
    target_state: state,
  });

  return state;
}
