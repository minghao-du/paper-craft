import type {
  AssertCanFinishParams,
  CompletionRecordView,
  DeliveryInspection,
  DeliveryState,
  InspectDeliveryParams,
  TaskBudgetView,
  WorkflowDefinition,
  WorkflowStage,
} from "./types.js";
import { WorkflowIntegrityError } from "./types.js";
import {
  invalidatesVerification,
  isAuxiliaryStage,
  isCleanupStage,
  isFinalizationStage,
  isVerificationStage,
  resolveCanonicalStage,
} from "./stage.js";
import {
  isNonEmptyString,
  parseFinalizationIssues,
  validateLandingRecord,
} from "./evidence.js";

function tryResolveStage(
  workflow: WorkflowDefinition,
  stageRef?: string,
): WorkflowStage | undefined {
  if (!stageRef || !stageRef.trim()) return undefined;
  try {
    return resolveCanonicalStage(workflow, stageRef);
  } catch {
    return undefined;
  }
}

interface CompletionEvaluation {
  blockingReasons: string[];
  reworkNeeded: boolean;
}

export function evaluateCompletion(params: {
  workflow: WorkflowDefinition;
  deliveryState: DeliveryState;
  completedStages: readonly CompletionRecordView[];
}): CompletionEvaluation {
  const { workflow, deliveryState, completedStages } = params;
  const blockingReasons: string[] = [];
  const root = String(deliveryState.rootIssueId).trim();

  // 1. Basic policy / business rework check (Section 11.2 & W10)
  // Evaluates non-auxiliary business records keyed by (issueId, canonicalStage).
  const unresolvedRework = new Map<
    string,
    { stage: string; issueId: string; stepIndex: number }
  >();

  for (const record of completedStages) {
    const def = tryResolveStage(workflow, record.stage);
    if (def && isAuxiliaryStage(def)) {
      continue;
    }
    const canonicalStage = def?.id ?? record.stage ?? "unknown";
    const issueId = String(record.issue_id ?? root).trim();
    const key = `${issueId}::${canonicalStage}`;
    const outcome = record.result?.outcome;
    const status = record.execution_status;

    if (outcome === "rework_needed") {
      unresolvedRework.set(key, {
        stage: canonicalStage,
        issueId,
        stepIndex: record.step_index ?? 0,
      });
    } else if (
      status === "succeeded" &&
      outcome !== "rework_needed" &&
      outcome !== "failed" &&
      outcome !== "blocked" &&
      outcome !== "out_of_scope"
    ) {
      unresolvedRework.delete(key);
    }
  }

  const reworkNeeded = unresolvedRework.size > 0;
  if (reworkNeeded) {
    for (const info of unresolvedRework.values()) {
      blockingReasons.push(
        `Cannot finish workflow: stage '${info.stage}' for issue '${info.issueId}' resulted in 'rework_needed', which has not been resolved by a subsequent successful business run.`,
      );
    }
  }

  if (workflow.completion_policy === "basic") {
    return { blockingReasons, reworkNeeded };
  }

  if (workflow.completion_policy === "issue_delivery") {
    // 2. Sequence & Landing checks (Section 11.3)
    const sequence = deliveryState.sequence;
    if (!sequence) {
      blockingReasons.push(
        "Cannot finish workflow: no delivery sequence exists.",
      );
    } else {
      if (!sequence.completed) {
        blockingReasons.push(
          "Cannot finish workflow: delivery sequence is not completed.",
        );
      }
      if (sequence.active_rework_issue_id) {
        blockingReasons.push(
          `Cannot finish workflow: active rework is in progress for issue '${sequence.active_rework_issue_id}'.`,
        );
      }
      for (const item of sequence.items) {
        if (!item.landed || !item.land_receipt_path || !item.land_dispatch_id) {
          blockingReasons.push(
            `Cannot finish workflow: issue '${item.issue_id}' lacks valid landing evidence.`,
          );
        } else {
          // Validate accepted landing reference against completedStages (Section 10.4)
          const landingRec = completedStages.find(
            (e) => e.dispatch_id === item.land_dispatch_id,
          );
          if (!landingRec) {
            blockingReasons.push(
              `Cannot finish workflow: issue '${item.issue_id}' accepted landing dispatch '${item.land_dispatch_id}' is missing from history.`,
            );
          } else {
            try {
              validateLandingRecord(
                workflow,
                landingRec,
                String(item.issue_id).trim(),
                item.landed_attempt,
              );
            } catch (err: unknown) {
              blockingReasons.push(
                `Cannot finish workflow: issue '${item.issue_id}' landing evidence is invalid: ${(err as Error).message}`,
              );
            }
          }
        }
      }
    }

    if (deliveryState.rootLandingEvidence) {
      const rootRec = completedStages.find(
        (e) => e.dispatch_id === deliveryState.rootLandingEvidence!.dispatch_id,
      );
      if (!rootRec) {
        blockingReasons.push(
          `Cannot finish workflow: root accepted landing dispatch '${deliveryState.rootLandingEvidence.dispatch_id}' is missing from history.`,
        );
      } else {
        try {
          validateLandingRecord(
            workflow,
            rootRec,
            root,
            deliveryState.rootLandingEvidence.delivery_attempt,
          );
        } catch (err: unknown) {
          blockingReasons.push(
            `Cannot finish workflow: root landing evidence is invalid: ${(err as Error).message}`,
          );
        }
      }
    }

    // 3. Root verification check (Section 10.5, F01)
    // Verification records MUST be owned by root. Child-only verification cannot satisfy root completion!
    const verifyRecords = completedStages.filter((e) => {
      const def = tryResolveStage(workflow, e.stage);
      if (!def || !isVerificationStage(def)) return false;
      const recIssue = e.issue_id != null ? String(e.issue_id).trim() : root;
      if (recIssue !== root) return false; // F01
      return (
        e.execution_status === "succeeded" &&
        e.result?.outcome === "verified" &&
        isNonEmptyString(e.result?.evaluatedHead) &&
        isNonEmptyString(e.receipt_path)
      );
    });

    const latestVerify = verifyRecords.at(-1);
    if (!latestVerify) {
      blockingReasons.push(
        "Cannot finish workflow: verified root-level acceptance evidence (issue_verify) is missing.",
      );
    } else {
      // Invalidation of verification: subsequent content-changing work or landing/redelivery
      const verifyStep = latestVerify.step_index ?? -1;
      const subsequentInvalidating = completedStages.find((e) => {
        if ((e.step_index ?? -1) <= verifyStep) return false;
        const def = tryResolveStage(workflow, e.stage);
        return def ? invalidatesVerification(def) : false;
      });
      if (subsequentInvalidating) {
        blockingReasons.push(
          "Cannot finish workflow: intervening code changes or landing occurred after root verification; repeat verification is required.",
        );
      }
    }

    // 4. Root finalization check (Section 10.5, F09)
    const closureRecords = completedStages.filter((e) => {
      const def = tryResolveStage(workflow, e.stage);
      return (
        def &&
        isFinalizationStage(def) &&
        e.execution_status === "succeeded" &&
        e.result?.scope === "tree"
      );
    });

    const closure = closureRecords.at(-1);
    if (!closure) {
      blockingReasons.push(
        "Cannot finish workflow: verified issue-tree closure evidence is missing.",
      );
    } else {
      const evidence = (closure.result ?? {}) as Record<string, unknown>;
      // F09: Safely parse finalization issues before querying
      const parsedIssues = parseFinalizationIssues(evidence);

      if (!parsedIssues.valid) {
        blockingReasons.push(
          `Cannot finish workflow: verified issue-tree closure evidence is missing or malformed: ${parsedIssues.reason}`,
        );
      } else {
        const issues = parsedIssues.issues;
        if (
          evidence.outcome !== "finalized" ||
          String(evidence.root_issue_id).trim() !== root ||
          !issues.length ||
          !issues.every(
            (i) =>
              i.state === "CLOSED" &&
              isNonEmptyString(i.repository) &&
              isNonEmptyString(i.acceptance_receipt),
          ) ||
          !issues.some((i) => i.number === root)
        ) {
          blockingReasons.push(
            "Cannot finish workflow: verified issue-tree closure evidence is missing.",
          );
        }

        // Check planned items coverage in finalization issues
        if (sequence?.items) {
          for (const item of sequence.items) {
            if (!issues.some((i) => i.number === String(item.issue_id))) {
              blockingReasons.push(
                `Cannot finish workflow: finalization issues omit planned issue '${item.issue_id}'.`,
              );
            }
          }
        }

        // Root acceptance receipt association check
        if (latestVerify?.receipt_path) {
          const rootClosureIssue = issues.find((i) => i.number === root);
          if (
            rootClosureIssue &&
            rootClosureIssue.acceptance_receipt !== latestVerify.receipt_path
          ) {
            blockingReasons.push(
              "Cannot finish workflow: root issue acceptance receipt does not match the latest valid acceptance record.",
            );
          }
        }

        const empty = (v: unknown): boolean =>
          Array.isArray(v) && v.length === 0;
        if (!empty(evidence.unresolved)) {
          blockingReasons.push(
            "Cannot finish workflow: finalization contains unresolved issues.",
          );
        }

        if (!Array.isArray(evidence.candidates)) {
          blockingReasons.push(
            "Cannot finish workflow: reconciled cleanup inventory is missing.",
          );
        }

        // Intervening work after closure
        const closureIndex = completedStages.indexOf(closure);
        const after = completedStages.slice(closureIndex + 1);
        const isCleanupRecord = (e: CompletionRecordView): boolean => {
          const def = tryResolveStage(workflow, e.stage);
          return def ? isCleanupStage(def) : false;
        };

        if (after.some((e) => !isCleanupRecord(e))) {
          blockingReasons.push(
            "Cannot finish workflow: repeat issue finalization after intervening work.",
          );
        }

        // Workspace cleanup check
        const cleanups = after.filter(
          (e) => isCleanupRecord(e) && e.execution_status === "succeeded",
        );
        const latestCleanup = cleanups.at(-1);

        if (!latestCleanup) {
          blockingReasons.push(
            "Cannot finish workflow: delivery complete / cleanup incomplete.",
          );
        } else {
          const result = (latestCleanup.result ?? {}) as Record<
            string,
            unknown
          >;
          if (
            result.outcome !== "cleaned" ||
            !empty(result.retained_paths) ||
            !empty(result.retained_branches) ||
            ((latestCleanup.step_index as number | undefined) ?? -1) <=
              ((closure.step_index as number | undefined) ?? -1)
          ) {
            blockingReasons.push(
              "Cannot finish workflow: delivery complete / cleanup incomplete.",
            );
          }

          // Inventory check
          const paths = new Set(
            cleanups.flatMap(
              (r) =>
                ((r.result as Record<string, unknown>)
                  ?.removed_paths as string[]) ?? [],
            ),
          );
          const branches = cleanups.flatMap(
            (r) =>
              ((r.result as Record<string, unknown>)?.removed_branches as Array<
                Record<string, unknown>
              >) ?? [],
          );

          if (Array.isArray(evidence.candidates)) {
            for (const candidate of evidence.candidates as Array<
              Record<string, unknown>
            >) {
              const branch = candidate.branch as string | undefined;
              const worktree = candidate.worktree as string | undefined;
              const pushRemote = candidate.push_remote as string | undefined;

              if (
                (worktree && !paths.has(worktree)) ||
                (branch &&
                  (!branches.some(
                    (b) =>
                      b.branch === branch &&
                      b.scope === "local" &&
                      b.remote == null,
                  ) ||
                    !branches.some(
                      (b) =>
                        b.branch === branch &&
                        b.scope === "remote" &&
                        b.remote === pushRemote,
                    )))
              ) {
                blockingReasons.push(
                  "Cannot finish workflow: reconciled resource lacks cleanup evidence.",
                );
                break;
              }
            }
          }
        }
      }
    }

    return { blockingReasons, reworkNeeded };
  }

  throw new Error(
    `Cannot finish workflow: unsupported completion policy '${workflow.completion_policy}'.`,
  );
}

export function assertCanFinish(params: AssertCanFinishParams): void {
  const evalResult = evaluateCompletion({
    workflow: params.workflow,
    deliveryState: params.deliveryState,
    completedStages: params.completedStages ?? [],
  });

  if (evalResult.blockingReasons.length > 0) {
    throw new Error(evalResult.blockingReasons[0]);
  }
}

export function inspectDelivery(
  params: InspectDeliveryParams,
): DeliveryInspection {
  const { workflow, deliveryState, completedStages = [] } = params;

  // Domain state structural invariant checks (Section 11.1, 11.2):
  if (!deliveryState || !deliveryState.rootIssueId) {
    throw new WorkflowIntegrityError(
      "DeliveryState is missing or lacks rootIssueId.",
    );
  }

  const rootIssueId = String(deliveryState.rootIssueId).trim();
  const sequence = deliveryState.sequence;

  // F18: Invalid sequence cursor throws WorkflowIntegrityError
  if (sequence && !sequence.completed) {
    const curIdx = sequence.current_index;
    if (
      typeof curIdx !== "number" ||
      curIdx < 0 ||
      curIdx >= sequence.items.length
    ) {
      throw new WorkflowIntegrityError(
        `Invalid sequence cursor: current_index ${curIdx} is out of bounds for sequence of length ${sequence.items.length}.`,
      );
    }
  }

  // F17: Dangling accepted landing references throw WorkflowIntegrityError
  if (sequence) {
    for (const item of sequence.items) {
      if (item.landed) {
        if (!item.land_dispatch_id) {
          throw new WorkflowIntegrityError(
            `Landed item '${item.issue_id}' lacks land_dispatch_id.`,
          );
        }
        const rec = completedStages.find(
          (e) => e.dispatch_id === item.land_dispatch_id,
        );
        if (!rec) {
          throw new WorkflowIntegrityError(
            `Dangling accepted landing dispatch '${item.land_dispatch_id}' for issue '${item.issue_id}' not found in completed stages.`,
          );
        }
        if (
          rec.issue_id != null &&
          String(rec.issue_id).trim() !== String(item.issue_id).trim()
        ) {
          throw new WorkflowIntegrityError(
            `Accepted landing dispatch '${item.land_dispatch_id}' issue '${rec.issue_id}' does not match item '${item.issue_id}'.`,
          );
        }
      }
    }
  }

  if (deliveryState.rootLandingEvidence) {
    const rec = completedStages.find(
      (e) => e.dispatch_id === deliveryState.rootLandingEvidence!.dispatch_id,
    );
    if (!rec) {
      throw new WorkflowIntegrityError(
        `Dangling accepted root landing dispatch '${deliveryState.rootLandingEvidence.dispatch_id}' not found in completed stages.`,
      );
    }
  }

  const currentIssueId = deliveryState.currentIssueId || rootIssueId;
  const activeReworkIssueId = sequence?.active_rework_issue_id ?? null;
  const sequenceCompleted = Boolean(sequence?.completed);

  let targetBudgets = deliveryState.rootBudgets;
  if (sequence?.items) {
    const item = sequence.items.find(
      (i) => String(i.issue_id) === String(currentIssueId),
    );
    if (item?.budgets) {
      targetBudgets = item.budgets;
    }
  }

  const budgets: TaskBudgetView = {
    delivery_attempts_used: targetBudgets.delivery_attempts_used ?? 0,
    delivery_attempts_max:
      typeof targetBudgets.delivery_attempts_max === "number"
        ? targetBudgets.delivery_attempts_max
        : 3,
    replans_used: targetBudgets.replans_used ?? 0,
    replans_max:
      typeof targetBudgets.replans_max === "number"
        ? targetBudgets.replans_max
        : 2,
    replans_by_stage: targetBudgets.replans_by_stage
      ? { ...targetBudgets.replans_by_stage }
      : undefined,
  };

  const evalResult = evaluateCompletion({
    workflow,
    deliveryState,
    completedStages,
  });

  return {
    currentIssueId,
    activeReworkIssueId,
    budgets,
    blockingReasons: evalResult.blockingReasons,
    reworkNeeded: evalResult.reworkNeeded,
    sequenceCompleted,
    canFinish: evalResult.blockingReasons.length === 0,
  };
}
