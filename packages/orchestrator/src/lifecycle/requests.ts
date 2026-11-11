/**
 * Request parsing, validation, and comparison for Lifecycle operations.
 */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseReportInput } from "../protocol/index.js";
import type {
  CompactReport,
  NormalizedPrepareRequest,
  ResolveOptions,
} from "./types.js";

const PREPARE_ALLOWED_FIELDS = [
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

export function parsePrepareRequest(raw: unknown): NormalizedPrepareRequest {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`Invalid prepare request JSON: ${String(error)}`, {
        cause: error,
      });
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Prepare request must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;

  const unknown = Object.keys(record).filter(
    (k) => !PREPARE_ALLOWED_FIELDS.includes(k),
  );
  if (unknown.length) {
    throw new Error(
      `Unknown prepare request fields: ${unknown.sort().join(", ")}`,
    );
  }

  for (const key of ["stage", "objective"]) {
    if (!(key in record)) {
      throw new Error(`Prepare request missing required field '${key}'`);
    }
  }

  for (const key of ["stage", "objective"] as const) {
    const val = record[key];
    if (typeof val !== "string" || !val.trim()) {
      throw new Error(
        `Request '${key}' must be a non-empty string, received ${JSON.stringify(val)}`,
      );
    }
  }

  for (const key of [
    "workdir",
    "scope",
    "branch",
    "commit",
    "receipt_template",
  ] as const) {
    if (key in record && record[key] !== undefined && record[key] !== null) {
      const val = record[key];
      if (typeof val !== "string" || (key !== "scope" && !val.trim())) {
        throw new Error(
          `Request '${key}' must be ${key === "scope" ? "a string" : "a non-empty string"}, received ${JSON.stringify(val)}`,
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
    | { type: "skill"; target: string; args: string[] }
    | undefined = undefined;
  if (record.provider != null) {
    const p = record.provider;
    if (typeof p !== "object" || Array.isArray(p)) {
      throw new Error("Request 'provider' must be an object");
    }
    const unknownP = Object.keys(p as Record<string, unknown>).filter(
      (k) => !["type", "target", "args"].includes(k),
    );
    if (unknownP.length) {
      throw new Error(
        `Unknown provider fields: ${unknownP.sort().join(", ")}`,
      );
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

  const stage = (record.stage as string).trim();
  const objective = (record.objective as string).trim();
  const workdir = record.workdir
    ? path.resolve((record.workdir as string).trim())
    : "";
  const scope = record.scope != null ? String(record.scope) : "";
  const branch =
    record.branch != null ? String(record.branch).trim() : null;
  const commit =
    record.commit != null ? String(record.commit).trim() : null;
  const receiptTemplate =
    record.receipt_template != null
      ? String(record.receipt_template).trim()
      : undefined;
  const attemptIntent =
    (record.attempt_intent as "same" | "new") ?? "same";
  const reworkIssue =
    record.rework_issue != null ? String(record.rework_issue).trim() : null;
  const criteria = Array.isArray(record.acceptance_criteria)
    ? [...record.acceptance_criteria]
    : [];
  const predecessors = Array.isArray(record.predecessor_receipts)
    ? [...record.predecessor_receipts]
    : [];
  const parameters = record.parameters
    ? { ...(record.parameters as Record<string, unknown>) }
    : {};

  return {
    stage,
    objective,
    provider: parsedProvider,
    acceptance_criteria: criteria,
    predecessor_receipts: predecessors,
    working_directory: workdir,
    branch,
    commit,
    scope,
    parameters,
    receipt_template: receiptTemplate,
    attempt_intent: attemptIntent,
    rework_issue: reworkIssue,
    predecessors,
    logical_stage: stage,
  };
}

export function compareNormalizedRequests(
  a: NormalizedPrepareRequest,
  b: NormalizedPrepareRequest,
): boolean {
  const aStage = a.stage ?? a.logical_stage ?? "";
  const bStage = b.stage ?? b.logical_stage ?? "";
  if (aStage !== bStage) return false;

  if (a.objective !== b.objective) return false;

  if (!isDeepStrictEqual(a.provider ?? null, b.provider ?? null)) return false;

  const aCriteria = a.acceptance_criteria ?? [];
  const bCriteria = b.acceptance_criteria ?? [];
  if (!isDeepStrictEqual(aCriteria, bCriteria)) return false;

  const aReceipts = a.predecessor_receipts ?? a.predecessors ?? [];
  const bReceipts = b.predecessor_receipts ?? b.predecessors ?? [];
  if (!isDeepStrictEqual(aReceipts, bReceipts)) return false;

  if ((a.working_directory ?? "") !== (b.working_directory ?? "")) return false;

  if ((a.branch ?? null) !== (b.branch ?? null)) return false;

  if ((a.commit ?? null) !== (b.commit ?? null)) return false;

  if ((a.scope ?? "") !== (b.scope ?? "")) return false;

  if (!isDeepStrictEqual(a.parameters ?? {}, b.parameters ?? {})) return false;

  if ((a.receipt_template ?? null) !== (b.receipt_template ?? null)) return false;

  if ((a.attempt_intent ?? "same") !== (b.attempt_intent ?? "same")) return false;

  const aRework = a.rework_issue == null ? null : String(a.rework_issue).trim();
  const bRework = b.rework_issue == null ? null : String(b.rework_issue).trim();
  if (aRework !== bRework) return false;

  return true;
}

export const parseCompleteReport = parseReportInput;

export function compareCompleteReports(
  a: CompactReport,
  b: CompactReport,
): boolean {
  if (a.execution_status !== b.execution_status) return false;
  if (!isDeepStrictEqual(a.result, b.result)) return false;
  if (a.summary !== b.summary) return false;
  return true;
}

export function parseResolveOptions(
  raw: Record<string, unknown>,
): ResolveOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Resolve options must be a JSON object");
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

  if (raw.next_stage !== undefined && raw.next_stage !== null) {
    if (typeof raw.next_stage !== "string" || !raw.next_stage.trim()) {
      throw new Error(
        "Field 'next_stage' must be a non-empty string if provided.",
      );
    }
  }

  return {
    receipt_root: typeof raw.receipt_root === "string" ? raw.receipt_root.trim() : "",
    decision,
    reason: reason.trim(),
    ...(raw.next_stage ? { next_stage: (raw.next_stage as string).trim() } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options as string[] } : {}),
    ...(raw.child_issues ? { child_issues: raw.child_issues as string[] } : {}),
    ...(raw.plan ? { plan: raw.plan } : {}),
    ...(raw.current_issue != null
      ? { current_issue: raw.current_issue as string | number }
      : {}),
    ...(raw.mark_landed != null
      ? { mark_landed: raw.mark_landed as string | number }
      : {}),
    ...(raw.landing_dispatch_id != null
      ? { landing_dispatch_id: String(raw.landing_dispatch_id).trim() }
      : {}),
    ...(typeof raw.complete_sequence === "boolean"
      ? { complete_sequence: raw.complete_sequence }
      : {}),
  };
}
