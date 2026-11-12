import { DEFAULT_RECEIPT_TEMPLATE, resolveCanonicalStage } from "./definition.js";
import { calculateDeliveryDispatch } from "./delivery.js";
import type {
  DispatchEvaluation,
  EvaluateDispatchParams,
  EvaluatedTask,
  SkillProvider,
  WorkflowDefinition,
  WorkflowStage,
} from "./types.js";

function isEvidenceSensitiveStage(
  stageDef: WorkflowStage,
  workflow: WorkflowDefinition,
): boolean {
  if (stageDef.replan) {
    return true;
  }
  if (workflow.initial_stage && stageDef.id === workflow.initial_stage) {
    return true;
  }
  const sensitiveLogicalTasks = new Set([
    "issue_plan",
    "scope_replan",
    "issue_land",
    "pipeline_refactor_redeliver",
    "issue_finalize",
    "workspace_cleanup",
  ]);
  if (stageDef.logical_task && sensitiveLogicalTasks.has(stageDef.logical_task)) {
    return true;
  }
  const sensitiveIds = new Set([
    "workspace_cleanup",
    "issue_finalize",
    "scope_replan",
    "stage_1_plan",
    "stage_2_land",
    "stage_5_redeliver",
  ]);
  if (sensitiveIds.has(stageDef.id)) {
    return true;
  }
  return false;
}

/**
 * Pure domain evaluation for task dispatch.
 * Resolves canonical stage, verifies provider override rules, merges parameters,
 * evaluates delivery state changes, and produces an EvaluatedTask.
 * Leaves all inputs completely unmodified.
 */
export function evaluateDispatch(
  params: EvaluateDispatchParams,
): DispatchEvaluation {
  const {
    workflow,
    deliveryState,
    request,
    environmentDefaults,
    completedStages,
  } = params;

  // 1. Resolve canonical stage definition
  const stageDef = resolveCanonicalStage(workflow, request.stage);

  // 2. Check provider override rules (Section 5.3)
  let resolvedProvider: SkillProvider;
  const isSensitive = isEvidenceSensitiveStage(stageDef, workflow);

  if (isSensitive) {
    if (request.provider) {
      if (
        (request.provider.type &&
          request.provider.type !== stageDef.provider?.type) ||
        (request.provider.target &&
          request.provider.target !== stageDef.provider?.target)
      ) {
        throw new Error(
          `Cannot override provider for evidence-sensitive stage '${stageDef.id}'.`,
        );
      }
      resolvedProvider = {
        type: "skill",
        target: stageDef.provider!.target,
        args: request.provider.args
          ? [...request.provider.args]
          : stageDef.provider?.args
            ? [...stageDef.provider.args]
            : [],
      };
    } else {
      resolvedProvider = {
        type: "skill",
        target: stageDef.provider!.target,
        args: stageDef.provider?.args ? [...stageDef.provider.args] : [],
      };
    }
  } else {
    // Ordinary stages allow provider override
    if (request.provider) {
      const pType = request.provider.type ?? "skill";
      if (pType !== "skill") {
        throw new Error(`Provider 'type' must be 'skill', received '${pType}'`);
      }
      if (!request.provider.target || !request.provider.target.trim()) {
        throw new Error("Provider 'target' must be a non-empty string.");
      }
      resolvedProvider = {
        type: "skill",
        target: request.provider.target.trim(),
        args: request.provider.args ? [...request.provider.args] : [],
      };
    } else {
      resolvedProvider = {
        type: "skill",
        target: stageDef.provider!.target,
        args: stageDef.provider?.args ? [...stageDef.provider.args] : [],
      };
    }
  }

  // 3. Resolve scope (Section 5.2)
  if (request.scope === null) {
    throw new Error("Dispatch request 'scope' cannot be null.");
  }
  let resolvedScope: string;
  if (request.scope !== undefined) {
    if (typeof request.scope !== "string") {
      throw new Error("Dispatch request 'scope' must be a string.");
    }
    resolvedScope = request.scope;
  } else {
    resolvedScope = stageDef.scope ?? "";
  }

  // 4. Resolve receipt_template (Section 5.2)
  if (request.receipt_template === null) {
    throw new Error("Dispatch request 'receipt_template' cannot be null.");
  }
  let resolvedReceiptTemplate: string;
  if (request.receipt_template !== undefined) {
    if (
      typeof request.receipt_template !== "string" ||
      !request.receipt_template.trim()
    ) {
      throw new Error(
        "Dispatch request 'receipt_template' cannot be empty string.",
      );
    }
    resolvedReceiptTemplate = request.receipt_template.trim();
  } else {
    resolvedReceiptTemplate =
      stageDef.receipt_template ||
      stageDef.template ||
      DEFAULT_RECEIPT_TEMPLATE;
  }

  // 5. Parameter merging (Section 5.1):
  // defaults (from environmentDefaults) -> stage.parameters -> stage.configs -> request.parameters
  const envKeys = [
    "delivery_target",
    "base_remote",
    "push_remote",
    "worktree_container",
  ] as const;
  for (const key of envKeys) {
    const reqVal = request.parameters?.[key];
    const envVal = environmentDefaults?.[key];
    if (
      reqVal !== undefined &&
      reqVal !== null &&
      envVal !== undefined &&
      envVal !== null
    ) {
      if (reqVal !== envVal) {
        throw new Error(
          `Conflicting parameter '${key}': request specified '${String(reqVal)}', but run environment is '${String(envVal)}'.`,
        );
      }
    }
  }

  const mergedParameters: Record<string, unknown> = {};
  if (environmentDefaults) {
    for (const [key, value] of Object.entries(environmentDefaults)) {
      if (value !== undefined) {
        mergedParameters[key] = value;
      }
    }
  }
  if (stageDef.parameters) {
    for (const [key, value] of Object.entries(stageDef.parameters)) {
      mergedParameters[key] = value;
    }
  }
  if (stageDef.configs) {
    for (const [key, value] of Object.entries(stageDef.configs)) {
      mergedParameters[key] = value;
    }
  }
  if (request.parameters) {
    for (const [key, value] of Object.entries(request.parameters)) {
      mergedParameters[key] = value;
    }
  }

  // 6. Resolve originating_stage if replan or provided
  const rawOriginating =
    request.originating_stage ??
    (request.parameters?.originating_stage as string | undefined);
  let canonicalOriginating: string | undefined;
  if (rawOriginating) {
    const originStageDef = resolveCanonicalStage(workflow, rawOriginating);
    if (originStageDef.replan) {
      throw new Error(
        `Invalid originating_stage '${rawOriginating}': replan stage cannot originate from another replan stage.`,
      );
    }
    canonicalOriginating = originStageDef.id;
  }

  // 7. Calculate delivery dispatch
  const deliveryResult = calculateDeliveryDispatch(
    workflow,
    deliveryState,
    stageDef,
    {
      attempt_intent: request.attempt_intent,
      rework_issue: request.rework_issue,
      originating_stage: canonicalOriginating,
    },
    completedStages,
  );

  // 8. Assemble EvaluatedTask and return
  const task: EvaluatedTask = {
    stage: stageDef.id,
    logicalTask: stageDef.logical_task!,
    provider: resolvedProvider,
    auxiliary: Boolean(stageDef.auxiliary),
    replan: Boolean(stageDef.replan),
    issueId: deliveryResult.currentIssueId,
    attempt: deliveryResult.attempt,
    deliveryAttempt: deliveryResult.deliveryAttempt,
    originatingStage: deliveryResult.originatingStage ?? canonicalOriginating,
    receiptTemplate: resolvedReceiptTemplate,
    scope: resolvedScope,
    parameters: mergedParameters,
    budgets: deliveryResult.budgets,
  };

  return {
    task,
    nextDeliveryState: deliveryResult.nextDeliveryState,
  };
}
