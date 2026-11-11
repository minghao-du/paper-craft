/**
 * CompactReport protocol: type, structural validation, and transport parsing.
 * Pure; the specialist `result` payload is only required to be an object.
 */
import { isObject, ProtocolError } from "./errors.js";

export type ExecutionStatus = "succeeded" | "failed" | "blocked";

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "succeeded",
  "failed",
  "blocked",
];

export interface CompactReport {
  execution_status: ExecutionStatus;
  result: Record<string, unknown>;
  receipt_path: string;
  summary: string;
  dispatch_id?: string;
}

/** Validate and normalize (trim strings, drop unknown keys) a parsed report. */
export function normalizeCompactReport(raw: unknown): CompactReport {
  if (!isObject(raw)) {
    throw new ProtocolError(
      "Report must be a JSON object dictionary or JSON string.",
      { code: "REPORT_NOT_OBJECT" },
    );
  }
  for (const key of ["execution_status", "result", "receipt_path", "summary"]) {
    if (!(key in raw)) {
      throw new ProtocolError(
        `Compact execution report missing required field: '${key}'`,
        { code: "REPORT_MISSING_FIELD", field: key },
      );
    }
  }

  const status = raw.execution_status;
  if (!EXECUTION_STATUSES.includes(status as ExecutionStatus)) {
    throw new ProtocolError(
      `Invalid execution_status '${String(status)}'. Expected 'succeeded' | 'failed' | 'blocked'.`,
      { code: "REPORT_INVALID_STATUS", field: "execution_status" },
    );
  }
  if (!isObject(raw.result)) {
    throw new ProtocolError(
      `Field 'result' must be a JSON object (dict), got ${raw.result === null ? "NoneType" : Array.isArray(raw.result) ? "array" : typeof raw.result}.`,
      { code: "REPORT_INVALID_FIELD", field: "result" },
    );
  }
  const { receipt_path, summary, dispatch_id } = raw;
  if (typeof receipt_path !== "string" || !receipt_path.trim()) {
    throw new ProtocolError("Field 'receipt_path' must be a non-empty string.", {
      code: "REPORT_INVALID_FIELD",
      field: "receipt_path",
    });
  }
  if (typeof summary !== "string" || !summary.trim()) {
    throw new ProtocolError("Field 'summary' must be a non-empty string.", {
      code: "REPORT_INVALID_FIELD",
      field: "summary",
    });
  }
  if (
    dispatch_id !== undefined &&
    dispatch_id !== null &&
    (typeof dispatch_id !== "string" || !dispatch_id.trim())
  ) {
    throw new ProtocolError(
      "Field 'dispatch_id' must be a non-empty string if provided.",
      { code: "REPORT_INVALID_FIELD", field: "dispatch_id" },
    );
  }

  return {
    execution_status: status as ExecutionStatus,
    result: raw.result,
    receipt_path: receipt_path.trim(),
    summary: summary.trim(),
    ...(dispatch_id ? { dispatch_id: (dispatch_id as string).trim() } : {}),
  };
}

/**
 * Parse a report from transport form: a JSON string (CLI argument or file
 * contents) or an already-parsed value, then validate it.
 */
export function parseReportInput(raw: string | unknown): CompactReport {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new ProtocolError(`Invalid compact report JSON: ${String(error)}`, {
        code: "REPORT_INVALID_JSON",
      });
    }
  }
  return normalizeCompactReport(value);
}
