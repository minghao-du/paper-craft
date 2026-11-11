/** Structured task inputs and their durable JSON storage. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceConfig } from "../../workspace-config/src/config.js";

export type JsonObject = Record<string, unknown>;
export const DEFAULT_RECEIPT_TEMPLATE = fileURLToPath(
  new URL(
    "../../../skills/pc-orchestrator/templates/subagent-receipt.template.md",
    import.meta.url,
  ),
);
export class EnvelopeError extends Error {}
export class EnvelopeValidationError extends EnvelopeError {
  constructor(public errors: string[]) {
    super(`Invalid TaskInputEnvelope:\n  - ${errors.join("\n  - ")}`);
  }
}
export class EnvelopeCorruptedError extends EnvelopeError {}
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}`;
  try {
    const descriptor = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(descriptor, JSON.stringify(data, null, 2) + "\n");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function validateEnvelope(data: unknown): string[] {
  if (!isObject(data)) return ["Root envelope must be a JSON object (dict)"];
  const object = data;
  const errors: string[] = [];
  const sections = [
    "schema_version",
    "task",
    "provider",
    "environment",
    "inputs",
    "contract",
    "budgets",
  ];
  for (const key of sections)
    if (!(key in data)) errors.push(`Missing required top-level key: '${key}'`);
  if ("schema_version" in data && data.schema_version !== "1.0")
    errors.push(
      `[schema_version] Unsupported schema_version '${data.schema_version}'. Expected '1.0'`,
    );
  function section(name: string, inspect: (value: JsonObject) => void) {
    const value = object[name];
    if (!(name in object)) return;
    if (!isObject(value)) errors.push(`[${name}] Expected JSON object (dict)`);
    else inspect(value);
  }
  function text(object: JsonObject, field: string, location: string) {
    const value = object[field];
    if (typeof value !== "string" || !value.trim())
      errors.push(`[${location}.${field}] Expected non-empty string`);
  }
  function integer(
    object: JsonObject,
    field: string,
    location: string,
    minimum: number,
    required = false,
  ) {
    if (!(field in object)) {
      if (required)
        errors.push(`[${location}.${field}] Expected integer >= ${minimum}`);
      return;
    }
    const value = object[field];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < minimum
    )
      errors.push(
        `[${location}.${field}] Expected integer >= ${minimum}, got ${object[field]}`,
      );
  }
  section("task", (task) => {
    for (const field of ["logical_stage", "root_issue_id", "current_issue_id"])
      text(task, field, "task");
    integer(task, "step_index", "task", 0, true);
    integer(task, "attempt", "task", 1, true);
  });
  section("provider", (provider) => {
    if (provider.type !== "skill")
      errors.push(`[provider.type] Expected 'skill', got '${provider.type}'`);
    text(provider, "target", "provider");
    if ("args" in provider && !Array.isArray(provider.args))
      errors.push("[provider.args] Expected list of strings");
  });
  section("environment", (env) =>
    text(env, "working_directory", "environment"),
  );
  section("inputs", (inputs) => {
    text(inputs, "objective", "inputs");
    if ("scope" in inputs && typeof inputs.scope !== "string")
      errors.push("[inputs.scope] Expected string");
    for (const field of ["acceptance_criteria", "predecessor_receipts"])
      if (field in inputs && !Array.isArray(inputs[field]))
        errors.push(`[inputs.${field}] Expected list`);
  });
  section("contract", (contract) => text(contract, "receipt_path", "contract"));
  section("budgets", (budgets) => {
    for (const field of ["delivery_attempts_used", "replans_used"])
      integer(budgets, field, "budgets", 0);
    for (const field of ["delivery_attempts_max", "replans_max"])
      integer(budgets, field, "budgets", 1);
  });
  return errors;
}
export function assertValidEnvelope(
  data: unknown,
): asserts data is TaskInputEnvelope {
  const errors = validateEnvelope(data);
  if (errors.length) throw new EnvelopeValidationError(errors);
}
export function loadWorkspaceConfigFromDir(workdir: string): JsonObject | null {
  const filename = path.join(workdir, ".paper-craft", "workspace-config.json");
  if (!fs.existsSync(filename)) return null;
  try {
    const config: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!isObject(config)) throw new Error("must be a JSON object");
    return config;
  } catch (error) {
    throw new EnvelopeCorruptedError(
      `Malformed workspace configuration at ${filename}: ${error}. Please run 'pc-workspace-config' to reconfigure.`,
    );
  }
}
export interface TaskInputEnvelope extends JsonObject {
  schema_version: string;
  task: {
    logical_stage: string;
    step_index: number;
    attempt: number;
    root_issue_id: string;
    current_issue_id: string;
  };
  provider: { type: string; target: string; args: string[] };
  environment: {
    working_directory: string;
    repository: string;
    base_branch: string;
    branch: string | null;
    commit: string | null;
  };
  inputs: {
    objective: string;
    scope: string;
    acceptance_criteria: string[];
    predecessor_receipts: string[];
    parameters: JsonObject;
  };
  contract: { receipt_path: string; receipt_template: string };
  budgets: {
    delivery_attempts_used: number;
    delivery_attempts_max: number;
    replans_used: number;
    replans_max: number;
  };
}
export interface EnvelopeOptions {
  logical_stage: string;
  step_index: number;
  root_issue_id: string | number;
  provider_target: string;
  working_directory: string;
  objective: string;
  receipt_path: string;
  current_issue_id?: string | number | null;
  attempt?: number;
  provider_type?: string;
  provider_args?: string[] | null;
  repository?: string;
  delivery_target?: string | null;
  base_remote?: string | null;
  push_remote?: string | null;
  base_branch?: string | null;
  branch?: string | null;
  commit?: string | null;
  scope?: string;
  acceptance_criteria?: string[] | null;
  predecessor_receipts?: string[] | null;
  parameters?: JsonObject | null;
  worktree_container?: string | null;
  receipt_template?: string;
  delivery_attempts_used?: number;
  delivery_attempts_max?: number;
  replans_used?: number;
  replans_max?: number;
  schema_version?: string;
  validate?: boolean;
  config_snapshot?: JsonObject | null;
}
export function createEnvelope(options: EnvelopeOptions): TaskInputEnvelope {
  const o = options;
  const workdir = o.working_directory ? path.resolve(o.working_directory) : "";
  const receipt = o.receipt_path ? path.resolve(o.receipt_path) : "";
  let config =
    o.config_snapshot && Object.keys(o.config_snapshot).length
      ? o.config_snapshot
      : null;
  if (
    !config &&
    workdir &&
    fs.existsSync(path.join(workdir, ".paper-craft", "workspace-config.json"))
  ) {
    try {
      config = { ...resolveWorkspaceConfig(workdir) };
    } catch (error) {
      throw new EnvelopeCorruptedError(String(error));
    }
  }
  const configuredText = (key: string): string | undefined => {
    const value = config?.[key];
    return typeof value === "string" && value ? value : undefined;
  };
  const repository = o.repository ?? "local/repo";
  const target =
    o.delivery_target ||
    (repository !== "local/repo" ? repository : null) ||
    configuredText("delivery_target") ||
    "local/repo";
  const params: JsonObject = { ...(o.parameters ?? {}) };
  if (!("delivery_target" in params) && target !== "local/repo")
    params.delivery_target = target;
  if (!("base_remote" in params))
    params.base_remote =
      o.base_remote || configuredText("base_remote") || "origin";
  if (!("push_remote" in params))
    params.push_remote =
      o.push_remote || configuredText("push_remote") || "origin";
  const container =
    o.worktree_container || configuredText("worktree_container");
  if (!("worktree_container" in params) && container)
    params.worktree_container = container;
  const envelope: TaskInputEnvelope = {
    schema_version: o.schema_version ?? "1.0",
    task: {
      logical_stage: String(o.logical_stage),
      step_index: Number(o.step_index),
      attempt: Number(o.attempt ?? 1),
      root_issue_id: String(o.root_issue_id),
      current_issue_id: String(o.current_issue_id ?? o.root_issue_id),
    },
    provider: {
      type: o.provider_type ?? "skill",
      target: String(o.provider_target),
      args: [...(o.provider_args ?? [])],
    },
    environment: {
      working_directory: workdir,
      repository: target,
      base_branch: o.base_branch ?? (configuredText("base_branch") || "main"),
      branch: o.branch ?? null,
      commit: o.commit ?? null,
    },
    inputs: {
      objective: String(o.objective),
      scope: String(o.scope || ""),
      acceptance_criteria: [...(o.acceptance_criteria ?? [])],
      predecessor_receipts: [...(o.predecessor_receipts ?? [])],
      parameters: params,
    },
    contract: {
      receipt_path: receipt,
      receipt_template: o.receipt_template || DEFAULT_RECEIPT_TEMPLATE,
    },
    budgets: {
      delivery_attempts_used: Number(o.delivery_attempts_used ?? 0),
      delivery_attempts_max: Number(o.delivery_attempts_max ?? 3),
      replans_used: Number(o.replans_used ?? 0),
      replans_max: Number(o.replans_max ?? 2),
    },
  };
  if (o.validate !== false) assertValidEnvelope(envelope);
  return envelope;
}
export function saveEnvelope(
  envelope: JsonObject,
  target: string,
  validate = true,
): string {
  if (validate) assertValidEnvelope(envelope);
  const filename = path.resolve(target);
  atomicWriteJson(filename, envelope);
  return filename;
}
export function loadEnvelope(
  filename: string,
  validate?: true,
): TaskInputEnvelope;
export function loadEnvelope(filename: string, validate: false): unknown;
export function loadEnvelope(filename: string, validate = true): unknown {
  filename = path.resolve(filename);
  if (!fs.existsSync(filename))
    throw new Error(`Envelope file not found: ${filename}`);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new EnvelopeCorruptedError(
      `Malformed JSON in envelope ${filename}: ${error}`,
    );
  }
  if (validate) assertValidEnvelope(data);
  return data;
}
