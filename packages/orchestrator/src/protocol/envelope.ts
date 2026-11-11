/**
 * TaskInputEnvelope protocol: type and pure structural validation.
 * Hand-written, accepts unknown; no file IO, defaults, or lifecycle knowledge.
 */
import { isObject, ProtocolError, type JsonObject } from "./errors.js";

export interface TaskInputEnvelope {
  schema_version: string;
  task: {
    logical_stage: string;
    step_index: number;
    attempt: number;
    root_issue_id: string;
    current_issue_id: string;
  };
  provider: {
    type: string;
    target: string;
    args?: string[];
  };
  environment: {
    working_directory: string;
    repository?: string;
    delivery_target?: string;
    base_remote?: string;
    push_remote?: string;
    base_branch?: string;
    branch?: string | null;
    commit?: string | null;
  };
  inputs: {
    objective: string;
    scope?: string;
    acceptance_criteria?: string[];
    predecessor_receipts?: string[];
    parameters?: Record<string, unknown>;
  };
  contract: {
    receipt_path: string;
    receipt_template?: string;
  };
  budgets: {
    delivery_attempts_used?: number;
    delivery_attempts_max?: number;
    replans_used?: number;
    replans_max?: number;
  };
  [key: string]: unknown;
}

export class EnvelopeValidationError extends ProtocolError {
  constructor(public errors: string[]) {
    super(`Invalid TaskInputEnvelope:\n  - ${errors.join("\n  - ")}`, {
      code: "ENVELOPE_INVALID",
    });
    this.name = "EnvelopeValidationError";
  }
}

export function validateTaskInputEnvelope(data: unknown): string[] {
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
  for (const key of sections) {
    if (!(key in data)) errors.push(`Missing required top-level key: '${key}'`);
  }
  if ("schema_version" in data && data.schema_version !== "1.0") {
    errors.push(
      `[schema_version] Unsupported schema_version '${data.schema_version}'. Expected '1.0'`,
    );
  }

  function section(name: string, inspect: (value: JsonObject) => void) {
    const value = object[name];
    if (!(name in object)) return;
    if (!isObject(value)) errors.push(`[${name}] Expected JSON object (dict)`);
    else inspect(value);
  }

  function text(obj: JsonObject, field: string, location: string) {
    const value = obj[field];
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`[${location}.${field}] Expected non-empty string`);
    }
  }

  function integer(
    obj: JsonObject,
    field: string,
    location: string,
    minimum: number,
    required = false,
  ) {
    if (!(field in obj)) {
      if (required) {
        errors.push(`[${location}.${field}] Expected integer >= ${minimum}`);
      }
      return;
    }
    const value = obj[field];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < minimum
    ) {
      errors.push(
        `[${location}.${field}] Expected integer >= ${minimum}, got ${obj[field]}`,
      );
    }
  }

  section("task", (task) => {
    for (const field of ["logical_stage", "root_issue_id", "current_issue_id"]) {
      text(task, field, "task");
    }
    integer(task, "step_index", "task", 0, true);
    integer(task, "attempt", "task", 1, true);
  });

  section("provider", (provider) => {
    if (provider.type !== "skill") {
      errors.push(`[provider.type] Expected 'skill', got '${provider.type}'`);
    }
    text(provider, "target", "provider");
    if (
      "args" in provider &&
      (!Array.isArray(provider.args) ||
        provider.args.some((a) => typeof a !== "string"))
    ) {
      errors.push("[provider.args] Expected list of strings");
    }
  });

  section("environment", (env) => {
    text(env, "working_directory", "environment");
  });

  section("inputs", (inputs) => {
    text(inputs, "objective", "inputs");
    if ("scope" in inputs && typeof inputs.scope !== "string") {
      errors.push("[inputs.scope] Expected string");
    }
    for (const field of ["acceptance_criteria", "predecessor_receipts"]) {
      if (field in inputs && !Array.isArray(inputs[field])) {
        errors.push(`[inputs.${field}] Expected list`);
      }
    }
    if ("parameters" in inputs && !isObject(inputs.parameters)) {
      errors.push("[inputs.parameters] Expected JSON object (dict)");
    }
  });

  section("contract", (contract) => {
    text(contract, "receipt_path", "contract");
  });

  section("budgets", (budgets) => {
    for (const field of ["delivery_attempts_used", "replans_used"]) {
      integer(budgets, field, "budgets", 0);
    }
    for (const field of ["delivery_attempts_max", "replans_max"]) {
      integer(budgets, field, "budgets", 1);
    }
  });

  return errors;
}

export function assertTaskInputEnvelope(
  data: unknown,
): asserts data is TaskInputEnvelope {
  const errors = validateTaskInputEnvelope(data);
  if (errors.length) throw new EnvelopeValidationError(errors);
}

/** Validate an envelope given as parsed value or JSON string. */
export function parseTaskInputEnvelope(raw: string | unknown): TaskInputEnvelope {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new ProtocolError(`Invalid envelope JSON: ${String(error)}`, {
        code: "ENVELOPE_INVALID_JSON",
      });
    }
  }
  assertTaskInputEnvelope(value);
  return value;
}
