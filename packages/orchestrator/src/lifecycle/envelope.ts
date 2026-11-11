/**
 * Task Input Envelope protocol: construction, validation, and loading.
 * Pure protocol logic: does NOT inspect workspace-config.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTaskInputEnvelope,
  type TaskInputEnvelope,
} from "../protocol/index.js";
import type { EnvelopeCreateOptions } from "./types.js";

const candidateTemplate = fileURLToPath(
  new URL(
    "../../../../skills/pc-orchestrator/templates/subagent-receipt.template.md",
    import.meta.url,
  ),
);
const fallbackTemplate = fileURLToPath(
  new URL(
    "../../../skills/pc-orchestrator/templates/subagent-receipt.template.md",
    import.meta.url,
  ),
);
export const DEFAULT_RECEIPT_TEMPLATE = fs.existsSync(candidateTemplate)
  ? candidateTemplate
  : fallbackTemplate;

export class EnvelopeError extends Error {}
export class EnvelopeCorruptedError extends EnvelopeError {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeCorruptedError";
  }
}

// Validation lives in ../protocol; re-exported for existing lifecycle callers.
export {
  EnvelopeValidationError,
  isObject,
  validateTaskInputEnvelope as validateEnvelope,
  assertTaskInputEnvelope as assertValidEnvelope,
  type JsonObject,
} from "../protocol/index.js";

export function loadEnvelope(
  filename: string,
  validate?: true,
): TaskInputEnvelope;
export function loadEnvelope(filename: string, validate: false): unknown;
export function loadEnvelope(filename: string, validate = true): unknown {
  const absolute = path.resolve(filename);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Envelope file not found: ${absolute}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new EnvelopeCorruptedError(
      `Corrupted envelope JSON at ${absolute}: ${error}`,
    );
  }
  if (validate) assertTaskInputEnvelope(data);
  return data;
}

export function createEnvelope(
  options: EnvelopeCreateOptions,
): TaskInputEnvelope {
  if (
    "logical_stage" in (options as unknown as Record<string, unknown>) &&
    !("task" in options)
  ) {
    // Support legacy flat options
    const o = options as unknown as Record<string, unknown>;
    return createEnvelope({
      schema_version: (o.schema_version as string) ?? "1.0",
      task: {
        logical_stage: String(o.logical_stage),
        step_index: Number(o.step_index),
        attempt: Number(o.attempt ?? 1),
        root_issue_id: String(o.root_issue_id),
        current_issue_id: String(o.current_issue_id ?? o.root_issue_id),
      },
      provider: {
        type: (o.provider_type as string) ?? "skill",
        target: String(o.provider_target),
        args: Array.isArray(o.provider_args)
          ? (o.provider_args as string[])
          : [],
      },
      environment: {
        working_directory: String(o.working_directory || process.cwd()),
        repository: String(o.delivery_target || o.repository || "local/repo"),
        base_branch: String(o.base_branch || "main"),
        branch: (o.branch as string) ?? null,
        commit: (o.commit as string) ?? null,
      },
      inputs: {
        objective: String(o.objective),
        scope: String(o.scope || ""),
        acceptance_criteria: Array.isArray(o.acceptance_criteria)
          ? (o.acceptance_criteria as string[])
          : [],
        predecessor_receipts: Array.isArray(o.predecessor_receipts)
          ? (o.predecessor_receipts as string[])
          : [],
        parameters: (o.parameters as Record<string, unknown>) ?? {},
      },
      contract: {
        receipt_path: String(o.receipt_path),
        receipt_template:
          (o.receipt_template as string) || DEFAULT_RECEIPT_TEMPLATE,
      },
      budgets: {
        delivery_attempts_used: Number(o.delivery_attempts_used ?? 0),
        delivery_attempts_max: Number(o.delivery_attempts_max ?? 3),
        replans_used: Number(o.replans_used ?? 0),
        replans_max: Number(o.replans_max ?? 2),
      },
      validate: o.validate !== false,
    });
  }

  const workdir = options.environment.working_directory
    ? path.resolve(options.environment.working_directory)
    : "";
  const receipt = options.contract.receipt_path
    ? path.resolve(options.contract.receipt_path)
    : "";

  const envelope: TaskInputEnvelope = {
    schema_version: options.schema_version ?? "1.0",
    task: {
      logical_stage: String(options.task.logical_stage),
      step_index: Number(options.task.step_index),
      attempt: Number(options.task.attempt ?? 1),
      root_issue_id: String(options.task.root_issue_id),
      current_issue_id: String(
        options.task.current_issue_id ?? options.task.root_issue_id,
      ),
    },
    provider: {
      type: options.provider.type ?? "skill",
      target: String(options.provider.target),
      args: [...(options.provider.args ?? [])],
    },
    environment: {
      working_directory: workdir,
      repository: String(options.environment.repository),
      base_branch: String(options.environment.base_branch || "main"),
      branch: options.environment.branch ?? null,
      commit: options.environment.commit ?? null,
    },
    inputs: {
      objective: String(options.inputs.objective),
      scope: String(options.inputs.scope ?? ""),
      acceptance_criteria: [...(options.inputs.acceptance_criteria ?? [])],
      predecessor_receipts: [...(options.inputs.predecessor_receipts ?? [])],
      parameters: { ...(options.inputs.parameters ?? {}) },
    },
    contract: {
      receipt_path: receipt,
      receipt_template:
        options.contract.receipt_template || DEFAULT_RECEIPT_TEMPLATE,
    },
    budgets: {
      delivery_attempts_used: Number(
        options.budgets.delivery_attempts_used ?? 0,
      ),
      delivery_attempts_max: Number(
        options.budgets.delivery_attempts_max ?? 3,
      ),
      replans_used: Number(options.budgets.replans_used ?? 0),
      replans_max: Number(options.budgets.replans_max ?? 2),
    },
  };

  if (options.validate !== false) {
    assertTaskInputEnvelope(envelope);
  }

  return envelope;
}
