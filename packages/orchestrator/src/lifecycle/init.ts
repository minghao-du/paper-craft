/**
 * Workflow run initialization.
 */
import fs from "node:fs";
import path from "node:path";
import {
  findPrimaryCheckout,
  resolveWorkspaceConfig,
} from "../../../workspace-config/src/index.js";
import {
  commitRun,
  inspectRunStorage,
  loadRunIfExists,
  replaceRun,
} from "../run-store/index.js";
import {
  DEFAULT_WORKFLOW_PATH,
  loadAndValidateWorkflow,
} from "../workflow/index.js";
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

const NON_IDENTITY_CREATE_OPTIONS = [
  "delivery_attempts_max",
  "replans_max",
  "delivery_target",
  "base_remote",
  "push_remote",
  "base_branch",
  "worktree_container",
] as const;

function realpathSafe(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sameRepository(candidateRepo: string, savedRepo: string): boolean {
  const candidateReal = realpathSafe(candidateRepo);
  const savedReal = realpathSafe(savedRepo);
  if (candidateReal === savedReal) {
    return true;
  }
  if (!fs.existsSync(candidateReal) || !fs.existsSync(savedReal)) {
    return false;
  }
  try {
    const candidatePrimary = findPrimaryCheckout(candidateReal);
    const savedPrimary = findPrimaryCheckout(savedReal);
    return candidatePrimary === savedPrimary || candidatePrimary === savedReal;
  } catch {
    return false;
  }
}

function normalizeWorkflowLocator(
  rawWorkflow: unknown,
  baseDir?: string,
): string | undefined {
  if (typeof rawWorkflow !== "string") return undefined;
  const trimmed = rawWorkflow.trim();
  if (!trimmed) return undefined;
  if (trimmed === "default") {
    return path.resolve(DEFAULT_WORKFLOW_PATH);
  }
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(baseDir ?? ".", trimmed);
}

function getSavedCreateOptionValue(
  existing: RuntimeState,
  key: (typeof NON_IDENTITY_CREATE_OPTIONS)[number],
): unknown {
  const fromConfig = existing.config_snapshot?.[key];
  if (fromConfig !== undefined) return fromConfig;
  if (key === "delivery_attempts_max" || key === "replans_max") {
    return existing.budgets?.[key];
  }
  if (key === "delivery_target") {
    return existing.context?.delivery_target ?? existing.context?.repository;
  }
  return existing.context?.[key];
}

function assertRestoreMatchesExisting(
  existing: RuntimeState,
  o: InitOptions,
  oRec: Record<string, unknown>,
  rootIssue: string,
  resolvedRepoCheckout?: string,
): void {
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

  if (String(existing.root_issue_id) !== rootIssue) {
    throw new Error(
      "Run identity conflict: existing state belongs to another issue, workflow, or repository. Use a new receipt root for a separate run.",
    );
  }

  const savedRepo =
    existing.config_snapshot?.repo_checkout ??
    (existing.context?.repo_checkout as string | undefined);
  const explicitRepoDir =
    o.repo_dir !== undefined && String(o.repo_dir).trim() !== ""
      ? String(o.repo_dir)
      : undefined;
  const repoToCheck = explicitRepoDir ?? resolvedRepoCheckout;
  if (repoToCheck && savedRepo && !sameRepository(repoToCheck, String(savedRepo))) {
    throw new Error(
      "Run identity conflict: existing state belongs to another issue, workflow, or repository. Use a new receipt root for a separate run.",
    );
  }

  const explicitWorkflow =
    o.workflow !== undefined && String(o.workflow).trim() !== ""
      ? String(o.workflow)
      : undefined;
  if (explicitWorkflow) {
    const savedBase = savedRepo ? path.resolve(String(savedRepo)) : undefined;
    const savedLocator =
      normalizeWorkflowLocator(existing.workflow_locator, savedBase) ??
      normalizeWorkflowLocator(existing.config_snapshot?.workflow, savedBase);
    if (!savedLocator) {
      throw new Error(
        "Cannot verify explicit workflow override: existing run has no stored workflow locator. Resume without '--workflow' or start a new receipt root.",
      );
    }
    const requestedBase = explicitRepoDir
      ? path.resolve(explicitRepoDir)
      : savedBase ?? path.resolve(".");
    const requestedLocator = normalizeWorkflowLocator(explicitWorkflow, requestedBase);
    if (requestedLocator !== savedLocator) {
      throw new Error(
        "Run identity conflict: existing state belongs to another issue, workflow, or repository. Use a new receipt root for a separate run.",
      );
    }
  }

  for (const key of NON_IDENTITY_CREATE_OPTIONS) {
    const incoming = oRec[key];
    if (incoming === undefined || incoming === null) continue;
    const saved = getSavedCreateOptionValue(existing, key);
    if (saved !== undefined && incoming !== saved) {
      throw new Error(
        `Cannot override '${key}' when resuming an existing run (saved '${String(saved)}', received '${String(incoming)}'). Start a new receipt root to change run configuration.`,
      );
    }
  }
}

function hasDispatchStateEvidence(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const rec = candidate as Record<string, unknown>;
  if (rec.active_dispatch !== null && rec.active_dispatch !== undefined) {
    return true;
  }
  if (Array.isArray(rec.completed_stages) && rec.completed_stages.length > 0) {
    return true;
  }
  if (typeof rec.next_step_index === "number" && rec.next_step_index > 1) {
    return true;
  }
  return false;
}

function assertCanForceReplaceRun(root: string): void {
  const inspected = inspectRunStorage<Record<string, unknown>>(root);
  if (!inspected.exists) {
    return;
  }
  if (inspected.dispatchArtifacts.length > 0) {
    throw new Error(
      `Cannot reset receipt root '${root}' with --force: dispatch artifacts already exist (${inspected.dispatchArtifacts.join(", ")}). Use a new receipt root for a new run.`,
    );
  }
  if (inspected.pendingExists) {
    if (inspected.pendingCorrupt) {
      throw new Error(
        `Cannot reset receipt root '${root}' with --force: pending-commit.json is corrupt and dispatch history cannot be verified safely. Use a new receipt root for a new run.`,
      );
    }
    if (
      inspected.pending &&
      (inspected.pending.envelope != null ||
        hasDispatchStateEvidence(inspected.pending.target_state) ||
        hasDispatchStateEvidence(inspected.pending.expected_previous_state))
    ) {
      throw new Error(
        `Cannot reset receipt root '${root}' with --force: pending commit contains dispatched work evidence. Use a new receipt root for a new run.`,
      );
    }
  }
  if (
    inspected.stateExists &&
    !inspected.stateCorrupt &&
    hasDispatchStateEvidence(inspected.state)
  ) {
    throw new Error(
      `Cannot reset receipt root '${root}' with --force: work has already been dispatched in this run. Use a new receipt root for a new run.`,
    );
  }
}

function assertRootIsolated(root: string, repo: string): void {
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
}

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

  const explicitRoot = o.receipt_root?.trim()
    ? path.resolve(o.receipt_root.trim())
    : null;

  if (explicitRoot && !o.force) {
    const existing = loadRunIfExists<RuntimeState>(explicitRoot);
    if (existing) {
      assertRestoreMatchesExisting(existing, o, oRec, rootIssue);
      return existing;
    }
  }

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

  const root =
    explicitRoot ??
    path.resolve(
      path.join(
        config.worktree_container_resolved,
        ".paper-craft",
        "receipts",
        `issue-${rootIssue}`,
      ),
    );

  assertRootIsolated(root, repo);

  const configSnapshot: Record<string, unknown> = {
    ...config,
    receipt_root: root,
  };

  if (!explicitRoot && !o.force) {
    const existing = loadRunIfExists<RuntimeState>(root);
    if (existing) {
      assertRestoreMatchesExisting(
        existing,
        o,
        oRec,
        rootIssue,
        config.repo_checkout,
      );
      return existing;
    }
  }

  if (o.force) {
    assertCanForceReplaceRun(root);
  }

  const workflowSource = o.workflow || config.workflow;
  const workflowLocator = normalizeWorkflowLocator(workflowSource, repo);
  const snapshot = loadAndValidateWorkflow(workflowSource, repo, "source");

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
    workflow_locator: workflowLocator,
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
