import type {
  ApplyDeliveryDecisionParams,
  CompletionRecordView,
  DeliveryDecision,
  DeliveryDecisionResult,
  DeliveryItem,
  DeliverySequence,
  DeliveryState,
  IssueBudgets,
  WorkflowBudgets,
  WorkflowDefinition,
  WorkflowStage,
} from "./types.js";
import { WorkflowIntegrityError } from "./types.js";
import {
  allocatesDeliveryAttempt,
  invalidatesLanding,
  isAuxiliaryStage,
  isCleanupStage,
  isContentChangingStage,
  isFinalizationStage,
  isInitialPlanStage,
  isLandingStage,
  isReplanStage,
  isVerificationStage,
  resolveCanonicalStage,
} from "./stage.js";
import {
  isLandingInvalidatedBySubsequentWork,
  validateLandingRecord,
} from "./evidence.js";

export interface DeliveryDispatchResult {
  currentIssueId: string;
  attempt: number;
  deliveryAttempt: number;
  originatingStage?: string;
  budgets: {
    delivery_attempts_used: number;
    delivery_attempts_max: number;
    replans_used: number;
    replans_max: number;
    replans_by_stage?: Record<string, number>;
  };
  nextDeliveryState: DeliveryState;
}

function parsePositiveIntegerId(raw: unknown, label: string): string {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new Error(`${label} must be a positive integer, got ${raw}.`);
    }
    return String(raw);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new Error(`${label} must be a positive integer, got '${raw}'.`);
    }
    return trimmed;
  }
  throw new Error(`${label} must be a positive integer, got ${typeof raw}.`);
}

function validatePlanOrder(tasks: unknown[], rootIssueId?: string): string[] {
  if (!Array.isArray(tasks) || tasks.length < 2) {
    throw new Error(
      "Decomposed plan must contain an array of at least 2 tasks.",
    );
  }
  const rootStr = rootIssueId != null ? String(rootIssueId).trim() : null;
  const seen = new Set<string>();
  const parsedItems: Array<{ id: string; deps: string[] }> = [];

  for (let idx = 0; idx < tasks.length; idx++) {
    const item = tasks[idx];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Task at index ${idx} must be an object.`);
    }
    const t = item as Record<string, unknown>;
    const rawId =
      t.number !== undefined
        ? t.number
        : t.issue_id !== undefined
          ? t.issue_id
          : t.id;
    if (rawId === undefined || rawId === null) {
      throw new Error(`Task at index ${idx} is missing issue ID/number.`);
    }
    const id = parsePositiveIntegerId(rawId, `Task at index ${idx} issue ID`);
    if (rootStr !== null && id === rootStr) {
      throw new Error(`Task '${id}' cannot be the root issue ID.`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate issue ID '${id}' in plan.`);
    }
    seen.add(id);

    let deps: string[] = [];
    const hasBlockedBy =
      t.blockedBy !== undefined || t.blocked_by !== undefined;
    if (hasBlockedBy) {
      const rawDeps = t.blockedBy !== undefined ? t.blockedBy : t.blocked_by;
      if (!Array.isArray(rawDeps)) {
        throw new Error(`Task '${id}' blockedBy must be an array.`);
      }
      deps = rawDeps.map((d, dIdx) =>
        parsePositiveIntegerId(d, `Task '${id}' dependency at index ${dIdx}`),
      );
    }
    parsedItems.push({ id, deps });
  }

  const resolved = new Set<string>();
  for (const { id, deps } of parsedItems) {
    for (const dep of deps) {
      if (dep === id) {
        throw new Error(`Task '${id}' cannot depend on itself.`);
      }
      if (!seen.has(dep)) {
        throw new Error(
          `Plan dependency violation: task '${id}' depends on unknown issue '${dep}' not declared in plan.`,
        );
      }
      if (!resolved.has(dep)) {
        throw new Error(
          `Plan dependency violation: task '${id}' depends on '${dep}', which does not precede it in the plan order.`,
        );
      }
    }
    resolved.add(id);
  }

  return parsedItems.map((item) => item.id);
}

/**
 * Child sequence creation inheriting replans_max and delivery_attempts_max from rootBudgets (F14).
 * Child usage starts strictly at 0.
 */
function makeDeliverySequence(
  ids: string[],
  rootBudgets: IssueBudgets,
  initialStage: string,
): DeliverySequence {
  const deliveryMax =
    typeof rootBudgets.delivery_attempts_max === "number"
      ? rootBudgets.delivery_attempts_max
      : 3;
  const replanMax =
    typeof rootBudgets.replans_max === "number"
      ? rootBudgets.replans_max
      : 2;

  return {
    items: ids.map((issue_id) => ({
      issue_id,
      stage: initialStage,
      status: "pending",
      budgets: {
        delivery_attempts_used: 0,
        delivery_attempts_max: deliveryMax,
        replans_used: 0,
        replans_max: replanMax,
        replans_by_stage: {},
      },
      landed: false,
    })),
    current_index: 0,
    completed: false,
  };
}

/**
 * Evaluates dispatch attempt and delivery state transitions for a task.
 * Exported for internal test and dispatch usage.
 */
export function calculateDeliveryDispatch(
  workflow: WorkflowDefinition,
  deliveryState: DeliveryState,
  stageDef: WorkflowStage,
  request: {
    attempt_intent?: "same" | "new";
    rework_issue?: string | null;
    originating_stage?: string;
  },
  completedStages?: readonly CompletionRecordView[],
): DeliveryDispatchResult {
  // Input immutability: clone deliveryState completely
  const nextDeliveryState: DeliveryState = structuredClone(deliveryState);
  const rootIssueId = String(nextDeliveryState.rootIssueId).trim();

  const isReplan = isReplanStage(stageDef);
  const isAux = isAuxiliaryStage(stageDef);
  const isPostDeliveryReview =
    isVerificationStage(stageDef) ||
    isFinalizationStage(stageDef) ||
    isCleanupStage(stageDef);
  const isContentChanging = isContentChangingStage(stageDef);

  // 1. Issue ownership
  const designated =
    request.rework_issue != null && request.rework_issue.trim() !== ""
      ? String(request.rework_issue).trim()
      : null;

  let targetIssueId: string;

  if (designated !== null) {
    const inSequence = nextDeliveryState.sequence?.items?.find(
      (i) => String(i.issue_id) === designated,
    );
    const isRoot = designated === rootIssueId;

    if (!inSequence && !isRoot) {
      throw new Error(
        `Cannot attribute rework to issue '${designated}': issue not found in delivery sequence. Gaps that cannot be attributed to an existing issue must be routed to replanning; do not guess attribution or replace plan.`,
      );
    }

    if (
      nextDeliveryState.sequence?.active_rework_issue_id &&
      nextDeliveryState.sequence.active_rework_issue_id !== designated
    ) {
      throw new Error(
        `Cannot switch active rework from issue '${nextDeliveryState.sequence.active_rework_issue_id}' to '${designated}'.`,
      );
    }

    targetIssueId = designated;
  } else if (nextDeliveryState.sequence?.active_rework_issue_id) {
    targetIssueId = String(nextDeliveryState.sequence.active_rework_issue_id);
  } else if (
    nextDeliveryState.sequence &&
    !nextDeliveryState.sequence.completed
  ) {
    const curIdx = nextDeliveryState.sequence.current_index;
    if (
      typeof curIdx !== "number" ||
      curIdx < 0 ||
      curIdx >= nextDeliveryState.sequence.items.length
    ) {
      throw new WorkflowIntegrityError(
        `Invalid sequence current_index: ${curIdx}. Cursor is out of range for sequence of length ${nextDeliveryState.sequence.items.length}.`,
      );
    }
    const curItem = nextDeliveryState.sequence.items[curIdx];
    targetIssueId = String(curItem.issue_id);
  } else {
    targetIssueId = rootIssueId;
  }

  // Find target item (if child) and authoritative budget (F07)
  const isRootTarget = targetIssueId === rootIssueId;
  const targetItem: DeliveryItem | null = isRootTarget
    ? null
    : (nextDeliveryState.sequence?.items?.find(
        (i) => String(i.issue_id) === targetIssueId,
      ) ?? null);

  if (!isRootTarget && !targetItem) {
    throw new WorkflowIntegrityError(
      `Target issue '${targetIssueId}' not found in delivery sequence.`,
    );
  }

  const targetBudgets: IssueBudgets = targetItem
    ? targetItem.budgets
    : nextDeliveryState.rootBudgets;

  let attempt: number;
  let deliveryAttempt: number;
  let originStage: string | undefined;

  // 2. Budget calculations by stage type
  if (isReplan) {
    if (request.originating_stage && request.originating_stage.trim() !== "") {
      const originDef = resolveCanonicalStage(
        workflow,
        request.originating_stage,
      );
      originStage = originDef.id;
    } else {
      const candidates = (completedStages ?? []).filter((e) => {
        if (e.issue_id != null && String(e.issue_id).trim() !== targetIssueId) {
          return false;
        }
        try {
          const def = resolveCanonicalStage(workflow, e.stage ?? "");
          if (isAuxiliaryStage(def) || isReplanStage(def)) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      });

      const latestRecord = candidates.at(-1);
      if (!latestRecord || !latestRecord.stage) {
        throw new Error(
          `Cannot infer originating_stage for replan: no prior non-auxiliary, non-replan completion record found for issue '${targetIssueId}'. Please provide originating_stage explicitly.`,
        );
      }
      const originDef = resolveCanonicalStage(workflow, latestRecord.stage);
      originStage = originDef.id;
    }

    const originDef = resolveCanonicalStage(workflow, originStage);
    if (isReplanStage(originDef)) {
      throw new Error(
        `Replan stage '${originDef.id}' cannot be its own originating stage.`,
      );
    }

    const replanMax =
      typeof targetBudgets.replans_max === "number"
        ? targetBudgets.replans_max
        : 2;
    const byStage = (targetBudgets.replans_by_stage ??= {});
    const used = byStage[originStage] ?? 0;

    if (replanMax <= 0 || used >= replanMax) {
      throw new Error(
        `Budget exceeded: replans used (${used}) reached maximum (${replanMax}) for issue ${targetIssueId} and originating stage ${originStage}.`,
      );
    }

    byStage[originStage] = used + 1;
    targetBudgets.replans_used = (targetBudgets.replans_used ?? 0) + 1;

    attempt = used + 1;
    deliveryAttempt = targetBudgets.delivery_attempts_used || 1;
  } else if (isAux) {
    const used = targetBudgets.delivery_attempts_used ?? 0;
    attempt = Math.max(1, used);
    deliveryAttempt = used;
  } else if (isPostDeliveryReview) {
    // F13: Verification, finalization, cleanup after landing
    // MUST NOT allocate a new delivery attempt, must NOT clear landing evidence,
    // and must NOT be rejected in direct mode just because the issue is landed.
    if (request.attempt_intent === "new") {
      throw new Error(
        `Cannot start a new delivery attempt on non-content-changing stage '${stageDef.id}'.`,
      );
    }
    const used = targetBudgets.delivery_attempts_used ?? 0;
    attempt = Math.max(1, used);
    deliveryAttempt = used;
  } else {
    // Content-changing work / ordinary delivery stage
    const isExplicitRework = designated !== null;
    const isActiveRework = Boolean(
      nextDeliveryState.sequence?.active_rework_issue_id,
    );
    const isFirstStartingRework =
      isExplicitRework &&
      nextDeliveryState.sequence?.active_rework_issue_id !== designated;

    const max =
      typeof targetBudgets.delivery_attempts_max === "number"
        ? targetBudgets.delivery_attempts_max
        : 3;

    if (isFirstStartingRework) {
      if (request.attempt_intent !== "new") {
        throw new Error(
          `Starting rework on issue '${designated}' requires attempt_intent: 'new'.`,
        );
      }
      const used = targetBudgets.delivery_attempts_used ?? 0;
      if (used >= max) {
        throw new Error(
          `Budget exceeded: delivery attempts used (${used}) reached maximum (${max}) for issue ${targetIssueId}.`,
        );
      }
      targetBudgets.delivery_attempts_used = used + 1;
      if (nextDeliveryState.sequence) {
        nextDeliveryState.sequence.active_rework_issue_id = targetIssueId;
      }
      if (targetItem) {
        targetItem.landed = false;
        delete targetItem.landed_attempt;
        delete targetItem.land_receipt_path;
        delete targetItem.land_dispatch_id;
        targetItem.status = "pending";
        targetItem.stage = stageDef.id;
      } else if (targetIssueId === rootIssueId) {
        delete nextDeliveryState.rootLandingEvidence;
      }
      deliveryAttempt = targetBudgets.delivery_attempts_used;
      attempt = deliveryAttempt;
    } else if (isActiveRework) {
      if (request.attempt_intent === "new") {
        const used = targetBudgets.delivery_attempts_used ?? 0;
        if (used >= max) {
          throw new Error(
            `Budget exceeded: delivery attempts used (${used}) reached maximum (${max}) for issue ${targetIssueId}.`,
          );
        }
        targetBudgets.delivery_attempts_used = used + 1;
        if (targetItem) {
          targetItem.landed = false;
          delete targetItem.landed_attempt;
          delete targetItem.land_receipt_path;
          delete targetItem.land_dispatch_id;
          targetItem.status = "pending";
          targetItem.stage = stageDef.id;
        } else if (targetIssueId === rootIssueId) {
          delete nextDeliveryState.rootLandingEvidence;
        }
        deliveryAttempt = targetBudgets.delivery_attempts_used;
        attempt = deliveryAttempt;
      } else {
        deliveryAttempt = targetBudgets.delivery_attempts_used;
        attempt = deliveryAttempt;
        if (targetItem) {
          targetItem.stage = stageDef.id;
        }
      }
    } else {
      if (targetItem?.landed && request.attempt_intent !== "new") {
        throw new Error(
          `Issue '${targetIssueId}' is already landed. Modifying an already landed issue requires attempt_intent: 'new'.`,
        );
      }

      const used = targetBudgets.delivery_attempts_used ?? 0;
      if (used === 0) {
        if (max <= 0) {
          throw new Error(
            `Budget exceeded: delivery attempts max (${max}) is exhausted for issue ${targetIssueId}.`,
          );
        }
        targetBudgets.delivery_attempts_used = 1;
        deliveryAttempt = 1;
        attempt = 1;
        if (targetItem) {
          targetItem.stage = stageDef.id;
          targetItem.status = "pending";
        }
      } else if (request.attempt_intent === "new") {
        if (used >= max) {
          throw new Error(
            `Budget exceeded: delivery attempts used (${used}) reached maximum (${max}) for issue ${targetIssueId}.`,
          );
        }
        targetBudgets.delivery_attempts_used = used + 1;
        deliveryAttempt = targetBudgets.delivery_attempts_used;
        attempt = deliveryAttempt;
        if (targetItem) {
          targetItem.landed = false;
          delete targetItem.landed_attempt;
          delete targetItem.land_receipt_path;
          delete targetItem.land_dispatch_id;
          targetItem.stage = stageDef.id;
          targetItem.status = "pending";
        } else if (targetIssueId === rootIssueId) {
          delete nextDeliveryState.rootLandingEvidence;
        }
      } else {
        deliveryAttempt = used;
        attempt = used;
        if (targetItem) {
          targetItem.stage = stageDef.id;
          targetItem.status = "pending";
        }
      }
    }
  }

  // Direct mode synchronization
  if (
    targetIssueId === rootIssueId &&
    nextDeliveryState.sequence?.items?.length === 1 &&
    nextDeliveryState.sequence.items[0].issue_id === rootIssueId
  ) {
    nextDeliveryState.sequence.items[0].budgets = structuredClone(
      nextDeliveryState.rootBudgets,
    );
  }

  nextDeliveryState.currentIssueId = targetIssueId;

  return {
    currentIssueId: targetIssueId,
    attempt,
    deliveryAttempt,
    originatingStage: isReplan ? originStage : undefined,
    budgets: {
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
    },
    nextDeliveryState,
  };
}

/**
 * Applies a delivery decision atomically (Section 9.4).
 * Returns nextDeliveryState and optional nextStage.
 */
export function applyDeliveryDecision(
  params: ApplyDeliveryDecisionParams,
): DeliveryDecisionResult {
  const { workflow, deliveryState, decision, completedStages } = params;

  if (decision.kind === "accept_plan") {
    if (workflow.completion_policy === "basic") {
      throw new Error(
        "Cannot accept plan: completion policy 'basic' does not support plan acceptance.",
      );
    }
    if (deliveryState.sequence) {
      throw new Error("Cannot accept plan: delivery sequence already exists.");
    }
    if (
      !decision.nextStage ||
      typeof decision.nextStage !== "string" ||
      !decision.nextStage.trim()
    ) {
      throw new Error(
        "Plan acceptance requires an explicit non-empty 'nextStage'.",
      );
    }
    const nextStageDef = resolveCanonicalStage(workflow, decision.nextStage);
    const initialStage = nextStageDef.id;

    const record = (completedStages ?? []).find(
      (e) => e.dispatch_id === decision.planDispatchId,
    );
    if (!record) {
      throw new Error(
        `Planning dispatch '${decision.planDispatchId}' not found in completed stages.`,
      );
    }

    const rootIssueId = String(deliveryState.rootIssueId).trim();
    if (
      record.issue_id != null &&
      String(record.issue_id).trim() !== rootIssueId
    ) {
      throw new Error(
        `Planning dispatch '${decision.planDispatchId}' belongs to issue '${record.issue_id}', expected root issue '${rootIssueId}'.`,
      );
    }

    if (record.execution_status !== "succeeded") {
      throw new Error(
        `Planning dispatch '${decision.planDispatchId}' execution status is '${record.execution_status}', expected 'succeeded'.`,
      );
    }

    const planStageDef = resolveCanonicalStage(
      workflow,
      record.stage ?? "stage_1_plan",
    );
    if (!isInitialPlanStage(planStageDef)) {
      throw new Error(
        `Stage '${planStageDef.id}' is not an initial planning stage.`,
      );
    }

    const result = (record.result ?? {}) as Record<string, unknown>;
    const outcome = result.outcome;
    if (outcome !== "direct" && outcome !== "decomposed") {
      throw new Error(
        `Planning outcome must be 'direct' or 'decomposed', got '${String(outcome)}'.`,
      );
    }

    // Freshness check: no subsequent non-auxiliary business execution
    const planStep = record.step_index ?? -1;
    const subsequentNonAux = (completedStages ?? []).find((e) => {
      if ((e.step_index ?? -1) <= planStep) return false;
      try {
        const def = resolveCanonicalStage(workflow, e.stage ?? "");
        return !isAuxiliaryStage(def);
      } catch {
        return true;
      }
    });
    if (subsequentNonAux) {
      throw new Error(
        `Planning dispatch '${decision.planDispatchId}' invalidated by subsequent execution at step ${subsequentNonAux.step_index}.`,
      );
    }

    let deliverySequence: DeliverySequence;
    let currentIssueId: string;
    const nextRootBudgets: IssueBudgets = structuredClone(
      deliveryState.rootBudgets,
    );

    if (outcome === "direct") {
      const planObj = result.plan as Record<string, unknown> | undefined;
      const directTasks =
        planObj?.tasks ??
        (Array.isArray(result.plan) ? result.plan : undefined) ??
        result.tasks;
      if (Array.isArray(directTasks) && directTasks.length > 0) {
        throw new Error("Direct planning outcome cannot contain tasks.");
      }

      deliverySequence = makeDeliverySequence(
        [rootIssueId],
        nextRootBudgets,
        initialStage,
      );
      const rootItem = deliverySequence.items[0];
      rootItem.budgets.delivery_attempts_used = 0;
      rootItem.budgets.delivery_attempts_max =
        nextRootBudgets.delivery_attempts_max ?? 3;
      rootItem.budgets.replans_used = nextRootBudgets.replans_used ?? 0;
      rootItem.budgets.replans_max =
        typeof nextRootBudgets.replans_max === "number"
          ? nextRootBudgets.replans_max
          : 2;
      if (nextRootBudgets.replans_by_stage) {
        rootItem.budgets.replans_by_stage = structuredClone(
          nextRootBudgets.replans_by_stage,
        );
      }
      nextRootBudgets.delivery_attempts_used = 0;
      currentIssueId = rootIssueId;
      deliverySequence.current_index = 0;
      deliverySequence.completed = false;
    } else {
      const planObj = result.plan;
      if (!planObj || typeof planObj !== "object" || Array.isArray(planObj)) {
        throw new Error(
          "Decomposed planning result must contain a 'plan' object.",
        );
      }
      const rawTasks = (planObj as Record<string, unknown>).tasks;
      if (!Array.isArray(rawTasks) || rawTasks.length < 2) {
        throw new Error(
          "Decomposed plan must contain an array of at least 2 tasks.",
        );
      }

      const taskIds = validatePlanOrder(rawTasks, rootIssueId);
      deliverySequence = makeDeliverySequence(
        taskIds,
        nextRootBudgets,
        initialStage,
      );
      nextRootBudgets.delivery_attempts_used = 0;
      currentIssueId = taskIds[0];
      deliverySequence.current_index = 0;
      deliverySequence.completed = false;
    }

    return {
      nextDeliveryState: {
        rootIssueId,
        currentIssueId,
        rootBudgets: nextRootBudgets,
        sequence: deliverySequence,
        rootLandingEvidence: deliveryState.rootLandingEvidence,
      },
      nextStage: initialStage,
    };
  }

  if (decision.kind === "update_delivery") {
    const rootIssueId = String(deliveryState.rootIssueId).trim();
    let currentIssueId = String(
      deliveryState.currentIssueId ?? rootIssueId,
    ).trim();
    const nextDeliveryState: DeliveryState = structuredClone(deliveryState);
    const sequence = nextDeliveryState.sequence;

    // 1. Validate sequence cursor if sequence exists and is unfinished (F18)
    if (sequence && !sequence.completed) {
      const curIdx = sequence.current_index;
      if (
        typeof curIdx !== "number" ||
        curIdx < 0 ||
        curIdx >= sequence.items.length
      ) {
        throw new WorkflowIntegrityError(
          `Invalid sequence current_index: ${curIdx}. Cursor is out of range for sequence of length ${sequence.items.length}.`,
        );
      }
    }

    // 2. Landing registration (F16, atomic order: capture attempt before cursor change)
    let nextRootLandingEvidence = nextDeliveryState.rootLandingEvidence;
    if (decision.landing) {
      const issue = String(decision.landing.issueId).trim();
      const dispatchId = String(decision.landing.dispatchId).trim();
      if (!sequence) {
        throw new Error(
          `Cannot mark issue '${issue}' landed: no delivery sequence exists.`,
        );
      }
      const item = sequence.items.find((i) => String(i.issue_id) === issue);
      const isRoot = issue === rootIssueId;
      if (!item && !isRoot) {
        throw new Error(
          `Cannot mark issue '${issue}' landed: issue not found in delivery sequence.`,
        );
      }

      const currentAttempt = item
        ? (item.budgets?.delivery_attempts_used ?? 1)
        : (nextDeliveryState.rootBudgets.delivery_attempts_used ?? 1);

      const record = (completedStages ?? []).find(
        (e) => e.dispatch_id === dispatchId,
      );
      if (!record) {
        throw new Error(
          `Landing dispatch '${dispatchId}' not found in completed stages.`,
        );
      }

      const validated = validateLandingRecord(
        workflow,
        record,
        issue,
        currentAttempt,
      );

      // Invalidation check by subsequent content-changing work
      const invalidated = isLandingInvalidatedBySubsequentWork(
        workflow,
        completedStages ?? [],
        record,
        issue,
        currentAttempt,
      );
      if (invalidated) {
        throw new Error(
          `Landing dispatch '${dispatchId}' has been invalidated by subsequent work at step ${invalidated.step_index}.`,
        );
      }

      if (item) {
        if (item.landed) {
          if (item.land_dispatch_id !== dispatchId) {
            throw new Error(
              `Issue '${issue}' is already landed by dispatch '${String(item.land_dispatch_id)}'; refusing different landing evidence from dispatch '${dispatchId}'.`,
            );
          }
        } else {
          item.landed = true;
          item.status = "landed";
          item.stage = "landed";
          item.land_dispatch_id = dispatchId;
          item.land_receipt_path = validated.receiptPath;
          item.landed_attempt = currentAttempt;
        }
      }
      if (isRoot) {
        nextRootLandingEvidence = {
          dispatch_id: dispatchId,
          receipt_path: validated.receiptPath,
          delivery_attempt: currentAttempt,
        };
      }

      // Resolve active rework if matching
      if (sequence.active_rework_issue_id === issue) {
        sequence.active_rework_issue_id = null;
      }
    }

    // 3. Issue selection (F08: switching currentIssueId must NEVER clear active_rework_issue_id without landing it)
    if (decision.currentIssueId != null) {
      const targetIssue = String(decision.currentIssueId).trim();
      if (
        sequence?.active_rework_issue_id &&
        sequence.active_rework_issue_id !== targetIssue
      ) {
        throw new Error(
          `Cannot switch current issue to '${targetIssue}': active rework is in progress for issue '${sequence.active_rework_issue_id}'.`,
        );
      }
      currentIssueId = targetIssue;
      if (sequence) {
        const index = sequence.items.findIndex(
          (i) => String(i.issue_id) === targetIssue,
        );
        if (index >= 0) {
          sequence.current_index = index;
        } else if (targetIssue === rootIssueId) {
          // Returning to root is valid
        } else {
          throw new Error(
            `Cannot switch to issue '${targetIssue}': issue not found in delivery sequence.`,
          );
        }
        // F07: Do NOT pollute nextDeliveryState.rootBudgets with item budgets!
      }
    }

    // 4. Sequence completion
    if (decision.completeSequence) {
      if (!sequence) {
        throw new Error("Cannot complete delivery sequence: none exists.");
      }
      if (sequence.active_rework_issue_id) {
        throw new Error(
          `Cannot complete delivery sequence: active rework is in progress for issue '${sequence.active_rework_issue_id}'.`,
        );
      }
      if (
        decision.currentIssueId != null &&
        String(decision.currentIssueId).trim() !== rootIssueId
      ) {
        throw new Error(
          `Cannot combine completeSequence with non-root currentIssue '${String(decision.currentIssueId).trim()}'. Expected root issue '${rootIssueId}'.`,
        );
      }

      const unlanded = sequence.items.filter(
        (i) => !i.landed || !i.land_receipt_path || !i.land_dispatch_id,
      );
      if (unlanded.length > 0) {
        throw new Error(
          `Cannot complete delivery sequence: issues without landing evidence: ${unlanded.map((i) => i.issue_id).join(", ")}.`,
        );
      }

      // Validate accepted landing references (Section 10.4, F17)
      for (const item of sequence.items) {
        const rec = (completedStages ?? []).find(
          (e) => e.dispatch_id === item.land_dispatch_id,
        );
        if (!rec) {
          throw new WorkflowIntegrityError(
            `Cannot complete delivery sequence: accepted landing dispatch '${item.land_dispatch_id}' for issue '${item.issue_id}' not found in completed stages.`,
          );
        }
      }

      sequence.completed = true;
      currentIssueId = rootIssueId;
    }

    // 5. Next stage resolution
    const resolvedNextStage = decision.nextStage
      ? resolveCanonicalStage(workflow, decision.nextStage).id
      : undefined;

    nextDeliveryState.currentIssueId = currentIssueId;
    nextDeliveryState.rootLandingEvidence = nextRootLandingEvidence;

    return {
      nextDeliveryState,
      nextStage: resolvedNextStage,
    };
  }

  throw new Error(
    `Unsupported delivery decision kind: '${(decision as { kind: string })?.kind}'.`,
  );
}
