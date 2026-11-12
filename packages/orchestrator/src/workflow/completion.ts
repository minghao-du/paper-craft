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

function findStageDef(
  workflow: WorkflowDefinition,
  stageRef?: string,
): WorkflowStage | undefined {
  if (!stageRef) return undefined;
  const trimmed = stageRef.trim();
  return (
    workflow.stages.find((s) => s.id === trimmed) ??
    workflow.stages.find((s) => s.logical_task === trimmed)
  );
}

function isAuxiliaryStage(
  workflow: WorkflowDefinition,
  stageRef?: string,
): boolean {
  if (!stageRef) return false;
  const def = findStageDef(workflow, stageRef);
  if (def?.auxiliary === true) return true;
  const stageId = def?.id ?? stageRef.trim();
  return stageId === "workspace_prepare" || stageId === "workspace_cleanup";
}

function isCodeModificationStage(
  workflow: WorkflowDefinition,
  record: CompletionRecordView,
): boolean {
  const def = findStageDef(workflow, record.stage);
  const stageId = def?.id ?? record.stage ?? "";
  const logicalTask = def?.logical_task ?? "";
  const providerTarget = record.provider?.target ?? def?.provider?.target ?? "";

  const codeStages = new Set([
    "stage_2_work",
    "stage_2_land",
    "issue_work",
    "issue_land",
    "pipeline_refactor_execute",
    "pipeline_refactor_redeliver",
  ]);

  if (codeStages.has(stageId) || codeStages.has(logicalTask)) {
    return true;
  }
  if (providerTarget === "pc-issue-work" || providerTarget === "pc-pr-land") {
    return true;
  }
  return false;
}

interface CompletionEvaluation {
  blockingReasons: string[];
  reworkNeeded: boolean;
}

export function evaluateCompletion(params: {
  workflow: WorkflowDefinition;
  deliveryState?: DeliveryState;
  completedStages: readonly CompletionRecordView[];
  rootIssueId: string;
}): CompletionEvaluation {
  const { workflow, deliveryState, completedStages, rootIssueId } = params;
  const blockingReasons: string[] = [];
  const root = String(rootIssueId).trim();

  // 1. Basic policy / business rework check (Section 11.2 & W10)
  // Evaluates non-auxiliary business records keyed by (issueId, canonicalStage).
  // A key's rework_needed can only be cleared by a subsequent successful non-auxiliary business record for the same key.
  const unresolvedRework = new Map<
    string,
    { stage: string; issueId: string; stepIndex: number }
  >();

  for (const record of completedStages) {
    if (isAuxiliaryStage(workflow, record.stage)) {
      continue;
    }
    const def = findStageDef(workflow, record.stage);
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
    // Sequence & Landing checks (Section 11.3)
    const sequence = deliveryState?.sequence;
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
        }
      }
    }

    // Root verification check (Section 11.3 Rule 3)
    const verifyRecords = completedStages.filter((e) => {
      const def = findStageDef(workflow, e.stage);
      const isVerify =
        def?.id === "issue_verify" ||
        def?.logical_task === "issue_verify" ||
        e.stage === "stage_3_verify" ||
        e.stage === "issue_verify";
      return (
        isVerify &&
        e.execution_status === "succeeded" &&
        e.result?.outcome === "verified" &&
        typeof e.result?.evaluatedHead === "string" &&
        (e.result.evaluatedHead as string).trim() !== ""
      );
    });

    const latestVerify = verifyRecords.at(-1);
    if (!latestVerify) {
      blockingReasons.push(
        "Cannot finish workflow: verified root-level acceptance evidence (issue_verify) is missing.",
      );
    } else {
      // Check if subsequent code modifications occurred after latestVerify
      const verifyStep = latestVerify.step_index ?? -1;
      const subsequentCodeWork = completedStages.find(
        (e) =>
          (e.step_index ?? -1) > verifyStep &&
          isCodeModificationStage(workflow, e),
      );
      if (subsequentCodeWork) {
        blockingReasons.push(
          "Cannot finish workflow: intervening code changes occurred after root verification; repeat verification is required.",
        );
      }
    }

    // Root finalization check (Section 11.3 Rules 4, 5, 6, 7)
    const closureRecords = completedStages.filter((e) => {
      const def = findStageDef(workflow, e.stage);
      const isFinalize =
        def?.id === "issue_finalize" ||
        def?.logical_task === "issue_finalize" ||
        e.stage === "issue_finalize";
      return (
        isFinalize &&
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
      const issues = (evidence.issues as Array<Record<string, unknown>>) ?? [];

      if (
        evidence.outcome !== "finalized" ||
        String(evidence.root_issue_id) !== root ||
        !Array.isArray(issues) ||
        !issues.length ||
        !issues.every(
          (i) =>
            i &&
            i.state === "CLOSED" &&
            typeof i.repository === "string" &&
            i.repository.trim() !== "" &&
            typeof i.acceptance_receipt === "string" &&
            i.acceptance_receipt.trim() !== "",
        ) ||
        !issues.some((i) => String(i.number) === root)
      ) {
        blockingReasons.push(
          "Cannot finish workflow: verified issue-tree closure evidence is missing.",
        );
      }

      // Check planned items coverage in finalization issues
      if (sequence?.items) {
        for (const item of sequence.items) {
          if (!issues.some((i) => String(i.number) === String(item.issue_id))) {
            blockingReasons.push(
              `Cannot finish workflow: finalization issues omit planned issue '${item.issue_id}'.`,
            );
          }
        }
      }

      // Root acceptance receipt association check
      if (latestVerify?.receipt_path) {
        const rootClosureIssue = issues.find((i) => String(i.number) === root);
        if (
          rootClosureIssue &&
          rootClosureIssue.acceptance_receipt !== latestVerify.receipt_path
        ) {
          blockingReasons.push(
            "Cannot finish workflow: root issue acceptance receipt does not match the latest valid acceptance record.",
          );
        }
      }

      const empty = (v: unknown): boolean => Array.isArray(v) && v.length === 0;
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
      const isCleanupStage = (e: CompletionRecordView): boolean => {
        const def = findStageDef(workflow, e.stage);
        return (
          def?.id === "workspace_cleanup" ||
          def?.logical_task === "workspace_cleanup" ||
          e.stage === "workspace_cleanup"
        );
      };

      if (after.some((e) => !isCleanupStage(e))) {
        blockingReasons.push(
          "Cannot finish workflow: repeat issue finalization after intervening work.",
        );
      }

      // Workspace cleanup check (Section 11.3 Rules 8, 9)
      const cleanups = after.filter(
        (e) => isCleanupStage(e) && e.execution_status === "succeeded",
      );
      const latestCleanup = cleanups.at(-1);

      if (!latestCleanup) {
        blockingReasons.push(
          "Cannot finish workflow: delivery complete / cleanup incomplete.",
        );
      } else {
        const result = (latestCleanup.result ?? {}) as Record<string, unknown>;
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

    return { blockingReasons, reworkNeeded };
  }

  throw new Error(
    `Cannot finish workflow: unsupported completion policy '${workflow.completion_policy}'.`,
  );
}

export function assertCanFinish(params: AssertCanFinishParams): void {
  if (params.activeDispatch) {
    throw new Error(
      `Cannot finish workflow: active dispatch '${params.activeDispatch.dispatch_id}' is still in flight.`,
    );
  }
  if (params.protocolError) {
    throw new Error(
      `Cannot finish workflow: active protocol error exists: ${params.protocolError.message}`,
    );
  }

  const evalResult = evaluateCompletion({
    workflow: params.workflow,
    deliveryState: params.deliveryState,
    completedStages: params.completedStages ?? [],
    rootIssueId: params.rootIssueId,
  });

  if (evalResult.blockingReasons.length > 0) {
    throw new Error(evalResult.blockingReasons[0]);
  }
}

export function inspectDelivery(
  params: InspectDeliveryParams,
): DeliveryInspection {
  const { workflow, deliveryState, completedStages = [] } = params;
  const rootIssueId = deliveryState.rootIssueId;
  const currentIssueId = deliveryState.currentIssueId || rootIssueId;
  const activeReworkIssueId =
    deliveryState.sequence?.active_rework_issue_id ?? null;
  const sequenceCompleted = Boolean(deliveryState.sequence?.completed);

  let targetBudgets = deliveryState.rootBudgets;
  if (deliveryState.sequence?.items) {
    const item = deliveryState.sequence.items.find(
      (i) => String(i.issue_id) === String(currentIssueId),
    );
    if (item?.budgets) {
      targetBudgets = item.budgets;
    }
  }

  const budgets: TaskBudgetView = {
    delivery_attempts_used: targetBudgets.delivery_attempts_used ?? 0,
    delivery_attempts_max: targetBudgets.delivery_attempts_max ?? 3,
    replans_used: targetBudgets.replans_used ?? 0,
    replans_max: targetBudgets.replans_max ?? 2,
    replans_by_stage: targetBudgets.replans_by_stage
      ? { ...targetBudgets.replans_by_stage }
      : undefined,
  };

  const evalResult = evaluateCompletion({
    workflow,
    deliveryState,
    completedStages,
    rootIssueId,
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
