import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderOverride,
  ResolveTaskIntentOptions,
  TaskIntent,
  WorkflowDefinition,
  WorkflowStage,
} from "./types.js";

const candidateTemplate = fileURLToPath(
  new URL(
    "../../../../skills/pc-orchestrator/templates/subagent-receipt.template.md",
    import.meta.url,
  ),
);
const fallbackTemplate = fileURLToPath(
  new URL(
    "../../../skills/pc-orchestrator/templates/subagent-receipt.template.md",
    import.meta.url,
  ),
);
export const DEFAULT_RECEIPT_TEMPLATE = fs.existsSync(candidateTemplate)
  ? candidateTemplate
  : fallbackTemplate;

const candidateDefault = fileURLToPath(
  new URL(
    "../../../../skills/pc-orchestrator/workflows/default.json",
    import.meta.url,
  ),
);
const fallbackDefault = fileURLToPath(
  new URL(
    "../../../skills/pc-orchestrator/workflows/default.json",
    import.meta.url,
  ),
);
export const DEFAULT_WORKFLOW_PATH = fs.existsSync(candidateDefault)
  ? candidateDefault
  : fallbackDefault;

/**
 * Resolves a stage reference (exact id or logical_task alias) against workflow stages.
 * Rules:
 * - Exact id matches first. If exact id and logical_task collide, exact id wins.
 * - If no exact id matches, matches logical_task.
 * - If logical_task matches multiple stages, throws ambiguous error with candidate ids.
 * - Unmatched reference throws error; never fabricates a missing stage.
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

export const resolveStageDefinition = resolveCanonicalStage;

function normalizeDependencyList(
  raw: unknown,
  stageId: string,
  fieldName: string,
): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error(
        `Stage '${stageId}' field '${fieldName}' cannot contain an empty string.`,
      );
    }
    return [trimmed];
  }
  if (Array.isArray(raw)) {
    return raw.map((item, idx) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(
          `Stage '${stageId}' field '${fieldName}[${idx}]' must be a non-empty string.`,
        );
      }
      return item.trim();
    });
  }
  throw new Error(
    `Stage '${stageId}' field '${fieldName}' must be a string or array of strings.`,
  );
}

function validateWorkflow(
  wf: Record<string, unknown>,
  mode: "source" | "snapshot",
  baseDir?: string,
): WorkflowDefinition {
  if (!wf || Array.isArray(wf) || typeof wf !== "object") {
    throw new Error("Workflow definition must be a mapping/object");
  }
  if (typeof wf.name !== "string" || !wf.name.trim()) {
    throw new Error(
      "Workflow definition missing required non-empty string field: 'name'",
    );
  }
  wf.name = wf.name.trim();

  if (wf.version !== undefined && typeof wf.version !== "string") {
    throw new Error("Workflow 'version' must be a string if provided");
  }

  if (
    wf.completion_policy !== "issue_delivery" &&
    wf.completion_policy !== "basic"
  ) {
    throw new Error(
      "Workflow definition missing or invalid required field 'completion_policy': must be 'issue_delivery' or 'basic'",
    );
  }
  if (!Array.isArray(wf.stages) || !wf.stages.length) {
    throw new Error(
      "Workflow definition missing required non-empty list field: 'stages'",
    );
  }

  const ids = new Set<string>();

  for (const rawStage of wf.stages as Array<Record<string, unknown>>) {
    if (!rawStage || typeof rawStage !== "object" || Array.isArray(rawStage)) {
      throw new Error("Workflow stage must be a mapping/object");
    }

    if (typeof rawStage.id !== "string" || !rawStage.id.trim()) {
      throw new Error(
        "Workflow stage missing required non-empty string field: 'id'",
      );
    }
    const stageId = rawStage.id.trim();
    if (ids.has(stageId)) {
      throw new Error(`Duplicate stage ID '${stageId}' in workflow`);
    }
    ids.add(stageId);
    rawStage.id = stageId;

    if (
      typeof rawStage.logical_task !== "string" ||
      !rawStage.logical_task.trim()
    ) {
      throw new Error(
        `Workflow stage '${stageId}' missing required non-empty string field: 'logical_task'`,
      );
    }
    rawStage.logical_task = rawStage.logical_task.trim();

    if (rawStage.skill && !rawStage.provider) {
      rawStage.provider = {
        type: "skill",
        target: String(rawStage.skill).trim(),
      };
    }
    const p = rawStage.provider as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      throw new Error(
        `Workflow stage '${stageId}' missing required mapping: 'provider'`,
      );
    }
    if (p.type !== "skill") {
      throw new Error(
        `Workflow stage '${stageId}' has invalid provider type '${p.type}'. Only 'skill' provider is supported.`,
      );
    }
    if (typeof p.target !== "string" || !p.target.trim()) {
      throw new Error(
        `Workflow stage '${stageId}' has missing or empty provider 'target'`,
      );
    }
    p.target = p.target.trim();

    if (p.args !== undefined) {
      if (
        !Array.isArray(p.args) ||
        p.args.some((a: unknown) => typeof a !== "string")
      ) {
        throw new Error(
          `Workflow stage '${stageId}' provider 'args' must be a list of strings`,
        );
      }
    }

    if (rawStage.auxiliary !== undefined) {
      if (typeof rawStage.auxiliary !== "boolean") {
        throw new Error(
          `Workflow stage '${stageId}' field 'auxiliary' must be a boolean, got ${typeof rawStage.auxiliary}.`,
        );
      }
    }

    if (rawStage.replan !== undefined) {
      if (typeof rawStage.replan !== "boolean") {
        throw new Error(
          `Workflow stage '${stageId}' field 'replan' must be a boolean, got ${typeof rawStage.replan}.`,
        );
      }
    }

    if (Boolean(rawStage.auxiliary) && Boolean(rawStage.replan)) {
      throw new Error(
        `Workflow stage '${stageId}' cannot declare both auxiliary: true and replan: true.`,
      );
    }

    if (mode === "source") {
      rawStage.auxiliary = rawStage.auxiliary ?? false;
      rawStage.replan = rawStage.replan ?? false;
    }

    if (rawStage.parameters !== undefined) {
      if (
        !rawStage.parameters ||
        typeof rawStage.parameters !== "object" ||
        Array.isArray(rawStage.parameters)
      ) {
        throw new Error(
          `Workflow stage '${stageId}' field 'parameters' must be a plain object.`,
        );
      }
    }

    if (rawStage.configs !== undefined) {
      if (
        !rawStage.configs ||
        typeof rawStage.configs !== "object" ||
        Array.isArray(rawStage.configs)
      ) {
        throw new Error(
          `Workflow stage '${stageId}' field 'configs' must be a plain object.`,
        );
      }
    }

    if (rawStage.scope !== undefined && typeof rawStage.scope !== "string") {
      throw new Error(
        `Workflow stage '${stageId}' field 'scope' must be a string.`,
      );
    }

    if (
      rawStage.template !== undefined &&
      typeof rawStage.template !== "string"
    ) {
      throw new Error(
        `Workflow stage '${stageId}' field 'template' must be a string.`,
      );
    }

    if (
      rawStage.receipt_template !== undefined &&
      typeof rawStage.receipt_template !== "string"
    ) {
      throw new Error(
        `Workflow stage '${stageId}' field 'receipt_template' must be a string.`,
      );
    }

    if (mode === "source" && baseDir) {
      if (
        typeof rawStage.template === "string" &&
        !path.isAbsolute(rawStage.template)
      ) {
        rawStage.template = path.resolve(baseDir, rawStage.template);
      }
      if (
        typeof rawStage.receipt_template === "string" &&
        !path.isAbsolute(rawStage.receipt_template)
      ) {
        rawStage.receipt_template = path.resolve(
          baseDir,
          rawStage.receipt_template,
        );
      }
    }

    const depsFromDependsOn =
      rawStage.depends_on !== undefined
        ? normalizeDependencyList(rawStage.depends_on, stageId, "depends_on")
        : undefined;
    const depsFromDependencies =
      rawStage.dependencies !== undefined
        ? normalizeDependencyList(
            rawStage.dependencies,
            stageId,
            "dependencies",
          )
        : undefined;

    if (depsFromDependsOn !== undefined && depsFromDependencies !== undefined) {
      const s1 = [...depsFromDependsOn].sort();
      const s2 = [...depsFromDependencies].sort();
      const matches =
        s1.length === s2.length && s1.every((v, i) => v === s2[i]);
      if (!matches) {
        throw new Error(
          `Stage '${stageId}' has conflicting 'depends_on' and 'dependencies' declarations.`,
        );
      }
    }
  }

  // Cross-reference checks for stage references
  const stageList = wf.stages as Array<Record<string, unknown>>;
  for (const rawStage of stageList) {
    const stageId = rawStage.id as string;

    const deps =
      rawStage.depends_on !== undefined
        ? normalizeDependencyList(rawStage.depends_on, stageId, "depends_on")
        : rawStage.dependencies !== undefined
          ? normalizeDependencyList(
              rawStage.dependencies,
              stageId,
              "dependencies",
            )
          : [];

    for (const dep of deps) {
      if (!ids.has(dep)) {
        const matches = stageList.filter((s) => s.logical_task === dep);
        if (matches.length === 0) {
          throw new Error(
            `Stage '${stageId}' dependency references unknown stage '${dep}'.`,
          );
        }
        if (matches.length > 1) {
          const candidateIds = matches.map((s) => `'${s.id}'`).join(", ");
          throw new Error(
            `Stage '${stageId}' dependency '${dep}' is ambiguous: matches multiple stages (${candidateIds}).`,
          );
        }
      }
    }

    for (const key of ["next", "on_success", "on_failure", "next_stage"]) {
      if (rawStage[key] !== undefined) {
        if (
          typeof rawStage[key] !== "string" ||
          !(rawStage[key] as string).trim()
        ) {
          throw new Error(
            `Stage '${stageId}' field '${key}' must be a non-empty string.`,
          );
        }
        const target = (rawStage[key] as string).trim();
        rawStage[key] = target;
        if (!ids.has(target)) {
          const matches = stageList.filter((s) => s.logical_task === target);
          if (matches.length === 0) {
            throw new Error(
              `Stage '${stageId}' ${key} references unknown stage '${target}'.`,
            );
          }
          if (matches.length > 1) {
            const candidateIds = matches.map((s) => `'${s.id}'`).join(", ");
            throw new Error(
              `Stage '${stageId}' ${key} '${target}' is ambiguous: matches multiple stages (${candidateIds}).`,
            );
          }
        }
      }
    }
  }

  // initial_stage normalization / validation
  if (mode === "source") {
    if (
      wf.initial_stage === undefined ||
      wf.initial_stage === null ||
      wf.initial_stage === ""
    ) {
      wf.initial_stage = (wf.stages[0] as WorkflowStage).id;
    } else {
      if (typeof wf.initial_stage !== "string") {
        throw new Error("Workflow 'initial_stage' must be a string.");
      }
      const target = wf.initial_stage.trim();
      if (!ids.has(target)) {
        const matches = stageList.filter((s) => s.logical_task === target);
        if (matches.length === 0) {
          throw new Error(
            `Workflow 'initial_stage' references unknown stage '${target}'.`,
          );
        }
        if (matches.length > 1) {
          const candidateIds = matches.map((s) => `'${s.id}'`).join(", ");
          throw new Error(
            `Workflow 'initial_stage' '${target}' is ambiguous: matches multiple stages (${candidateIds}).`,
          );
        }
        wf.initial_stage = matches[0].id as string;
      } else {
        wf.initial_stage = target;
      }
    }
  } else {
    // mode === "snapshot": strict validation, no new defaults added
    if (wf.initial_stage !== undefined) {
      if (typeof wf.initial_stage !== "string") {
        throw new Error("Workflow 'initial_stage' must be a string.");
      }
      const target = wf.initial_stage.trim();
      if (!ids.has(target)) {
        const matches = stageList.filter((s) => s.logical_task === target);
        if (matches.length === 0) {
          throw new Error(
            `Workflow 'initial_stage' references unknown stage '${target}'.`,
          );
        }
        if (matches.length > 1) {
          const candidateIds = matches.map((s) => `'${s.id}'`).join(", ");
          throw new Error(
            `Workflow 'initial_stage' '${target}' is ambiguous: matches multiple stages (${candidateIds}).`,
          );
        }
        wf.initial_stage = matches[0].id as string;
      } else {
        wf.initial_stage = target;
      }
    }
  }

  return wf as unknown as WorkflowDefinition;
}

/**
 * Loads and validates a workflow definition.
 * - mode === "snapshot": strictly validates in-memory snapshot structure without reading disk or adding defaults.
 * - mode === "source": loads from default.json, explicit path, or in-memory object and resolves defaults.
 */
export function loadAndValidateWorkflow(
  source?: unknown,
  repoDir?: string,
  mode: "source" | "snapshot" = "source",
): WorkflowDefinition {
  if (mode === "snapshot") {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error("Workflow snapshot must be a valid plain object.");
    }
    const raw = structuredClone(source) as Record<string, unknown>;
    const rawWf =
      raw?.workflow && typeof raw.workflow === "object"
        ? (raw.workflow as Record<string, unknown>)
        : raw;
    return validateWorkflow(rawWf, mode);
  }

  // mode === "source"
  let data: Record<string, unknown>;
  let baseDir: string | undefined;

  if (
    source === undefined ||
    source === null ||
    source === "" ||
    source === "default"
  ) {
    if (!fs.existsSync(DEFAULT_WORKFLOW_PATH)) {
      throw new Error(
        `Default workflow file not found: ${DEFAULT_WORKFLOW_PATH}`,
      );
    }
    data = JSON.parse(fs.readFileSync(DEFAULT_WORKFLOW_PATH, "utf8"));
    baseDir = path.dirname(DEFAULT_WORKFLOW_PATH);
  } else if (typeof source === "string") {
    const trimmed = source.trim();
    if (trimmed === "default") {
      if (!fs.existsSync(DEFAULT_WORKFLOW_PATH)) {
        throw new Error(
          `Default workflow file not found: ${DEFAULT_WORKFLOW_PATH}`,
        );
      }
      data = JSON.parse(fs.readFileSync(DEFAULT_WORKFLOW_PATH, "utf8"));
      baseDir = path.dirname(DEFAULT_WORKFLOW_PATH);
    } else {
      const filePath = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(repoDir ?? ".", trimmed);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`Workflow file not found: ${trimmed}`);
      }
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      baseDir = path.dirname(filePath);
    }
  } else if (typeof source === "object" && !Array.isArray(source)) {
    data = structuredClone(source) as Record<string, unknown>;
    baseDir = path.resolve(repoDir ?? ".");
  } else {
    throw new Error(
      "Invalid workflow source: expected path string or workflow object.",
    );
  }

  const rawWf =
    data?.workflow && typeof data.workflow === "object"
      ? (data.workflow as Record<string, unknown>)
      : data;

  return validateWorkflow(rawWf, mode, baseDir);
}

/**
 * Backward compatibility helper for lifecycle/dispatch.ts during refactoring.
 * Internally uses canonical stage resolution.
 */
export function resolveTaskIntent(
  workflow: WorkflowDefinition,
  stage: string,
  providerOverride?: ProviderOverride,
  options?: ResolveTaskIntentOptions,
): TaskIntent {
  const stageDef = resolveCanonicalStage(workflow, stage);

  const canonicalStage = stageDef.id;
  const stageProvider = stageDef.provider;
  const providerType =
    providerOverride?.type || stageProvider?.type || "skill";
  const providerTarget = providerOverride?.target || stageProvider?.target;
  const providerArgs = providerOverride?.target
    ? (providerOverride.args ?? [])
    : (providerOverride?.args ?? stageProvider?.args ?? []);

  if (providerType !== "skill") {
    throw new Error(
      `Provider 'type' must be 'skill', received '${providerType}'`,
    );
  }
  if (!providerTarget) {
    throw new Error(
      `Provider 'target' must be defined in stage '${stage}' or provided in prepare request.`,
    );
  }

  const provider = {
    type: "skill" as const,
    target: providerTarget,
    args: [...providerArgs],
  };

  const template =
    options?.template ||
    stageDef.receipt_template ||
    stageDef.template ||
    DEFAULT_RECEIPT_TEMPLATE;

  const auxiliary = Boolean(stageDef.auxiliary);
  const replan = Boolean(stageDef.replan);

  const config = options?.configSnapshot ?? {};
  const context = options?.context ?? {};
  const repository =
    (config.delivery_target as string | undefined) ||
    (context.delivery_target as string | undefined) ||
    (context.repository as string | undefined);

  const params: Record<string, unknown> = {
    ...(stageDef.parameters ?? {}),
    ...(stageDef.configs ?? {}),
    ...(options?.parameters ?? {}),
  };

  const defaults: Record<string, unknown> = {
    delivery_target: repository,
    base_remote: config.base_remote || context.base_remote,
    push_remote: config.push_remote || context.push_remote,
    worktree_container:
      config.worktree_container || context.worktree_container,
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in params) && value !== undefined && value !== null) {
      params[key] = value;
    }
  }

  const scope =
    options?.scope !== undefined ? options.scope : stageDef.scope || "";

  return {
    canonical_stage: canonicalStage,
    stage_def: stageDef,
    provider,
    auxiliary,
    replan,
    template,
    scope,
    parameters: params,
  };
}

export { evaluateDispatch } from "./dispatch.js";
