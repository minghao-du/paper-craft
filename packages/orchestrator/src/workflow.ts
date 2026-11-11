import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Workflow-specific routing and persisted extension fields are validated at their consumers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Data = Record<string, any>;
export const DEFAULT_WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../../skills/pc-orchestrator/workflows/default.json",
    import.meta.url,
  ),
);
export function loadAndValidateWorkflow(
  source?: string | Data | null,
  repoDir?: string,
): Data {
  let data: Data;
  if (source && typeof source === "object") data = structuredClone(source);
  else if (typeof source === "string" && source.trim().startsWith("{"))
    data = JSON.parse(source);
  else {
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
      if (found) filename = found;
      else if (
        name.includes("/") ||
        name.includes("\\") ||
        /\.(json|ya?ml)$/.test(name)
      )
        throw Error(`Workflow file not found: ${name}`);
      else {
        data = JSON.parse(fs.readFileSync(filename, "utf8"));
        const wf = data.workflow ?? data;
        wf.name = name;
        return validate(wf);
      }
    }
    data = JSON.parse(fs.readFileSync(filename, "utf8"));
  }
  return validate(
    data?.workflow && typeof data.workflow === "object" ? data.workflow : data,
  );
}
function validate(wf: Data): Data {
  if (!wf || Array.isArray(wf) || typeof wf !== "object")
    throw Error("Workflow definition must be a mapping/object");
  if (typeof wf.name !== "string" || !wf.name.trim())
    throw Error(
      "Workflow definition missing required non-empty string field: 'name'",
    );
  if (!Array.isArray(wf.stages) || !wf.stages.length)
    throw Error(
      "Workflow definition missing required non-empty list field: 'stages'",
    );
  const ids = new Set<string>();
  for (const stage of wf.stages) {
    if (
      !stage ||
      typeof stage !== "object" ||
      typeof stage.id !== "string" ||
      !stage.id.trim()
    )
      throw Error(
        "Workflow stage missing required non-empty string field: 'id'",
      );
    if (ids.has(stage.id.trim()))
      throw Error(`Duplicate stage ID '${stage.id.trim()}' in workflow`);
    ids.add(stage.id.trim());
    if (stage.skill && !stage.provider)
      stage.provider = { type: "skill", target: String(stage.skill).trim() };
    const p = stage.provider;
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw Error(
        `Workflow stage '${stage.id}' missing required mapping: 'provider'`,
      );
    if (p.type !== "skill")
      throw Error(
        `Workflow stage '${stage.id}' has invalid provider type '${p.type}'. Only 'skill' provider is supported.`,
      );
    if (typeof p.target !== "string" || !p.target.trim())
      throw Error(
        `Workflow stage '${stage.id}' has missing or empty provider 'target'`,
      );
    if (
      p.args != null &&
      (!Array.isArray(p.args) ||
        p.args.some((a: unknown) => typeof a !== "string"))
    )
      throw Error(
        `Workflow stage '${stage.id}' provider 'args' must be a list of strings`,
      );
  }
  if (wf.initial_stage && !ids.has(String(wf.initial_stage).trim()))
    throw Error(
      `Workflow 'initial_stage' references unknown stage '${wf.initial_stage}'`,
    );
  for (const stage of wf.stages) {
    for (const key of ["next", "on_success", "on_failure", "next_stage"])
      if (stage[key] && !ids.has(String(stage[key]).trim()))
        throw Error(
          `Stage '${stage.id}' ${key} references unknown stage '${stage[key]}'`,
        );
    const deps = stage.depends_on || stage.dependencies;
    for (const dep of Array.isArray(deps) ? deps : deps ? [deps] : [])
      if (!ids.has(String(dep).trim()))
        throw Error(
          `Stage '${stage.id}' dependency references unknown stage '${dep}'`,
        );
  }
  return wf;
}
export function validatePlanOrder(tasks: unknown[]): string[] {
  if (!Array.isArray(tasks) || !tasks.length)
    throw Error("Plan must contain at least one task.");
  const seen = new Set<string>();
  const items = tasks.map((item, idx) => {
    const t = item as Data | string | number;
    const object = t && typeof t === "object" ? (t as Data) : null;
    const raw = object ? (object.number ?? object.id ?? object.issue_id) : t;
    if (!["string", "number"].includes(typeof raw) || !String(raw).trim())
      throw Error(`Task at index ${idx} is missing issue ID/number.`);
    const id = String(raw).trim();
    if (seen.has(id)) throw Error(`Duplicate issue ID '${id}' in plan.`);
    seen.add(id);
    return {
      id,
      deps: (object?.blockedBy ?? object?.blocked_by ?? []).map((b: unknown) =>
        String(b).trim(),
      ),
    };
  });
  const resolved = new Set<string>();
  for (const { id, deps } of items) {
    for (const dep of deps) {
      if (dep === id) throw Error(`Task '${id}' cannot depend on itself.`);
      if (!seen.has(dep))
        throw Error(
          `Plan dependency violation: task '${id}' depends on unknown issue '${dep}' not declared in plan.`,
        );
      if (!resolved.has(dep))
        throw Error(
          `Plan dependency violation: task '${id}' depends on '${dep}', which does not precede it in the plan order.`,
        );
    }
    resolved.add(id);
  }
  return items.map((t) => t.id);
}
export function readPlan(plan: unknown): string[] {
  const data =
    typeof plan === "string"
      ? JSON.parse(
          plan.trim().startsWith("{") || plan.trim().startsWith("[")
            ? plan
            : fs.readFileSync(path.resolve(plan), "utf8"),
        )
      : plan;
  return validatePlanOrder(
    Array.isArray(data) ? data : ((data as Data)?.tasks ?? []),
  );
}
export function makeDeliverySequence(ids: string[], max: number): Data {
  return {
    items: ids.map((issue_id) => ({
      issue_id,
      stage: "stage_2_work",
      status: "pending",
      budgets: { delivery_attempts_used: 0, delivery_attempts_max: max },
      landed: false,
    })),
    current_index: 0,
    completed: false,
  };
}
