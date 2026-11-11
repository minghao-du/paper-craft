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

function validate(wf: Record<string, unknown>): WorkflowDefinition {
  if (!wf || Array.isArray(wf) || typeof wf !== "object") {
    throw new Error("Workflow definition must be a mapping/object");
  }
  if (typeof wf.name !== "string" || !wf.name.trim()) {
    throw new Error(
      "Workflow definition missing required non-empty string field: 'name'",
    );
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
  for (const stage of wf.stages as Array<Record<string, unknown>>) {
    if (
      !stage ||
      typeof stage !== "object" ||
      typeof stage.id !== "string" ||
      !stage.id.trim()
    ) {
      throw new Error(
        "Workflow stage missing required non-empty string field: 'id'",
      );
    }
    const stageId = stage.id.trim();
    if (ids.has(stageId)) {
      throw new Error(`Duplicate stage ID '${stageId}' in workflow`);
    }
    ids.add(stageId);

    if (stage.skill && !stage.provider) {
      stage.provider = { type: "skill", target: String(stage.skill).trim() };
    }
    const p = stage.provider as Record<string, unknown> | undefined;
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
    if (
      p.args != null &&
      (!Array.isArray(p.args) ||
        p.args.some((a: unknown) => typeof a !== "string"))
    ) {
      throw new Error(
        `Workflow stage '${stageId}' provider 'args' must be a list of strings`,
      );
    }
  }

  if (wf.initial_stage && !ids.has(String(wf.initial_stage).trim())) {
    throw new Error(
      `Workflow 'initial_stage' references unknown stage '${wf.initial_stage}'`,
    );
  }

  for (const stage of wf.stages as Array<Record<string, unknown>>) {
    const stageId = (stage.id as string).trim();
    for (const key of ["next", "on_success", "on_failure", "next_stage"]) {
      if (stage[key] && !ids.has(String(stage[key]).trim())) {
        throw new Error(
          `Stage '${stageId}' ${key} references unknown stage '${stage[key]}'`,
        );
      }
    }
    const deps = stage.depends_on || stage.dependencies;
    for (const dep of Array.isArray(deps) ? deps : deps ? [deps] : []) {
      if (!ids.has(String(dep).trim())) {
        throw new Error(
          `Stage '${stageId}' dependency references unknown stage '${dep}'`,
        );
      }
    }
  }

  return wf as unknown as WorkflowDefinition;
}

export function loadAndValidateWorkflow(
  source?: string | Record<string, unknown> | null,
  repoDir?: string,
): WorkflowDefinition {
  let data: Record<string, unknown>;
  if (source && typeof source === "object") {
    data = structuredClone(source) as Record<string, unknown>;
  } else if (typeof source === "string" && source.trim().startsWith("{")) {
    data = JSON.parse(source);
  } else {
    const name = typeof source === "string" ? source.trim() : "";
    let filename = DEFAULT_WORKFLOW_PATH;
    if (name && name !== "default") {
      const candidates = [
        path.resolve(repoDir ?? ".", name),
        path.resolve(name),
        path.join(path.dirname(DEFAULT_WORKFLOW_PATH), `${name}.json`),
        path.join(path.dirname(DEFAULT_WORKFLOW_PATH), name),
      ];
      const found = candidates.find(
        (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
      );
      if (found) {
        filename = found;
      } else {
        throw new Error(`Workflow file not found: ${name}`);
      }
    }
    data = JSON.parse(fs.readFileSync(filename, "utf8"));
  }

  const rawWf =
    data?.workflow && typeof data.workflow === "object"
      ? (data.workflow as Record<string, unknown>)
      : data;

  return validate(rawWf);
}

export function resolveTaskIntent(
  workflow: WorkflowDefinition,
  stage: string,
  providerOverride?: ProviderOverride,
  options?: ResolveTaskIntentOptions,
): TaskIntent {
  let stageDef: WorkflowStage | undefined = workflow.stages?.find(
    (item) => item.id === stage || item.logical_task === stage,
  );

  if (!stageDef) {
    if (!providerOverride?.target) {
      throw new Error(
        `Cannot prepare task: Stage '${stage}' is not defined in workflow snapshot and no provider was specified.`,
      );
    }
    stageDef = {
      id: stage,
      logical_task: stage,
      provider: {
        type: "skill",
        target: providerOverride.target,
        args: providerOverride.args ?? [],
      },
    };
  }

  const canonicalStage = stageDef.id;
  const stageProvider = stageDef.provider;
  const providerType = providerOverride?.type || stageProvider?.type || "skill";
  const providerTarget = providerOverride?.target || stageProvider?.target;
  const providerArgs = providerOverride?.args ?? stageProvider?.args ?? [];

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

  const auxiliary = Boolean(
    stageDef.auxiliary ||
      ["workspace_prepare", "workspace_cleanup"].includes(stageDef.id),
  );

  const replan = Boolean(
    stageDef.replan ||
      stageDef.id === "scope_replan" ||
      stage === "scope_replan",
  );

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
    worktree_container: config.worktree_container || context.worktree_container,
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in params) && value !== undefined && value !== null) {
      params[key] = value;
    }
  }

  const scope = options?.scope || stageDef.scope || "";

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
