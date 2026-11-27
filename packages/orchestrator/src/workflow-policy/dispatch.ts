import { DEFAULT_RECEIPT_TEMPLATE } from "./definition.js";
import { calculateDeliveryDispatch } from "./delivery.js";
import {
  isAuxiliaryStage,
  isReplanStage,
  resolveCanonicalStage,
  validateProviderOverride,
} from "./stage.js";
import type {
  DispatchEvaluation,
  EvaluateDispatchParams,
  EvaluatedTask,
} from "./types.js";

const PROTECTED_RUN_KEYS = [
  "delivery_target",
  "base_remote",
  "push_remote",
  "worktree_container",
] as const;

/**
 * Validates protected run environment parameters across all sources:
 * environmentDefaults, stage.parameters, stage.configs, request.parameters.
 *
 * Rules (Section 8.1):
 * - If a run value is supplied, it is authoritative.
 * - Conflicting non-empty declarations across any sources are rejected.
 * - Repeating equal values is allowed.
 * - null cannot clear a fixed run value and is rejected for protected fields.
 */
function validateAndResolveProtectedParams(
  environmentDefaults?: Record<string, unknown>,
  stageParameters?: Record<string, unknown>,
  stageConfigs?: Record<string, unknown>,
  requestParameters?: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  const sources: Array<{ name: string; params?: Record<string, unknown> }> = [
    { name: "environmentDefaults", params: environmentDefaults },
    { name: "stage parameters", params: stageParameters },
    { name: "stage configs", params: stageConfigs },
    { name: "request parameters", params: requestParameters },
  ];

  for (const key of PROTECTED_RUN_KEYS) {
    let establishedSource: string | undefined;
    let establishedValue: unknown;

    for (const source of sources) {
      if (!source.params || !(key in source.params)) {
        continue;
      }
      const val = source.params[key];
      if (val === undefined) {
        continue;
      }
      if (val === null) {
        throw new Error(
          `Protected parameter '${key}' in ${source.name} cannot be null.`,
        );
      }
      if (typeof val === "string" && val.trim() === "") {
        throw new Error(
          `Protected parameter '${key}' in ${source.name} cannot be empty string.`,
        );
      }

      if (establishedSource !== undefined) {
        if (establishedValue !== val) {
          throw new Error(
            `Conflicting parameter '${key}': ${source.name} specified '${String(val)}', but ${establishedSource} specified '${String(establishedValue)}'.`,
          );
        }
      } else {
        establishedSource = source.name;
        establishedValue = val;
      }
    }

    if (establishedValue !== undefined) {
      resolved[key] = establishedValue;
    }
  }

  return resolved;
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

  // 2. Validate and resolve provider override (Section 7.4 & F10)
  const resolvedProvider = validateProviderOverride(stageDef, request.provider);

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

  // 5. Protected run environment constraints (Section 8.1 & F02)
  const protectedParams = validateAndResolveProtectedParams(
    environmentDefaults,
    stageDef.parameters,
    stageDef.configs,
    request.parameters,
  );

  // 6. Parameter merging: environmentDefaults -> stage.parameters -> stage.configs -> request.parameters
  const rawMerged: Record<string, unknown> = {};
  if (environmentDefaults) {
    for (const [key, value] of Object.entries(environmentDefaults)) {
      if (value !== undefined) {
        rawMerged[key] = value;
      }
    }
  }
  if (stageDef.parameters) {
    for (const [key, value] of Object.entries(stageDef.parameters)) {
      rawMerged[key] = value;
    }
  }
  if (stageDef.configs) {
    for (const [key, value] of Object.entries(stageDef.configs)) {
      rawMerged[key] = value;
    }
  }
  if (request.parameters) {
    for (const [key, value] of Object.entries(request.parameters)) {
      rawMerged[key] = value;
    }
  }
  // Enforce resolved protected params
  for (const [key, value] of Object.entries(protectedParams)) {
    rawMerged[key] = value;
  }

  // 7. Resolve originating_stage if replan or provided (Section 8.2 & F11)
  const explicitRequestOrigin = request.originating_stage;
  const explicitParamOrigin = request.parameters?.originating_stage as
    | string
    | undefined;

  let canonicalOriginating: string | undefined;

  if (explicitRequestOrigin && explicitParamOrigin) {
    const originFromReq = resolveCanonicalStage(workflow, explicitRequestOrigin);
    const originFromParam = resolveCanonicalStage(workflow, explicitParamOrigin);
    if (originFromReq.id !== originFromParam.id) {
      throw new Error(
        `Conflicting originating_stage: request specified '${explicitRequestOrigin}' (${originFromReq.id}), but parameters specified '${explicitParamOrigin}' (${originFromParam.id}).`,
      );
    }
    canonicalOriginating = originFromReq.id;
  } else if (explicitRequestOrigin) {
    canonicalOriginating = resolveCanonicalStage(
      workflow,
      explicitRequestOrigin,
    ).id;
  } else if (explicitParamOrigin) {
    canonicalOriginating = resolveCanonicalStage(
      workflow,
      explicitParamOrigin,
    ).id;
  }

  if (canonicalOriginating) {
    const originDef = resolveCanonicalStage(workflow, canonicalOriginating);
    if (isReplanStage(originDef)) {
      throw new Error(
        `Invalid originating_stage '${canonicalOriginating}': replan stage cannot originate from another replan stage.`,
      );
    }
  }

  // 8. Calculate delivery dispatch
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

  const finalOriginatingStage =
    deliveryResult.originatingStage ?? canonicalOriginating;

  // Propagate canonical originating_stage into merged parameters (F11)
  if (finalOriginatingStage) {
    rawMerged.originating_stage = finalOriginatingStage;
  }

  // Deep clone mergedParameters to isolate mutable nested parameters from request/definition objects (F12)
  const mergedParameters = structuredClone(rawMerged);

  // 9. Assemble EvaluatedTask
  const task: EvaluatedTask = {
    stage: stageDef.id,
    logicalTask: stageDef.logical_task,
    provider: resolvedProvider,
    auxiliary: isAuxiliaryStage(stageDef),
    replan: isReplanStage(stageDef),
    issueId: deliveryResult.currentIssueId,
    attempt: deliveryResult.attempt,
    deliveryAttempt: deliveryResult.deliveryAttempt,
    originatingStage: finalOriginatingStage,
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
