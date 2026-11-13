/**
 * Request parsing, validation, and comparison for Lifecycle operations.
 */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseReportInput } from "../protocol/index.js";
import type {
  CompactReport,
  NormalizedDispatchRequest,
  ResolveOptions,
} from "./types.js";

const DISPATCH_ALLOWED_FIELDS = [
  "request_id",
  "stage",
  "objective",
  "provider",
  "acceptance_criteria",
  "predecessor_receipts",
  "workdir",
  "scope",
  "attempt_intent",
  "branch",
  "commit",
  "receipt_template",
  "rework_issue",
  "parameters",
];

export function parseDispatchRequest(raw: unknown): NormalizedDispatchRequest {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`Invalid dispatch request JSON: ${String(error)}`, {
        cause: error,
      });
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Dispatch request must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;

  const unknown = Object.keys(record).filter(
    (k) => !DISPATCH_ALLOWED_FIELDS.includes(k),
  );
  if (unknown.length) {
    throw new Error(
      `Unknown dispatch request fields: ${unknown.sort().join(", ")}`,
    );
  }

  for (const key of ["request_id", "stage", "objective"]) {
    if (!(key in record)) {
      throw new Error(`Dispatch request missing required field '${key}'`);
    }
  }

  for (const key of ["request_id", "stage", "objective"] as const) {
    const val = record[key];
    if (typeof val !== "string" || !val.trim()) {
      throw new Error(
        `Request '${key}' must be a non-empty string, received ${JSON.stringify(val)}`,
      );
    }
  }

  for (const key of ["workdir", "receipt_template"] as const) {
    if (key in record && record[key] !== undefined && record[key] !== null) {
      const val = record[key];
      if (typeof val !== "string" || !val.trim()) {
        throw new Error(
          `Request '${key}' must be a non-empty string, received ${JSON.stringify(val)}`,
        );
      }
    }
  }

  if ("scope" in record && record.scope !== undefined) {
    if (record.scope === null || typeof record.scope !== "string") {
      throw new Error(
        `Request 'scope' must be a string, received ${JSON.stringify(record.scope)}`,
      );
    }
  }

  for (const key of ["branch", "commit"] as const) {
    if (key in record && record[key] !== undefined && record[key] !== null) {
      const val = record[key];
      if (typeof val !== "string" || !val.trim()) {
        throw new Error(
          `Request '${key}' must be a non-empty string, received ${JSON.stringify(val)}`,
        );
      }
    }
  }

  if ("parameters" in record && record.parameters !== undefined) {
    const params = record.parameters;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(
        `Request 'parameters' must be a JSON object, received ${params === null ? "null" : Array.isArray(params) ? "array" : typeof params}`,
      );
    }
  }

  if ("attempt_intent" in record && record.attempt_intent !== undefined) {
    const intent = record.attempt_intent;
    if (intent !== "same" && intent !== "new") {
      throw new Error("Request 'attempt_intent' must be 'same' or 'new'");
    }
  }

  if (
    "rework_issue" in record &&
    record.rework_issue !== undefined &&
    record.rework_issue !== null
  ) {
    const rework = record.rework_issue;
    const t = typeof rework;
    if (
      (t !== "string" && t !== "number") ||
      (t === "number" && !Number.isInteger(rework))
    ) {
      throw new Error(
        "Request 'rework_issue' must be a non-empty string or integer",
      );
    }
    if (typeof rework === "string" && !rework.trim()) {
      throw new Error(
        "Request 'rework_issue' must be a non-empty string or integer",
      );
    }
  }

  let parsedProvider:
    { type: "skill"; target: string; args: string[] } | undefined = undefined;
  if (record.provider != null) {
    const p = record.provider;
    if (typeof p !== "object" || Array.isArray(p)) {
      throw new Error("Request 'provider' must be an object");
    }
    const unknownP = Object.keys(p as Record<string, unknown>).filter(
      (k) => !["type", "target", "args"].includes(k),
    );
    if (unknownP.length) {
      throw new Error(`Unknown provider fields: ${unknownP.sort().join(", ")}`);
    }
    const pRec = p as Record<string, unknown>;
    if (pRec.type !== "skill") {
      throw new Error("Provider 'type' must be 'skill'");
    }
    if (typeof pRec.target !== "string" || !pRec.target.trim()) {
      throw new Error("Provider 'target' must be a non-empty string");
    }
    if (pRec.args !== undefined) {
      if (
        !Array.isArray(pRec.args) ||
        pRec.args.some((a) => typeof a !== "string")
      ) {
        throw new Error("Request 'provider.args' must be an array of strings");
      }
    }
    parsedProvider = {
      type: "skill",
      target: pRec.target.trim(),
      args: Array.isArray(pRec.args) ? [...pRec.args] : [],
    };
  }

  if (
    "acceptance_criteria" in record &&
    record.acceptance_criteria !== undefined
  ) {
    const ac = record.acceptance_criteria;
    if (!Array.isArray(ac) || ac.some((v) => typeof v !== "string")) {
      throw new Error(
        "Request 'acceptance_criteria' must be an array of strings",
      );
    }
  }

  if (
    "predecessor_receipts" in record &&
    record.predecessor_receipts !== undefined
  ) {
    const pr = record.predecessor_receipts;
    if (!Array.isArray(pr) || pr.some((v) => typeof v !== "string")) {
      throw new Error(
        "Request 'predecessor_receipts' must be an array of strings",
      );
    }
  }

  // Match the JSON round trip used by the run store for object callers as well.
  const parameters: Record<string, unknown> = record.parameters
    ? JSON.parse(
        JSON.stringify({ ...(record.parameters as Record<string, unknown>) }),
      )
    : {};
  const workdir = (record.workdir as string | null | undefined)?.trim();
  const receiptTemplate = (
    record.receipt_template as string | null | undefined
  )?.trim();
  // An explicit null overrides context, while an omitted field inherits it.
  const branch =
    record.branch === null
      ? null
      : (record.branch as string | undefined)?.trim();
  const commit =
    record.commit === null
      ? null
      : (record.commit as string | undefined)?.trim();

  return {
    request_id: (record.request_id as string).trim(),
    stage: (record.stage as string).trim(),
    objective: (record.objective as string).trim(),
    ...(parsedProvider ? { provider: parsedProvider } : {}),
    acceptance_criteria: [
      ...((record.acceptance_criteria as string[] | undefined) ?? []),
    ],
    predecessor_receipts: [
      ...((record.predecessor_receipts as string[] | undefined) ?? []),
    ],
    ...(workdir !== undefined ? { workdir } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(commit !== undefined ? { commit } : {}),
    ...(record.scope !== undefined ? { scope: record.scope as string } : {}),
    parameters,
    ...(receiptTemplate !== undefined
      ? { receipt_template: receiptTemplate }
      : {}),
    attempt_intent: (record.attempt_intent as "same" | "new") ?? "same",
    rework_issue:
      record.rework_issue != null ? String(record.rework_issue).trim() : null,
  };
}

/**
 * Historical request normalization for comparing replay requests with records
 * created by older code (request_identity_version undefined or 1).
 * Preserves legacy omission-to-empty-string and flat provider fields.
 */
export function parseHistoricalDispatchRequest(
  raw: unknown,
): NormalizedDispatchRequest {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`Invalid dispatch request JSON: ${String(error)}`, {
        cause: error,
      });
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Dispatch request must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;

  for (const key of ["request_id", "stage", "objective"]) {
    if (!(key in record)) {
      throw new Error(`Dispatch request missing required field '${key}'`);
    }
  }

  for (const key of ["request_id", "stage", "objective"] as const) {
    const val = record[key];
    if (typeof val !== "string" || !val.trim()) {
      throw new Error(
        `Request '${key}' must be a non-empty string, received ${JSON.stringify(val)}`,
      );
    }
  }

  let parsedProvider:
    | { type: "skill"; target: string; args: string[] }
    | undefined = undefined;

  const providerTarget =
    (record.provider as { target?: string } | undefined)?.target ??
    (record.provider_target as string | undefined);

  if (record.provider != null) {
    const p = record.provider as Record<string, unknown>;
    parsedProvider = {
      type: "skill",
      target: String(p.target ?? "").trim(),
      args: Array.isArray(p.args) ? (p.args as string[]) : [],
    };
  } else if (providerTarget) {
    parsedProvider = {
      type: (record.provider_type as "skill") ?? "skill",
      target: String(providerTarget).trim(),
      args: Array.isArray(record.provider_args)
        ? (record.provider_args as string[])
        : [],
    };
  }

  const parameters: Record<string, unknown> = record.parameters
    ? JSON.parse(
        JSON.stringify({ ...(record.parameters as Record<string, unknown>) }),
      )
    : {};
  const workdir = (record.workdir as string | null | undefined)?.trim();
  const receiptTemplate = (
    record.receipt_template as string | null | undefined
  )?.trim();
  const branch =
    record.branch === null
      ? null
      : (record.branch as string | undefined)?.trim();
  const commit =
    record.commit === null
      ? null
      : (record.commit as string | undefined)?.trim();

  return {
    request_id: (record.request_id as string).trim(),
    stage: (record.stage as string).trim(),
    objective: (record.objective as string).trim(),
    ...(parsedProvider ? { provider: parsedProvider } : {}),
    acceptance_criteria: [
      ...((record.acceptance_criteria as string[] | undefined) ?? []),
    ],
    predecessor_receipts: [
      ...((record.predecessor_receipts as string[] | undefined) ?? []),
    ],
    ...(workdir !== undefined ? { workdir } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(commit !== undefined ? { commit } : {}),
    scope: (record.scope as string | null | undefined) ?? "",
    parameters,
    ...(receiptTemplate !== undefined
      ? { receipt_template: receiptTemplate }
      : {}),
    attempt_intent: (record.attempt_intent as "same" | "new") ?? "same",
    rework_issue:
      record.rework_issue != null ? String(record.rework_issue).trim() : null,
  };
}

export const parseCompleteReport = parseReportInput;

export function compareCompleteReports(
  a: CompactReport,
  b: CompactReport,
): boolean {
  if (a.execution_status !== b.execution_status) return false;
  if (!isDeepStrictEqual(a.result, b.result)) return false;
  if (!a.receipt_path || !b.receipt_path) return false;
  if (path.resolve(a.receipt_path) !== path.resolve(b.receipt_path)) {
    return false;
  }
  if (a.summary !== b.summary) return false;
  return true;
}

const DEPRECATED_RESOLVE_KEYS = [
  "plan",
  "child_issues",
  "child_issue",
  "child-issues",
  "child-issue",
] as const;

const FORBIDDEN_PLAN_ACCEPTANCE_KEYS = [
  "current_issue",
  "current-issue",
  "mark_landed",
  "mark-landed",
  "landing_dispatch_id",
  "landing-dispatch-id",
  "complete_sequence",
  "complete-sequence",
  "options",
  "option",
  "plan",
  "child_issues",
  "child_issue",
  "child-issues",
  "child-issue",
] as const;

const RESOLVE_ALLOWED_FIELDS = [
  "receipt_root",
  "decision",
  "reason",
  "options",
  "next_stage",
  "plan_dispatch_id",
  "plan-dispatch-id",
  "current_issue",
  "current-issue",
  "mark_landed",
  "mark-landed",
  "landing_dispatch_id",
  "landing-dispatch-id",
  "complete_sequence",
  "complete-sequence",
];

export function parseResolveOptions(
  raw: Record<string, unknown>,
): ResolveOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Resolve options must be a JSON object");
  }

  for (const key of DEPRECATED_RESOLVE_KEYS) {
    if (key in raw && raw[key] !== undefined) {
      throw new Error(
        `Resolve option '${key}' has been removed and is no longer supported.`,
      );
    }
  }

  const unknown = Object.keys(raw).filter(
    (k) => !RESOLVE_ALLOWED_FIELDS.includes(k),
  );
  if (unknown.length) {
    throw new Error(
      `Unknown resolve option '${unknown[0]}'.`,
    );
  }

  const decision = raw.decision;
  if (
    decision !== "wait_user" &&
    decision !== "continue" &&
    decision !== "halt" &&
    decision !== "finish"
  ) {
    throw new Error(
      `Invalid decision '${decision}'. Must strictly be one of 'wait_user' | 'continue' | 'halt' | 'finish'.`,
    );
  }

  const reason = raw.reason;
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("Field 'reason' must be a non-empty string.");
  }

  if ("options" in raw && raw.options !== undefined) {
    if (
      !Array.isArray(raw.options) ||
      raw.options.some((opt) => typeof opt !== "string")
    ) {
      throw new Error("Field 'options' must be an array of strings.");
    }
  }

  const completeSequence = raw.complete_sequence ?? raw["complete-sequence"];
  if (completeSequence !== undefined) {
    if (typeof completeSequence !== "boolean") {
      throw new Error("Field 'complete_sequence' must be a boolean.");
    }
  }

  let planDispatchId: string | undefined = undefined;
  const rawPlanId = raw.plan_dispatch_id ?? raw["plan-dispatch-id"];
  if (rawPlanId !== undefined) {
    if (typeof rawPlanId !== "string" || !rawPlanId.trim()) {
      throw new Error("Field 'plan_dispatch_id' must be a non-empty string.");
    }
    planDispatchId = rawPlanId.trim();
  }

  if (planDispatchId) {
    if (decision !== "continue") {
      throw new Error(
        `Decision must be 'continue' when accepting a plan, got '${decision}'.`,
      );
    }

    if (
      raw.next_stage === undefined ||
      raw.next_stage === null ||
      typeof raw.next_stage !== "string" ||
      !raw.next_stage.trim()
    ) {
      throw new Error("Field 'next_stage' is required when accepting a plan.");
    }

    for (const key of FORBIDDEN_PLAN_ACCEPTANCE_KEYS) {
      if (key in raw && raw[key] !== undefined) {
        throw new Error(
          `Field '${key}' cannot be combined with 'plan_dispatch_id'.`,
        );
      }
    }
  } else if (raw.next_stage !== undefined && raw.next_stage !== null) {
    if (typeof raw.next_stage !== "string" || !raw.next_stage.trim()) {
      throw new Error(
        "Field 'next_stage' must be a non-empty string if provided.",
      );
    }
  }

  const markLanded = raw.mark_landed ?? raw["mark-landed"];
  const landingDispatchId =
    raw.landing_dispatch_id ?? raw["landing-dispatch-id"];
  const hasMarkLanded =
    markLanded != null && String(markLanded).trim() !== "";
  const hasLandingDispatchId =
    landingDispatchId != null && String(landingDispatchId).trim() !== "";
  if (hasMarkLanded !== hasLandingDispatchId) {
    throw new Error(
      "mark_landed and landing_dispatch_id must be provided together.",
    );
  }

  const currentIssue = raw.current_issue ?? raw["current-issue"];

  return {
    receipt_root:
      typeof raw.receipt_root === "string" ? raw.receipt_root.trim() : "",
    decision,
    reason: reason.trim(),
    ...(raw.next_stage
      ? { next_stage: (raw.next_stage as string).trim() }
      : {}),
    ...(planDispatchId ? { plan_dispatch_id: planDispatchId } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options as string[] } : {}),
    ...(currentIssue != null
      ? { current_issue: currentIssue as string | number }
      : {}),
    ...(markLanded != null
      ? { mark_landed: markLanded as string | number }
      : {}),
    ...(landingDispatchId != null
      ? { landing_dispatch_id: String(landingDispatchId).trim() }
      : {}),
    ...(typeof completeSequence === "boolean"
      ? { complete_sequence: completeSequence }
      : {}),
  };
}
