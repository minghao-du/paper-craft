import type {
  ApplyDeliveryDecisionParams,
  ApplyDeliveryDecisionResult,
  AssertCanFinishParams,
  CalculateDeliveryChangeParams,
  DeliveryCalculationResult,
  DeliveryItem,
  DeliverySequence,
  WorkflowBudgets,
} from "./types.js";

const LANDING_PROVIDER = "pc-pr-land";

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
      budgets: { delivery_attempts_used: 0, delivery_attempts_max: max },
      landed: false,
    })),
    current_index: 0,
    completed: false,
  };
}

export function calculateDeliveryChange(
  params: CalculateDeliveryChangeParams,
): DeliveryCalculationResult {
  const sequence = params.deliverySequence ?? null;
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

  const budgets = params.budgets;
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
  const stageDef = params.workflow.stages.find((s) => s.id === record.stage);
  if (stageDef?.provider?.target !== LANDING_PROVIDER) {
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
  return { receipt_path: record.receipt_path as string };
}

export function applyDeliveryDecision(
  params: ApplyDeliveryDecisionParams,
): ApplyDeliveryDecisionResult {
  // Work on clones so a thrown validation error leaves caller state untouched.
  let deliverySequence = params.deliverySequence
    ? structuredClone(params.deliverySequence)
    : undefined;
  let currentIssueId = params.currentIssueId;
  const budgets: WorkflowBudgets = structuredClone(params.budgets);

  if (params.planningSource) {
    if (deliverySequence) {
      throw new Error("Cannot accept plan: delivery sequence already exists.");
    }
    if (params.currentIssue != null) {
      throw new Error("Cannot combine planningSource with currentIssue.");
    }
    if (
      params.markLanded != null ||
      params.landingDispatchId != null ||
      params.completeSequence
    ) {
      throw new Error(
        "Cannot combine planningSource with landing or sequence completion.",
      );
    }

    const ps = params.planningSource;
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

    const initialStage = params.nextStage || "stage_2_work";

    if (outcome === "direct") {
      const planObj = ps.result.plan as Record<string, unknown> | undefined;
      const directTasks =
        planObj?.tasks ??
        (Array.isArray(ps.result.plan) ? ps.result.plan : undefined) ??
        ps.result.tasks;
      if (Array.isArray(directTasks) && directTasks.length > 0) {
        throw new Error("Direct planning outcome cannot contain tasks.");
      }

      const rootId = String(params.rootIssueId ?? "0").trim();
      deliverySequence = makeDeliverySequence(
        [rootId],
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
      currentIssueId = rootId;
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

      const taskIds = validatePlanOrder(rawTasks, params.rootIssueId);
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

  if (params.currentIssue != null) {
    const issue = String(params.currentIssue).trim();
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

  if ((params.markLanded != null) !== (params.landingDispatchId != null)) {
    throw new Error(
      "markLanded and landingDispatchId must be provided together.",
    );
  }

  if (params.markLanded != null) {
    const issue = String(params.markLanded).trim();
    const dispatchId = String(params.landingDispatchId).trim();
    if (!deliverySequence) {
      throw new Error(
        `Cannot mark issue '${issue}' landed: no delivery sequence exists.`,
      );
    }
    const item = deliverySequence.items.find(
      (i) => String(i.issue_id) === issue,
    );
    if (!item) {
      throw new Error(
        `Cannot mark issue '${issue}' landed: issue not found in delivery sequence.`,
      );
    }
    const record = assertLandingEvidence(params, issue, dispatchId);
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
    }
    if (deliverySequence.active_rework_issue_id === issue) {
      deliverySequence.active_rework_issue_id = null;
    }
  }

  if (params.completeSequence) {
    if (!deliverySequence) {
      throw new Error("Cannot complete delivery sequence: none exists.");
    }
    if (!deliverySequence.completed) {
      const unlanded = deliverySequence.items.filter(
        (i) => !i.landed || !i.land_receipt_path || !i.land_dispatch_id,
      );
      if (unlanded.length) {
        throw new Error(
          `Cannot complete delivery sequence: issues without landing evidence: ${unlanded.map((i) => i.issue_id).join(", ")}.`,
        );
      }
      deliverySequence.completed = true;
      currentIssueId = String(params.rootIssueId ?? "0");
    }
  }

  return {
    deliverySequence,
    currentIssueId,
    budgets,
  };
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
  const stages = params.completedStages ?? [];
  const lastStage = stages.at(-1);
  if (lastStage?.result?.outcome === "rework_needed") {
    throw new Error(
      `Cannot finish workflow: last completed stage '${lastStage.stage}' resulted in 'rework_needed', which is not accepted as business pass. Rework must be routed.`,
    );
  }

  if (params.workflow.completion_policy === "basic") {
    return;
  }

  if (params.workflow.completion_policy === "issue_delivery") {
    const closure =
      stages
        .filter(
          (e) =>
            e.stage === "issue_finalize" &&
            e.execution_status === "succeeded" &&
            e.result?.scope === "tree",
        )
        .at(-1) ?? {};
    const evidence = (closure.result ?? {}) as Record<string, unknown>;
    const issues = (evidence.issues as Array<Record<string, unknown>>) ?? [];
    const root = String(params.rootIssueId);

    if (
      evidence.outcome !== "finalized" ||
      String(evidence.root_issue_id) !== root ||
      !Array.isArray(issues) ||
      !issues.length ||
      !issues.every(
        (i) => i && i.state === "CLOSED" && i.repository && i.acceptance_receipt,
      ) ||
      !issues.some((i) => String(i.number) === root)
    ) {
      throw new Error(
        "Cannot finish workflow: verified issue-tree closure evidence is missing.",
      );
    }

    const latest = stages.at(-1) ?? {};
    const result = (latest.result ?? {}) as Record<string, unknown>;
    const empty = (v: unknown): boolean => Array.isArray(v) && v.length === 0;

    if (
      latest.stage !== "workspace_cleanup" ||
      latest.execution_status !== "succeeded" ||
      result.outcome !== "cleaned" ||
      !empty(result.retained_paths) ||
      !empty(result.retained_branches) ||
      !empty(evidence.unresolved) ||
      ((latest.step_index as number | undefined) ?? -1) <=
        ((closure.step_index as number | undefined) ?? -1)
    ) {
      throw new Error(
        "Cannot finish workflow: delivery complete / cleanup incomplete.",
      );
    }

    if (!Array.isArray(evidence.candidates)) {
      throw new Error(
        "Cannot finish workflow: reconciled cleanup inventory is missing.",
      );
    }

    const closureIndex = stages.indexOf(closure);
    const after = stages.slice(closureIndex + 1);
    const cleanups = after
      .filter(
        (e) =>
          e.stage === "workspace_cleanup" && e.execution_status === "succeeded",
      )
      .map((e) => (e.result ?? {}) as Record<string, unknown>);

    const paths = new Set(
      cleanups.flatMap((r) => (r.removed_paths as string[]) ?? []),
    );
    const branches = cleanups.flatMap(
      (r) => (r.removed_branches as Array<Record<string, unknown>>) ?? [],
    );

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
              b.branch === branch && b.scope === "local" && b.remote == null,
          ) ||
            !branches.some(
              (b) =>
                b.branch === branch &&
                b.scope === "remote" &&
                b.remote === pushRemote,
            )))
      ) {
        throw new Error(
          "Cannot finish workflow: reconciled resource lacks cleanup evidence.",
        );
      }
    }

    if (after.some((e) => e.stage !== "workspace_cleanup")) {
      throw new Error(
        "Cannot finish workflow: repeat issue finalization after intervening work.",
      );
    }
    return;
  }

  throw new Error(
    `Cannot finish workflow: unsupported completion policy '${params.workflow.completion_policy}'.`,
  );
}
