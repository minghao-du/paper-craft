import { isNonEmptyString, isObject, type CompactReport } from "../protocol/index.js";
import { invalidatesVerification, isFinalizationStage, tryResolveStage } from "./stage.js";
import type {
  CompletionRecordView,
  DeliveryItem,
  DeliveryState,
  WorkflowDefinition,
  WorkflowStage,
} from "./types.js";

type RootVerification =
  | { status: "missing" | "stale" }
  | { status: "current"; receiptPath: string };

export function checkRootVerification(
  workflow: WorkflowDefinition,
  history: readonly CompletionRecordView[],
  root: string,
): RootVerification {
  const latest = history.findLast((record) =>
    tryResolveStage(workflow, record.stage)?.logical_task === "issue_verify" &&
    String(record.issue_id ?? root).trim() === root &&
    record.execution_status === "succeeded" &&
    record.result?.outcome === "verified" &&
    isNonEmptyString(record.result.evaluatedHead) &&
    isNonEmptyString(record.receipt_path)
  );
  if (!latest?.receipt_path) return { status: "missing" };

  const stale = history.some((record) => {
    if ((record.step_index ?? -1) <= (latest.step_index ?? -1)) return false;
    const stage = tryResolveStage(workflow, record.stage);
    return stage ? invalidatesVerification(stage) : false;
  });
  if (stale) return { status: "stale" };
  return { status: "current", receiptPath: latest.receipt_path };
}

/** Defects a finalization worker can fix in its own result. Verification freshness is a separate gate. */
export function missingClosureEvidence(
  result: Record<string, unknown>,
  root: string,
  plannedItems: readonly Pick<DeliveryItem, "issue_id">[],
  verification: RootVerification,
): string[] {
  const missing: string[] = [];
  if (result.scope !== "tree") missing.push('result.scope must be "tree" for root finalization');
  if (result.outcome !== "finalized") missing.push('result.outcome must be "finalized"');
  if (String(result.root_issue_id).trim() !== root) {
    missing.push(`result.root_issue_id must identify root issue '${root}'`);
  }
  if (!Array.isArray(result.issues) || result.issues.length === 0) {
    return [...missing, "result.issues must be a nonempty array"];
  }

  const issueNumbers = new Set<string>();
  let foundRoot = false;
  for (const [index, entry] of result.issues.entries()) {
    const field = `result.issues[${index}]`;
    if (!isObject(entry)) {
      missing.push(`${field} must be an issue object`);
      continue;
    }
    // Accept issue identity aliases used in previously recorded results.
    const number = String(entry.number ?? entry.issue_id ?? entry.id ?? "").trim();
    if (number) issueNumbers.add(number);
    else missing.push(`${field}.number must identify the issue`);
    const issue = number ? ` for issue '${number}'` : "";
    if (entry.state !== "CLOSED") missing.push(`${field}.state${issue} must be "CLOSED"`);
    if (!isNonEmptyString(entry.repository)) missing.push(`${field}.repository${issue} is required`);
    if (!isNonEmptyString(entry.acceptance_receipt)) {
      missing.push(`${field}.acceptance_receipt${issue} is required`);
    }
    if (number === root && !foundRoot) {
      foundRoot = true;
      if (verification.status === "current" && entry.acceptance_receipt !== verification.receiptPath) {
        missing.push(
          `${field}.acceptance_receipt${issue} does not match the latest valid root issue_verify receipt. Use the single path ${JSON.stringify(verification.receiptPath)}.`,
        );
      }
    }
  }
  if (!foundRoot) missing.push(`result.issues must include root issue '${root}'`);
  for (const item of plannedItems) {
    if (!issueNumbers.has(String(item.issue_id))) {
      missing.push(`finalization issues omit planned issue '${item.issue_id}' from result.issues`);
    }
  }
  return missing;
}

export function missingFinalizationEvidence(params: {
  workflow: WorkflowDefinition;
  stage: WorkflowStage;
  deliveryState: Pick<DeliveryState, "rootIssueId" | "sequence">;
  history: readonly CompletionRecordView[];
  issueId: string;
  assignedScope?: string;
  report: Pick<CompactReport, "result" | "execution_status">;
}): string[] {
  const { workflow, stage, deliveryState, history, issueId, assignedScope, report } = params;
  const { result } = report;
  if (workflow.completion_policy !== "issue_delivery" || !isFinalizationStage(stage) ||
    report.execution_status !== "succeeded" ||
    ["rework_needed", "out_of_scope", "failed", "blocked"].includes(String(result.outcome))) {
    return [];
  }

  const root = String(deliveryState.rootIssueId).trim();
  const treeClosure = result.scope === "tree" || assignedScope === "tree" ||
    (result.scope !== "issue" && assignedScope !== "issue" && issueId.trim() === root);
  if (!treeClosure) return [];

  return missingClosureEvidence(
    result,
    root,
    deliveryState.sequence?.items ?? [],
    checkRootVerification(workflow, history, root),
  );
}
