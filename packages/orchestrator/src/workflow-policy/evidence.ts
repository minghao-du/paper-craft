import type {
  CompletionRecordView,
  WorkflowDefinition,
} from "./types.js";
import {
  invalidatesLanding,
  isLandingStage,
  resolveCanonicalStage,
} from "./stage.js";

export function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim() !== "";
}

export interface ValidatedLandingRecord {
  dispatchId: string;
  issueId: string;
  receiptPath: string;
  deliveryAttempt: number;
  mergedCommit: string;
}

/**
 * Validates that a completion record satisfies the landing contract.
 * F16: Requires known delivery_attempt. If record.delivery_attempt == null, rejects.
 */
export function validateLandingRecord(
  workflow: WorkflowDefinition,
  record: CompletionRecordView,
  expectedIssueId: string,
  expectedAttempt?: number,
): ValidatedLandingRecord {
  const dispatchId = record.dispatch_id;
  if (!isNonEmptyString(dispatchId)) {
    throw new Error("Landing completion record missing dispatch_id.");
  }

  if (record.issue_id == null || !isNonEmptyString(String(record.issue_id))) {
    throw new Error(
      `Landing dispatch '${dispatchId}' lacks issue_id; use a completed record that carries issue_id.`,
    );
  }

  const recordIssue = String(record.issue_id).trim();
  if (recordIssue !== expectedIssueId) {
    throw new Error(
      `Landing dispatch '${dispatchId}' belongs to issue '${recordIssue}', not '${expectedIssueId}'.`,
    );
  }

  const stageDef = resolveCanonicalStage(
    workflow,
    record.stage ?? "stage_2_land",
  );
  if (!isLandingStage(stageDef)) {
    throw new Error(
      `Landing dispatch '${dispatchId}' stage '${String(record.stage)}' is not a landing stage in workflow '${workflow.name}'.`,
    );
  }

  if (record.execution_status !== "succeeded") {
    throw new Error(
      `Landing dispatch '${dispatchId}' did not succeed (execution_status: '${record.execution_status}').`,
    );
  }

  const result = (record.result ?? {}) as Record<string, unknown>;
  if (
    result.outcome !== "landed" ||
    result.merged !== true ||
    !isNonEmptyString(result.mergedCommit)
  ) {
    throw new Error(
      `Landing dispatch '${dispatchId}' does not satisfy the landed outcome contract (requires succeeded, outcome 'landed', merged true, mergedCommit).`,
    );
  }

  if (!isNonEmptyString(record.receipt_path)) {
    throw new Error(`Landing dispatch '${dispatchId}' has no receipt_path.`);
  }

  // F16: Require KNOWN delivery_attempt on the record equal to target issue attempt.
  // If record.delivery_attempt == null, REJECT (do not manufacture identity).
  if (
    record.delivery_attempt == null ||
    typeof record.delivery_attempt !== "number"
  ) {
    throw new Error(
      `Landing dispatch '${dispatchId}' lacks required numeric delivery_attempt.`,
    );
  }

  if (
    expectedAttempt !== undefined &&
    record.delivery_attempt !== expectedAttempt
  ) {
    throw new Error(
      `Landing dispatch '${dispatchId}' delivery attempt (${record.delivery_attempt}) does not match current delivery attempt (${expectedAttempt}) for issue '${expectedIssueId}'.`,
    );
  }

  return {
    dispatchId,
    issueId: recordIssue,
    receiptPath: record.receipt_path.trim(),
    deliveryAttempt: record.delivery_attempt,
    mergedCommit: String(result.mergedCommit).trim(),
  };
}

/**
 * Checks if a landing record has been invalidated by subsequent content-changing work.
 */
export function isLandingInvalidatedBySubsequentWork(
  workflow: WorkflowDefinition,
  completedStages: readonly CompletionRecordView[],
  record: CompletionRecordView,
  issueId: string,
  deliveryAttempt: number,
): CompletionRecordView | undefined {
  const recordStep = record.step_index ?? -1;
  return completedStages.find((e) => {
    if (String(e.issue_id).trim() !== issueId) return false;
    const eAttempt = e.delivery_attempt ?? deliveryAttempt;
    if (eAttempt !== deliveryAttempt) return false;
    if ((e.step_index ?? -1) <= recordStep) return false;

    try {
      const stageDef = resolveCanonicalStage(workflow, e.stage ?? "");
      return invalidatesLanding(stageDef);
    } catch {
      return false;
    }
  });
}

export interface FinalizationIssueRecord {
  number: string;
  state?: string;
  repository?: string;
  acceptance_receipt?: string;
  [key: string]: unknown;
}

/**
 * Safely parses the finalization evidence issues array (F09).
 */
export function parseFinalizationIssues(
  evidence: Record<string, unknown>,
):
  | { valid: true; issues: FinalizationIssueRecord[] }
  | { valid: false; reason: string } {
  const rawIssues = evidence.issues;
  if (!Array.isArray(rawIssues)) {
    return {
      valid: false,
      reason:
        "verified issue-tree closure evidence is missing or malformed (issues is not an array).",
    };
  }

  const issues: FinalizationIssueRecord[] = [];
  for (let i = 0; i < rawIssues.length; i++) {
    const item = rawIssues[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        valid: false,
        reason: `finalization issue at index ${i} is not a valid object.`,
      };
    }
    const rec = item as Record<string, unknown>;
    const rawNumber = rec.number ?? rec.issue_id ?? rec.id;
    if (
      rawNumber === undefined ||
      rawNumber === null ||
      !isNonEmptyString(String(rawNumber))
    ) {
      return {
        valid: false,
        reason: `finalization issue at index ${i} is missing issue number.`,
      };
    }
    issues.push({
      ...rec,
      number: String(rawNumber).trim(),
      state: typeof rec.state === "string" ? rec.state : undefined,
      repository:
        typeof rec.repository === "string" ? rec.repository : undefined,
      acceptance_receipt:
        typeof rec.acceptance_receipt === "string"
          ? rec.acceptance_receipt
          : undefined,
    });
  }
  return { valid: true, issues };
}
