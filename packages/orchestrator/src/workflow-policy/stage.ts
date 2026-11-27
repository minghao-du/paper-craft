import type { SkillProvider, WorkflowDefinition, WorkflowStage } from "./types.js";

/**
 * Resolves a stage reference (exact id or logical_task alias) against workflow stages.
 * Rules (Section 7.1):
 * 1. Reject empty or non-string references.
 * 2. Match exact stage ID first. If exact id and logical_task collide, exact id wins.
 * 3. Otherwise match exactly one logical_task alias.
 * 4. If multiple stages match the logical_task, throw error with candidate IDs.
 * 5. Unmatched reference throws error; never fabricates a missing stage.
 */
export function resolveCanonicalStage(
  workflow: WorkflowDefinition,
  stageRef: string,
): WorkflowStage {
  if (typeof stageRef !== "string" || !stageRef.trim()) {
    throw new Error("Stage reference must be a non-empty string.");
  }
  const ref = stageRef.trim();

  const stages = workflow.stages ?? [];

  // 1. Exact id priority
  const exactMatch = stages.find((s) => s.id === ref);
  if (exactMatch) {
    return exactMatch;
  }

  // 2. Logical_task alias matching
  const aliasMatches = stages.filter((s) => s.logical_task === ref);
  if (aliasMatches.length === 1) {
    return aliasMatches[0];
  }
  if (aliasMatches.length > 1) {
    const candidateIds = aliasMatches.map((s) => `'${s.id}'`).join(", ");
    throw new Error(
      `Ambiguous stage reference '${ref}': matches multiple stages (${candidateIds}). Please specify an explicit stage ID.`,
    );
  }

  // 3. Completely unmatched -> reject
  throw new Error(
    `Stage '${ref}' is not defined in workflow '${workflow.name}'.`,
  );
}

export const BUILTIN_AUXILIARY_ROLES = new Set<string>([
  "workspace_prepare",
  "workspace_cleanup",
]);

export const BUILTIN_REPLAN_ROLES = new Set<string>(["scope_replan"]);

export const BUILTIN_NON_AUXILIARY_NON_REPLAN_ROLES = new Set<string>([
  "issue_plan",
  "issue_work",
  "pipeline_refactor_execute",
  "issue_land",
  "pipeline_refactor_redeliver",
  "issue_verify",
  "pipeline_refactor_audit",
  "issue_finalize",
  "research_record",
]);

/**
 * Predicate: determines whether a stage is an initial planning stage.
 */
export function isInitialPlanStage(stage: WorkflowStage): boolean {
  if (Boolean(stage.replan) || stage.logical_task === "scope_replan") {
    return false;
  }
  return stage.logical_task === "issue_plan";
}

/**
 * Predicate: determines whether a stage is a replanning stage.
 */
export function isReplanStage(stage: WorkflowStage): boolean {
  return Boolean(stage.replan) || stage.logical_task === "scope_replan";
}

/**
 * Predicate: determines whether a stage is a landing/merge stage.
 */
export function isLandingStage(stage: WorkflowStage): boolean {
  return (
    stage.logical_task === "issue_land" ||
    stage.logical_task === "pipeline_refactor_redeliver"
  );
}

/**
 * Predicate: determines whether a stage is an integrated acceptance/audit verification stage.
 */
export function isVerificationStage(stage: WorkflowStage): boolean {
  return (
    stage.logical_task === "issue_verify" ||
    stage.logical_task === "pipeline_refactor_audit"
  );
}

/**
 * Predicate: determines whether a stage is an issue closure/finalization stage.
 */
export function isFinalizationStage(stage: WorkflowStage): boolean {
  return stage.logical_task === "issue_finalize";
}

/**
 * Predicate: determines whether a stage is a workspace cleanup stage.
 */
export function isCleanupStage(stage: WorkflowStage): boolean {
  return stage.logical_task === "workspace_cleanup";
}

/**
 * Predicate: determines whether a stage is an auxiliary (non-delivery) stage.
 */
export function isAuxiliaryStage(stage: WorkflowStage): boolean {
  return (
    Boolean(stage.auxiliary) ||
    stage.logical_task === "workspace_prepare" ||
    stage.logical_task === "workspace_cleanup"
  );
}

/**
 * Predicate: determines whether a stage is a research recording stage.
 */
export function isResearchRecordStage(stage: WorkflowStage): boolean {
  return stage.logical_task === "research_record";
}

/**
 * Predicate: determines whether a stage performs content-changing work.
 * (e.g. code modification under implementation or pipeline refactoring execution).
 */
export function isContentChangingStage(stage: WorkflowStage): boolean {
  if (
    stage.logical_task === "issue_work" ||
    stage.logical_task === "pipeline_refactor_execute"
  ) {
    return true;
  }
  if (
    isAuxiliaryStage(stage) ||
    isReplanStage(stage) ||
    isInitialPlanStage(stage) ||
    isLandingStage(stage) ||
    isVerificationStage(stage) ||
    isFinalizationStage(stage) ||
    isCleanupStage(stage) ||
    isResearchRecordStage(stage)
  ) {
    return false;
  }
  // Conservative default for unclassified custom stages
  return true;
}

/**
 * Predicate: determines whether a stage is evidence-sensitive, requiring protected provider execution.
 */
export function isEvidenceSensitiveStage(stage: WorkflowStage): boolean {
  return (
    isInitialPlanStage(stage) ||
    isLandingStage(stage) ||
    isVerificationStage(stage) ||
    isFinalizationStage(stage) ||
    isCleanupStage(stage) ||
    isReplanStage(stage)
  );
}

/**
 * Consequence helper: determines whether dispatching this stage allocates a delivery attempt.
 * Section 7.3: Only content-changing work allocates a delivery attempt.
 */
export function allocatesDeliveryAttempt(stage: WorkflowStage): boolean {
  return isContentChangingStage(stage);
}

/**
 * Consequence helper: determines whether execution of this stage invalidates existing landing evidence.
 * Section 7.3: Only content-changing work invalidates an accepted landing.
 */
export function invalidatesLanding(stage: WorkflowStage): boolean {
  return isContentChangingStage(stage);
}

/**
 * Consequence helper: determines whether execution of this stage invalidates previous integrated verification.
 * Section 7.3: Both content-changing work and landing/redelivery executions invalidate older verification.
 */
export function invalidatesVerification(stage: WorkflowStage): boolean {
  return isContentChangingStage(stage) || isLandingStage(stage);
}

/**
 * Validates and normalizes provider override according to sensitive provider rules (Section 7.4).
 * - For evidence-sensitive built-in roles:
 *   - Protect provider target, type, and execution mode arguments together.
 *   - If no override, return stage definition's provider.
 *   - If explicit override, require equivalent normalized provider, including exact ordered arguments.
 *     Do not sort arguments. An explicit empty argument array must NOT erase arguments like '--cleanup'.
 * - For ordinary stages:
 *   - Allows provider target substitution if valid.
 */
export function validateProviderOverride(
  stage: WorkflowStage,
  override?: SkillProvider,
): SkillProvider {
  if (!override) {
    return {
      type: "skill",
      target: stage.provider.target,
      args: stage.provider.args ? [...stage.provider.args] : [],
    };
  }

  const pType = override.type ?? "skill";
  if (pType !== "skill") {
    throw new Error(`Provider 'type' must be 'skill', received '${pType}'`);
  }
  if (!override.target || !override.target.trim()) {
    throw new Error("Provider 'target' must be a non-empty string.");
  }
  const trimmedTarget = override.target.trim();

  if (isEvidenceSensitiveStage(stage)) {
    if (trimmedTarget !== stage.provider.target) {
      throw new Error(
        `Cannot override provider for evidence-sensitive stage '${stage.id}': target '${trimmedTarget}' does not match stage provider '${stage.provider.target}'.`,
      );
    }

    const expectedArgs = stage.provider.args ?? [];
    const overrideArgs = override.args ?? [];
    const argsMatch =
      overrideArgs.length === expectedArgs.length &&
      overrideArgs.every((arg, idx) => arg === expectedArgs[idx]);

    if (!argsMatch) {
      throw new Error(
        `Cannot override provider for evidence-sensitive stage '${stage.id}': arguments must match stage definition.`,
      );
    }

    return {
      type: "skill",
      target: stage.provider.target,
      args: [...expectedArgs],
    };
  }

  // Ordinary stages allow provider target substitution
  return {
    type: "skill",
    target: trimmedTarget,
    args: override.args ? [...override.args] : [],
  };
}
