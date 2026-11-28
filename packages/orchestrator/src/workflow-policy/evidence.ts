import { isNonEmptyString } from "../protocol/index.js";
import { isValidCommitSha } from "../../../workspace/src/git.js";
import { missingWorkEvidence } from "./work-result.js";
import type {
  CompletionRecordView,
  DeliveryItem,
  NoChangeEvidence,
  WorkflowDefinition,
} from "./types.js";
import { WorkflowIntegrityError } from "./types.js";
import {
  invalidatesLanding,
  isLandingStage,
  resolveCanonicalStage,
} from "./stage.js";

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

/** Bind the orchestrator's no-change decision to a successful, current work receipt. */
export function validateNoChangeWork(
  workflow: WorkflowDefinition,
  record: CompletionRecordView | undefined,
  issueId: string,
  attempt: number,
  dispatchId: string,
  reason: string,
): NoChangeEvidence {
  if (
    !record || record.dispatch_id !== dispatchId || record.issue_id !== issueId ||
    !Number.isInteger(attempt) || attempt < 1 || record.delivery_attempt !== attempt ||
    !isNonEmptyString(record.receipt_path) || record.execution_status !== "succeeded"
  ) {
    throw new Error(`No-change work dispatch '${dispatchId}' is not a successful receipt for issue '${issueId}' delivery attempt ${attempt}.`);
  }
  const baseCommit = record.result?.no_change_base;
  if (!isNonEmptyString(baseCommit) || !isValidCommitSha(baseCommit) || !isNonEmptyString(reason)) {
    throw new Error("No-change acceptance requires a full target baseline SHA and an acceptance rationale.");
  }
  const stage = resolveCanonicalStage(workflow, record.stage ?? "");
  const result = record.result ?? {};
  if (stage.logical_task !== "issue_work" ||
      ["rework_needed", "out_of_scope", "failed", "blocked"].includes(String(result.outcome)) ||
      !isNonEmptyString(result.commit) ||
      missingWorkEvidence(stage, { execution_status: "succeeded", result }).length > 0) {
    throw new Error(`No-change work dispatch '${dispatchId}' lacks completed work evidence.`);
  }
  return {
    dispatch_id: dispatchId,
    receipt_path: record.receipt_path,
    delivery_attempt: attempt,
    base_commit: baseCommit.toLowerCase(),
    work_commit: result.commit.toLowerCase(),
    reason,
  };
}

export function validateNoChangeEvidence(
  workflow: WorkflowDefinition,
  history: readonly CompletionRecordView[],
  issueId: string,
  evidence: NoChangeEvidence,
): CompletionRecordView {
  const record = history.find((entry) => entry.dispatch_id === evidence.dispatch_id);
  if (!record) {
    throw new WorkflowIntegrityError(`Issue '${issueId}' accepted no-change dispatch '${evidence.dispatch_id}' is missing from history.`);
  }
  const validated = validateNoChangeWork(
    workflow, record, issueId, evidence.delivery_attempt, evidence.dispatch_id, evidence.reason,
  );
  if (validated.receipt_path !== evidence.receipt_path ||
      validated.delivery_attempt !== evidence.delivery_attempt ||
      validated.work_commit !== evidence.work_commit ||
      validated.base_commit !== evidence.base_commit) {
    throw new Error(`No-change evidence for issue '${issueId}' does not match its accepted work receipt.`);
  }
  const subsequentWork = history.some((entry) =>
    entry.issue_id === issueId && (entry.step_index ?? -1) > (record.step_index ?? -1) &&
    resolveCanonicalStage(workflow, entry.stage ?? "").logical_task === "issue_work"
  );
  if (subsequentWork) {
    throw new Error(`No-change evidence for issue '${issueId}' was invalidated by subsequent work.`);
  }
  return record;
}

/** Resolve the accepted delivery reference, including runs saved before no-change delivery. */
export function validateItemDelivery(
  workflow: WorkflowDefinition,
  history: readonly CompletionRecordView[],
  item: DeliveryItem,
): void {
  const issue = String(item.issue_id).trim();
  if (item.no_change_evidence) {
    if (item.landed || item.land_dispatch_id || item.land_receipt_path || item.landed_attempt !== undefined) {
      throw new Error(`Issue '${issue}' has conflicting no-change and landing evidence.`);
    }
    validateNoChangeEvidence(workflow, history, issue, item.no_change_evidence);
    return;
  }
  if (!item.landed || !item.land_receipt_path || !item.land_dispatch_id) {
    throw new Error(`Issue '${issue}' lacks valid landing evidence or an accepted no-change receipt.`);
  }
  const record = history.find((entry) => entry.dispatch_id === item.land_dispatch_id);
  if (!record) {
    throw new WorkflowIntegrityError(`Issue '${issue}' accepted landing dispatch '${item.land_dispatch_id}' is missing from history.`);
  }
  validateLandingRecord(workflow, record, issue, item.landed_attempt);
}
