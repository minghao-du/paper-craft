/**
 * Workflow run initialization.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceConfig } from "../../../workspace-config/src/index.js";
import { commitRun, loadRunIfExists, replaceRun } from "../run-store/index.js";
import { loadAndValidateWorkflow } from "../workflow/index.js";
import type { InitOptions, RuntimeState } from "./types.js";

const DEPRECATED_INIT_OPTIONS = [
  "plan",
  "child_issues",
  "child_issue",
  "child-issues",
  "child-issue",
  "current_issue",
  "current-issue",
  "initial_stage",
  "initial-stage",
] as const;

const INIT_ALLOWED_FIELDS = [
  "root_issue",
  "receipt_root",
  "repo_dir",
  "workflow",
  "force",
  "require_config",
  "delivery_attempts_max",
  "replans_max",
  "delivery_target",
  "base_remote",
  "push_remote",
  "base_branch",
  "worktree_container",
];

export function initWorkflow(o: InitOptions): RuntimeState {
  const oRec = o as unknown as Record<string, unknown>;
  for (const key of DEPRECATED_INIT_OPTIONS) {
    if (key in oRec && oRec[key] !== undefined) {
      throw new Error(
        `Init option '${key}' has been removed and is no longer supported.`,
      );
    }
  }

  const unknown = Object.keys(oRec).filter(
    (k) => !INIT_ALLOWED_FIELDS.includes(k),
  );
  if (unknown.length) {
    throw new Error(`Unknown init option '${unknown[0]}'.`);
  }

  if (
    o.root_issue === undefined ||
    o.root_issue === null ||
    String(o.root_issue).trim() === ""
  ) {
    throw new Error("Init option 'root_issue' is required.");
  }
  const rootIssue = String(o.root_issue).trim();

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
    if (oRec[key] != null) overrides[key] = oRec[key];
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
        `issue-${rootIssue}`,
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

  const existing = o.force ? null : loadRunIfExists<RuntimeState>(root);
  if (existing) {
    if (existing.schema_version === "1.0") {
      throw new Error(
        "Cannot restore or write to legacy schema_version '1.0' run. Finish it with the previous version or inspect read-only, or start a new run in a new receipt root.",
      );
    }
    if (existing.schema_version !== "1.1") {
      throw new Error(
        `Unsupported schema_version '${existing.schema_version}'. This version of the orchestrator only supports schema_version '1.1'.`,
      );
    }
    // Strict structural validation of existing saved snapshot without reading external files
    loadAndValidateWorkflow(existing.workflow_snapshot, undefined, "snapshot");

    const oldRepo =
      existing.config_snapshot?.repo_checkout ??
      (existing.context?.repo_checkout as string | undefined);
    if (
      String(existing.root_issue_id) !== rootIssue ||
      (o.workflow && existing.workflow !== o.workflow) ||
      (oldRepo && path.resolve(String(oldRepo)) !== path.resolve(config.repo_checkout))
    ) {
      throw new Error(
        "Run identity conflict: existing state belongs to another issue, workflow, or repository. Use --force to overwrite.",
      );
    }
    return existing;
  }

  const snapshot = loadAndValidateWorkflow(o.workflow || config.workflow, repo, "source");

  const stage = snapshot.initial_stage || snapshot.stages[0]?.id;
  if (!stage) {
    throw new Error(
      `Workflow snapshot '${snapshot.name}' contains no stages.`,
    );
  }

  const state: RuntimeState = {
    schema_version: "1.1",
    root_issue_id: rootIssue,
    current_issue_id: rootIssue,
    workflow: snapshot.name,
    workflow_snapshot: snapshot,
    current_stage: stage,
    stage_status: "pending",
    next_step_index: 1,
    active_dispatch: null,
    completed_stages: [],
    decisions: [],
    pending_stage_selection: null,
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

  if (o.force) {
    replaceRun(root, state);
  } else {
    commitRun(root, {
      is_initial: true,
      expected_previous_state: null,
      target_state: state,
    });
  }

  return state;
}
