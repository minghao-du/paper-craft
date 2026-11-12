import type {
  ApplyDeliveryDecisionParams,
  ApplyDeliveryDecisionResult,
  CalculateDeliveryChangeParams,
  CompletionRecordView,
  DeliveryCalculationResult,
  DeliveryDecision,
  DeliveryItem,
  DeliverySequence,
  DeliveryState,
  IssueBudgets,
  PlanningSource,
  WorkflowBudgets,
  WorkflowDefinition,
  WorkflowStage,
} from "./types.js";

export { assertCanFinish, inspectDelivery } from "./completion.js";

const LANDING_PROVIDER = "pc-pr-land";

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

export function resolveCanonicalStage(
  workflow: WorkflowDefinition,
  stageRef: string,
): WorkflowStage {
  const trimmed = stageRef.trim();
  const byId = workflow.stages.find((s) => s.id === trimmed);
  if (byId) return byId;
  const byLogical = workflow.stages.filter((s) => s.logical_task === trimmed);
  if (byLogical.length === 1) return byLogical[0];
  if (byLogical.length > 1) {
    const candidates = byLogical.map((s) => s.id).join(", ");
    throw new Error(
      `Ambiguous stage reference '${trimmed}': matches multiple stages (${candidates}). Please provide explicit stage ID.`,
    );
  }
  throw new Error(`Unknown stage reference '${trimmed}' in workflow.`);
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

function makeDeliverySequence(
  ids: string[],
  max: number,
  initialStage: string,
): DeliverySequence {
  return {
    items: ids.map((issue_id) => ({
      issue_id,
      stage: initialStage,
      status: "pending",
      budgets: {
        delivery_attempts_used: 0,
        delivery_attempts_max: max,
        replans_used: 0,
        replans_max: 2,
        replans_by_stage: {},
      },
      landed: false,
    })),
    current_index: 0,
    completed: false,
  };
}

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
  // Input immutability (W04): clone deliveryState completely
  const nextDeliveryState: DeliveryState = structuredClone(deliveryState);
  const rootIssueId = String(nextDeliveryState.rootIssueId).trim();

  const isAuxiliary = Boolean(
    stageDef.auxiliary ||
      ["workspace_prepare", "workspace_cleanup"].includes(stageDef.id),
  );
  const isReplan = Boolean(
    stageDef.replan ||
      stageDef.id === "scope_replan" ||
      stageDef.logical_task === "scope_replan",
  );

  // 1. Issue ownership (Section 8.2)
  const designated =
    request.rework_issue != null && request.rework_issue.trim() !== ""
      ? String(request.rework_issue).trim()
      : null;

  let targetIssueId: string;

  if (designated !== null) {
    // Priority 1: Explicit rework_issue
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
    // Priority 2: Existing active_rework_issue_id
    targetIssueId = String(nextDeliveryState.sequence.active_rework_issue_id);
  } else if (
    nextDeliveryState.sequence &&
    !nextDeliveryState.sequence.completed
  ) {
    // Priority 3: Normal unfinished delivery sequence (including replan stages, W06)
    const curIdx = nextDeliveryState.sequence.current_index ?? 0;
    const curItem = nextDeliveryState.sequence.items?.[curIdx];
    targetIssueId = curItem ? String(curItem.issue_id) : rootIssueId;
  } else {
    // Priority 4: Root-level task or sequence completed
    targetIssueId = rootIssueId;
  }

  // Find target item (if child) and authoritative budget
  const targetItem =
    nextDeliveryState.sequence?.items?.find(
      (i) => String(i.issue_id) === targetIssueId,
    ) ?? null;

  const targetBudgets: IssueBudgets = targetItem
    ? (targetItem.budgets ??= {
        delivery_attempts_used: 0,
        delivery_attempts_max:
          nextDeliveryState.rootBudgets.delivery_attempts_max ?? 3,
        replans_used: 0,
        replans_max: nextDeliveryState.rootBudgets.replans_max ?? 2,
        replans_by_stage: {},
      })
    : nextDeliveryState.rootBudgets;

  let attempt: number;
  let deliveryAttempt: number;
  let originStage: string | undefined;

  // 2. Budget calculations by stage type
  if (isReplan) {
    // Replan stage (Section 8.4 & W06)
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
        const def = workflow.stages.find(
          (s) => s.id === e.stage || s.logical_task === e.stage,
        );
        if (!def) return false;
        if (
          def.auxiliary ||
          ["workspace_prepare", "workspace_cleanup"].includes(def.id)
        ) {
          return false;
        }
        if (
          def.replan ||
          def.id === "scope_replan" ||
          def.logical_task === "scope_replan"
        ) {
          return false;
        }
        return true;
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
    if (
      originDef.replan ||
      originDef.id === "scope_replan" ||
      originDef.logical_task === "scope_replan"
    ) {
      throw new Error(
        `Replan stage '${originDef.id}' cannot be its own originating stage.`,
      );
    }

    const replanMax =
      targetBudgets.replans_max ??
      nextDeliveryState.rootBudgets.replans_max ??
      2;
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
  } else if (isAuxiliary) {
    // Auxiliary stage (Section 8.3)
    const used = targetBudgets.delivery_attempts_used ?? 0;
    attempt = Math.max(1, used);
    deliveryAttempt = used;
  } else {
    // Ordinary Delivery Stage
    const isExplicitRework = designated !== null;
    const isActiveRework = Boolean(
      nextDeliveryState.sequence?.active_rework_issue_id,
    );
    const isFirstStartingRework =
      isExplicitRework &&
      nextDeliveryState.sequence?.active_rework_issue_id !== designated;

    if (isFirstStartingRework) {
      // First starting rework requires attempt_intent: "new" (Section 9.2)
      if (request.attempt_intent !== "new") {
        throw new Error(
          `Starting rework on issue '${designated}' requires attempt_intent: 'new'.`,
        );
      }
      const used = targetBudgets.delivery_attempts_used ?? 0;
      const max = targetBudgets.delivery_attempts_max ?? 3;
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
      // Continuing active rework
      if (request.attempt_intent === "new") {
        const used = targetBudgets.delivery_attempts_used ?? 0;
        const max = targetBudgets.delivery_attempts_max ?? 3;
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
      // Normal delivery
      if (targetItem?.landed && request.attempt_intent !== "new") {
        throw new Error(
          `Issue '${targetIssueId}' is already landed. Modifying an already landed issue requires attempt_intent: 'new'.`,
        );
      }

      const used = targetBudgets.delivery_attempts_used ?? 0;
      const max = targetBudgets.delivery_attempts_max ?? 3;

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
    nextDeliveryState.rootBudgets = structuredClone(
      nextDeliveryState.sequence.items[0].budgets,
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
      delivery_attempts_max: targetBudgets.delivery_attempts_max ?? 3,
      replans_used: targetBudgets.replans_used ?? 0,
      replans_max: targetBudgets.replans_max ?? 2,
      replans_by_stage: targetBudgets.replans_by_stage,
    },
    nextDeliveryState,
  };
}

export function calculateDeliveryChange(
  params: CalculateDeliveryChangeParams,
): DeliveryCalculationResult {
  const sequence = params.deliverySequence
    ? structuredClone(params.deliverySequence)
    : null;
  let currentItem: DeliveryItem | null = null;
  let currentIssue = params.currentIssueId ?? params.rootIssueId ?? "0";

  const designated =
    params.reworkIssue == null ? null : String(params.reworkIssue).trim();

  if (designated !== null) {
    currentItem =
      sequence?.items?.find((item) => String(item.issue_id) === designated) ??
      null;
    if (!currentItem && String(params.rootIssueId) !== designated) {
      throw new Error(
        `Cannot attribute rework to issue '${designated}': issue not found in delivery sequence. Gaps that cannot be attributed to an existing issue must be routed to replanning; do not guess attribution or replace plan.`,
      );
    }
    if (currentItem && sequence) {
      sequence.active_rework_issue_id = designated;
    }
    currentIssue = designated;
  } else if (sequence?.active_rework_issue_id && !params.intent.replan) {
    currentIssue = String(sequence.active_rework_issue_id);
    currentItem =
      sequence.items?.find((item) => String(item.issue_id) === currentIssue) ??
      null;
  } else if (sequence && !sequence.completed && !params.intent.replan) {
    currentItem = sequence.items?.[sequence.current_index ?? 0] ?? null;
    if (currentItem) {
      currentIssue = currentItem.issue_id;
    }
  }

  const budgets = structuredClone(params.budgets);
  let attempt: number;
  let deliveryUsed: number;
  let deliveryMax: number;
  let replanUsed: number;
  let replanMax: number;
  let nextOriginatingStage = params.originatingStageForReplan ?? null;

  if (params.intent.replan) {
    let originStage = params.parameters?.originating_stage as
      | string
      | undefined;
    if (!originStage) {
      if (
        params.originatingStageForReplan &&
        params.originatingStageForReplan !== "scope_replan"
      ) {
        originStage = params.originatingStageForReplan;
      } else {
        originStage = "stage_1_plan";
      }
    }
    nextOriginatingStage = originStage;

    const target = currentItem
      ? (currentItem.budgets ??= {
          delivery_attempts_used: 0,
          delivery_attempts_max: budgets.delivery_attempts_max ?? 3,
        })
      : budgets;

    const byStage = (target.replans_by_stage ??= {});
    const used = byStage[originStage] ?? 0;
    const max = target.replans_max ?? budgets.replans_max ?? 2;
    if (max <= 0 || used >= max) {
      throw new Error(
        `Budget exceeded: replans used (${used}) reached maximum (${max}) for issue ${currentIssue} and stage ${originStage}.`,
      );
    }
    byStage[originStage] = used + 1;
    target.replans_used = (target.replans_used ?? 0) + 1;
    if (currentItem) {
      budgets.replans_used = (budgets.replans_used ?? 0) + 1;
    }
    attempt = used + 1;
    deliveryUsed =
      target.delivery_attempts_used ?? budgets.delivery_attempts_used ?? 0;
    deliveryMax =
      target.delivery_attempts_max ?? budgets.delivery_attempts_max ?? 3;
    replanUsed = attempt;
    replanMax = max;
  } else {
    const target = currentItem
      ? (currentItem.budgets ??= {
          delivery_attempts_used: 0,
          delivery_attempts_max: budgets.delivery_attempts_max ?? 3,
        })
      : budgets;

    if (currentItem) {
      nextOriginatingStage = null;
    }
    const used = target.delivery_attempts_used ?? 0;
    const max =
      target.delivery_attempts_max ?? budgets.delivery_attempts_max ?? 3;
    if (max <= 0) {
      throw new Error(
        `Budget exceeded: delivery attempts max (${max}) is exhausted${currentItem ? ` for issue ${currentIssue}` : ""}.`,
      );
    }
    if (params.intent.auxiliary) {
      attempt = Math.max(1, used);
    } else if (used === 0 || params.attemptIntent === "new") {
      if (used >= max) {
        throw new Error(
          `Budget exceeded: delivery attempts used (${used}) reached maximum (${max})${currentItem ? ` for issue ${currentIssue}` : ""}.`,
        );
      }
      attempt = used + 1;
      target.delivery_attempts_used = attempt;
    } else {
      attempt = used;
    }
    budgets.delivery_attempts_used = target.delivery_attempts_used ?? 0;
    if (currentItem) {
      budgets.delivery_attempts_max = max;
      if (!params.intent.auxiliary) {
        currentItem.stage = params.intent.canonical_stage;
        currentItem.status = "pending";
      }
    }
    deliveryUsed = target.delivery_attempts_used ?? 0;
    deliveryMax = max;
    replanUsed = target.replans_used ?? budgets.replans_used ?? 0;
    replanMax = target.replans_max ?? budgets.replans_max ?? 2;
  }

  return {
    current_issue_id: String(currentIssue),
    attempt,
    delivery_attempts_used: deliveryUsed,
    delivery_attempts_max: deliveryMax,
    replan_attempts_used: replanUsed,
    replan_attempts_max: replanMax,
    budgets,
    delivery_sequence: sequence ?? undefined,
    originating_stage_for_replan: nextOriginatingStage,
  };
}

function assertLandingEvidence(
  params: ApplyDeliveryDecisionParams,
  issue: string,
  dispatchId: string,
  currentAttempt: number,
): { receipt_path: string } {
  const record = (params.completedStages ?? []).find(
    (e) => e.dispatch_id === dispatchId,
  );
  if (!record) {
    throw new Error(
      `Landing dispatch '${dispatchId}' not found in completed stages.`,
    );
  }
  if (record.issue_id == null || String(record.issue_id).trim() === "") {
    throw new Error(
      `Landing dispatch '${dispatchId}' lacks issue_id; use a completed record that carries issue_id.`,
    );
  }
  if (String(record.issue_id).trim() !== issue) {
    throw new Error(
      `Landing dispatch '${dispatchId}' belongs to issue '${String(record.issue_id)}', not '${issue}'.`,
    );
  }

  const stageDef = resolveCanonicalStage(
    params.workflow,
    record.stage ?? "stage_2_land",
  );
  const landingProvider = record.provider?.target ?? stageDef?.provider?.target;
  if (landingProvider !== LANDING_PROVIDER) {
    throw new Error(
      `Landing dispatch '${dispatchId}' stage '${String(record.stage)}' is not a '${LANDING_PROVIDER}' stage in the workflow.`,
    );
  }

  const result = (record.result ?? {}) as Record<string, unknown>;
  const nonEmpty = (v: unknown): boolean =>
    typeof v === "string" && v.trim() !== "";
  if (
    record.execution_status !== "succeeded" ||
    result.outcome !== "landed" ||
    result.merged !== true ||
    !nonEmpty(result.mergedCommit)
  ) {
    throw new Error(
      `Landing dispatch '${dispatchId}' does not satisfy the landed outcome contract (requires succeeded, outcome 'landed', merged true, mergedCommit).`,
    );
  }
  if (!nonEmpty(record.receipt_path)) {
    throw new Error(`Landing dispatch '${dispatchId}' has no receipt_path.`);
  }

  // W05: delivery attempt must match target's current delivery attempt
  if (
    record.delivery_attempt != null &&
    record.delivery_attempt !== currentAttempt
  ) {
    throw new Error(
      `Landing dispatch '${dispatchId}' delivery attempt (${record.delivery_attempt}) does not match current delivery attempt (${currentAttempt}) for issue '${issue}'.`,
    );
  }

  // Freshness check: Subsequent work in the same attempt invalidates previous landing
  const recordStep = record.step_index ?? -1;
  const subsequentWork = (params.completedStages ?? []).find((e) => {
    if (String(e.issue_id).trim() !== issue) return false;
    const eAttempt = e.delivery_attempt ?? currentAttempt;
    if (eAttempt !== currentAttempt) return false;
    if ((e.step_index ?? -1) <= recordStep) return false;
    const def = params.workflow.stages.find(
      (s) => s.id === e.stage || s.logical_task === e.stage,
    );
    const isWork =
      def?.id === "stage_2_work" ||
      def?.logical_task === "issue_work" ||
      def?.provider?.target === "pc-issue-work";
    return isWork;
  });

  if (subsequentWork) {
    throw new Error(
      `Landing dispatch '${dispatchId}' has been invalidated by subsequent work at step ${subsequentWork.step_index}.`,
    );
  }

  return { receipt_path: record.receipt_path as string };
}

export function applyDeliveryDecision(
  params: ApplyDeliveryDecisionParams,
): ApplyDeliveryDecisionResult {
  // Input immutability (W04): work strictly on cloned state
  let deliverySequence = params.deliveryState?.sequence
    ? structuredClone(params.deliveryState.sequence)
    : params.deliverySequence
      ? structuredClone(params.deliverySequence)
      : undefined;

  const rootIssueId = String(
    params.deliveryState?.rootIssueId ?? params.rootIssueId ?? "0",
  ).trim();
  let currentIssueId =
    params.deliveryState?.currentIssueId ?? params.currentIssueId ?? rootIssueId;

  const rawBudgets = params.deliveryState?.rootBudgets ?? params.budgets ?? {
    delivery_attempts_used: 0,
    delivery_attempts_max: 3,
    replans_used: 0,
    replans_max: 2,
  };
  const budgets: WorkflowBudgets = structuredClone(rawBudgets);

  let nextStage: string | undefined = params.nextStage ?? undefined;
  let planningSource = params.planningSource;
  let markLanded = params.markLanded;
  let landingDispatchId = params.landingDispatchId;
  let completeSequence = params.completeSequence;
  let currentIssue = params.currentIssue;

  // Unify modern DeliveryDecision
  if (
    typeof params.decision === "object" &&
    params.decision !== null &&
    "kind" in params.decision
  ) {
    const dec = params.decision as DeliveryDecision;
    if (dec.kind === "accept_plan") {
      const record = (params.completedStages ?? []).find(
        (e) => e.dispatch_id === dec.planDispatchId,
      );
      if (!record) {
        throw new Error(
          `Planning dispatch '${dec.planDispatchId}' not found in completed stages.`,
        );
      }
      planningSource = {
        dispatch_id: dec.planDispatchId,
        stage: record.stage ?? "stage_1_plan",
        step_index: record.step_index ?? 0,
        execution_status: record.execution_status ?? "succeeded",
        provider: record.provider,
        result: (record.result ?? {}) as Record<string, unknown>,
        receipt_path: record.receipt_path ?? "",
        issue_id: record.issue_id,
      };
      nextStage = dec.nextStage;
    } else if (dec.kind === "update_delivery") {
      nextStage = dec.nextStage ?? nextStage;
      currentIssue = dec.currentIssueId ?? currentIssue;
      if (dec.landing) {
        markLanded = dec.landing.issueId;
        landingDispatchId = dec.landing.dispatchId;
      }
      if (dec.completeSequence !== undefined) {
        completeSequence = dec.completeSequence;
      }
    }
  }

  // Plan acceptance (accept_plan / planningSource)
  if (planningSource) {
    if (deliverySequence) {
      throw new Error("Cannot accept plan: delivery sequence already exists.");
    }
    if (currentIssue != null) {
      throw new Error("Cannot combine planningSource with currentIssue.");
    }
    if (markLanded != null || landingDispatchId != null || completeSequence) {
      throw new Error(
        "Cannot combine planningSource with landing or sequence completion.",
      );
    }

    // Section 14: accept_plan requires explicit nextStage, omitting it is rejected
    if (!nextStage || typeof nextStage !== "string" || !nextStage.trim()) {
      throw new Error(
        "Plan acceptance requires an explicit non-empty 'nextStage'.",
      );
    }
    const nextStageDef = resolveCanonicalStage(params.workflow, nextStage);
    const initialStage = nextStageDef.id;

    const ps = planningSource;
    if (
      !ps.result ||
      typeof ps.result !== "object" ||
      Array.isArray(ps.result)
    ) {
      throw new Error("Planning result must be an object.");
    }
    const outcome = ps.result.outcome;
    if (outcome !== "direct" && outcome !== "decomposed") {
      throw new Error(
        `Planning outcome must be 'direct' or 'decomposed', got '${String(outcome)}'.`,
      );
    }

    if (outcome === "direct") {
      const planObj = ps.result.plan as Record<string, unknown> | undefined;
      const directTasks =
        planObj?.tasks ??
        (Array.isArray(ps.result.plan) ? ps.result.plan : undefined) ??
        ps.result.tasks;
      if (Array.isArray(directTasks) && directTasks.length > 0) {
        throw new Error("Direct planning outcome cannot contain tasks.");
      }

      deliverySequence = makeDeliverySequence(
        [rootIssueId],
        budgets.delivery_attempts_max ?? 3,
        initialStage,
      );
      const rootItem = deliverySequence.items[0];
      rootItem.budgets.delivery_attempts_used = 0;
      rootItem.budgets.delivery_attempts_max =
        budgets.delivery_attempts_max ?? 3;
      rootItem.budgets.replans_used = budgets.replans_used ?? 0;
      rootItem.budgets.replans_max = budgets.replans_max ?? 2;
      if (budgets.replans_by_stage) {
        rootItem.budgets.replans_by_stage = structuredClone(
          budgets.replans_by_stage,
        );
      }
      budgets.delivery_attempts_used = 0;
      currentIssueId = rootIssueId;
      deliverySequence.current_index = 0;
      deliverySequence.completed = false;
    } else {
      const planObj = ps.result.plan;
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
        budgets.delivery_attempts_max ?? 3,
        initialStage,
      );
      budgets.delivery_attempts_used = 0;
      currentIssueId = taskIds[0];
      deliverySequence.current_index = 0;
      deliverySequence.completed = false;
    }
  }

  // Update currentIssue
  if (currentIssue != null) {
    const issue = String(currentIssue).trim();
    currentIssueId = issue;
    if (deliverySequence) {
      if (deliverySequence.active_rework_issue_id !== issue) {
        deliverySequence.active_rework_issue_id = null;
      }
      const index = deliverySequence.items.findIndex(
        (i) => String(i.issue_id) === issue,
      );
      if (index >= 0) {
        deliverySequence.current_index = index;
        const itemBudgets = (deliverySequence.items[index].budgets ??= {
          delivery_attempts_used: 0,
          delivery_attempts_max: budgets.delivery_attempts_max ?? 3,
        });
        budgets.delivery_attempts_used =
          itemBudgets.delivery_attempts_used ?? 0;
        budgets.delivery_attempts_max =
          itemBudgets.delivery_attempts_max ??
          budgets.delivery_attempts_max ??
          3;
      }
    }
  }

  // Landing registration
  if ((markLanded != null) !== (landingDispatchId != null)) {
    throw new Error(
      "markLanded and landingDispatchId must be provided together.",
    );
  }

  let nextRootLandingEvidence = params.deliveryState?.rootLandingEvidence;

  if (markLanded != null) {
    const issue = String(markLanded).trim();
    const dispatchId = String(landingDispatchId).trim();
    if (!deliverySequence) {
      throw new Error(
        `Cannot mark issue '${issue}' landed: no delivery sequence exists.`,
      );
    }
    const item = deliverySequence.items.find(
      (i) => String(i.issue_id) === issue,
    );
    const isRoot = issue === rootIssueId;

    if (!item && !isRoot) {
      throw new Error(
        `Cannot mark issue '${issue}' landed: issue not found in delivery sequence.`,
      );
    }

    const currentAttempt = item
      ? (item.budgets?.delivery_attempts_used ?? 1)
      : (budgets.delivery_attempts_used ?? 1);

    const record = assertLandingEvidence(
      params,
      issue,
      dispatchId,
      currentAttempt,
    );

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
        item.land_receipt_path = record.receipt_path;
        item.landed_attempt = currentAttempt;
      }
    } else if (isRoot) {
      nextRootLandingEvidence = {
        dispatch_id: dispatchId,
        receipt_path: record.receipt_path,
        delivery_attempt: currentAttempt,
      };
    }

    if (deliverySequence.active_rework_issue_id === issue) {
      deliverySequence.active_rework_issue_id = null;
    }
  }

  // Sequence completion
  if (completeSequence) {
    if (!deliverySequence) {
      throw new Error("Cannot complete delivery sequence: none exists.");
    }
    if (deliverySequence.active_rework_issue_id) {
      throw new Error(
        `Cannot complete delivery sequence: active rework is in progress for issue '${deliverySequence.active_rework_issue_id}'.`,
      );
    }
    if (currentIssue != null && String(currentIssue).trim() !== rootIssueId) {
      throw new Error(
        `Cannot combine completeSequence with non-root currentIssue '${String(currentIssue).trim()}'. Expected root issue '${rootIssueId}'.`,
      );
    }

    const unlanded = deliverySequence.items.filter(
      (i) => !i.landed || !i.land_receipt_path || !i.land_dispatch_id,
    );
    if (unlanded.length > 0) {
      throw new Error(
        `Cannot complete delivery sequence: issues without landing evidence: ${unlanded.map((i) => i.issue_id).join(", ")}.`,
      );
    }
    deliverySequence.completed = true;
    currentIssueId = rootIssueId;
  }

  const resolvedNextStage = nextStage
    ? resolveCanonicalStage(params.workflow, nextStage).id
    : undefined;

  const nextDeliveryState: DeliveryState = {
    rootIssueId,
    currentIssueId,
    rootBudgets: budgets,
    sequence: deliverySequence,
    rootLandingEvidence: nextRootLandingEvidence,
  };

  return {
    nextDeliveryState,
    nextStage: resolvedNextStage,
    deliverySequence,
    currentIssueId,
    budgets,
  };
}
