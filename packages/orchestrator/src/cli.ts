/** Skill-internal command entry point; workflow routing remains the agent's responsibility. */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { initWorkflow } from "./init.js";
import { prepareTask } from "./prepare.js";
import { handoffDispatch, completeDispatch } from "./completion.js";
import { resolveDecision } from "./resolve.js";
import { inspectState } from "./inspect.js";
import type { Data } from "./workflow.js";
export function loadPrepareRequest(filename: string): Data {
  if (!path.isAbsolute(filename))
    throw Error(`Request path must be absolute, received '${filename}'`);
  const request = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw Error("Prepare request must be a JSON object");
  const fields = [
    "stage",
    "objective",
    "provider",
    "acceptance_criteria",
    "predecessor_receipts",
    "workdir",
    "scope",
    "attempt_intent",
    "branch",
    "commit",
    "receipt_template",
    "rework_issue",
  ];
  const unknown = Object.keys(request).filter((k) => !fields.includes(k));
  if (unknown.length)
    throw Error(`Unknown prepare request fields: ${unknown.sort().join(", ")}`);
  for (const key of ["stage", "objective"])
    if (!(key in request))
      throw Error(`Prepare request missing required field '${key}'`);
  for (const key of [
    "stage",
    "objective",
    "workdir",
    "scope",
    "branch",
    "commit",
    "receipt_template",
  ])
    if (
      key in request &&
      (typeof request[key] !== "string" ||
        (key !== "scope" && !request[key].trim()))
    )
      throw Error(
        `Request '${key}' must be ${key === "scope" ? "a string" : "a non-empty string"}, received ${JSON.stringify(request[key])}`,
      );
  if (
    "attempt_intent" in request &&
    !["same", "new"].includes(request.attempt_intent)
  )
    throw Error("Request 'attempt_intent' must be 'same' or 'new'");
  if (
    request.rework_issue != null &&
    !["string", "number"].includes(typeof request.rework_issue)
  )
    throw Error("Request 'rework_issue' must be a non-empty string or integer");
  if (typeof request.rework_issue === "string" && !request.rework_issue.trim())
    throw Error("Request 'rework_issue' must be a non-empty string or integer");
  const payload = { ...request };
  if (request.provider != null) {
    const p = request.provider;
    if (typeof p !== "object" || Array.isArray(p))
      throw Error("Request 'provider' must be an object");
    const unknown = Object.keys(p).filter(
      (k) => !["type", "target", "args"].includes(k),
    );
    if (unknown.length)
      throw Error(`Unknown provider fields: ${unknown.sort().join(", ")}`);
    if (p.type !== "skill") throw Error("Provider 'type' must be 'skill'");
    if (typeof p.target !== "string" || !p.target.trim())
      throw Error("Provider 'target' must be a non-empty string");
    delete payload.provider;
    Object.assign(payload, {
      provider_type: p.type,
      provider_target: p.target,
      provider_args: p.args ?? [],
    });
  }
  for (const [key, value] of [
    ["provider.args", payload.provider_args ?? []],
    ["acceptance_criteria", request.acceptance_criteria ?? []],
    ["predecessor_receipts", request.predecessor_receipts ?? []],
  ] as const)
    if (
      !Array.isArray(value) ||
      value.some((v: unknown) => typeof v !== "string")
    )
      throw Error(`Request '${key}' must be an array of strings`);
  if (payload.rework_issue != null)
    payload.rework_issue = String(payload.rework_issue).trim();
  return payload;
}
try {
  const [command, ...args] = process.argv.slice(2);
  const bools = ["force", "require-config", "complete-sequence", "json"];
  const strings = [
    "receipt-root",
    "root-issue",
    "current-issue",
    "workflow",
    "initial-stage",
    "repo-dir",
    "delivery-attempts-max",
    "replans-max",
    "plan",
    "delivery-target",
    "base-remote",
    "push-remote",
    "base-branch",
    "worktree-container",
    "request",
    "rework-issue",
    "dispatch-id",
    "platform-handle",
    "report",
    "decision",
    "reason",
    "next-stage",
    "mark-landed",
    "field",
  ];
  const options: Record<
    string,
    { type: "string" | "boolean"; multiple?: boolean }
  > = {};
  for (const name of bools) options[name] = { type: "boolean" };
  for (const name of strings) options[name] = { type: "string" };
  options["child-issue"] = { type: "string", multiple: true };
  options.option = { type: "string", multiple: true };
  const { values } = parseArgs({
    args,
    options,
    strict: true,
    allowPositionals: false,
  });
  const o: Data = {};
  for (const [key, value] of Object.entries(values))
    o[key.replaceAll("-", "_")] = value;
  o.child_issues = o.child_issue;
  o.options = o.option;
  for (const key of ["delivery_attempts_max", "replans_max"])
    if (o[key] != null) {
      if (!/^-?\d+$/.test(o[key]))
        throw Error(`--${key.replaceAll("_", "-")} must be an integer`);
      o[key] = Number(o[key]);
    }
  if (command !== "init" && !o.receipt_root)
    throw Error("--receipt-root is required");
  let result: unknown;
  if (command === "init") {
    if (!o.root_issue) throw Error("--root-issue is required");
    result = initWorkflow({ ...o, root_issue: o.root_issue });
  } else if (command === "prepare") {
    if (!path.isAbsolute(o.receipt_root))
      throw Error(
        `Receipt root must be absolute, received '${o.receipt_root}'`,
      );
    if (!o.request) throw Error("--request is required");
    const request = loadPrepareRequest(o.request);
    if (o.rework_issue) request.rework_issue = o.rework_issue;
    result = prepareTask({
      ...request,
      receipt_root: o.receipt_root,
      stage: request.stage,
      objective: request.objective,
    });
  } else if (command === "handoff")
    result = handoffDispatch({ ...o, receipt_root: o.receipt_root });
  else if (command === "complete") {
    if (!o.report) throw Error("--report is required");
    result = completeDispatch({
      ...o,
      receipt_root: o.receipt_root,
      report: o.report,
    });
  } else if (command === "resolve") {
    if (!o.decision || !o.reason)
      throw Error("--decision and --reason are required");
    result = resolveDecision(o);
  } else if (command === "inspect") result = inspectState(o);
  else
    throw Error(
      "Expected command: init | prepare | handoff | complete | resolve | inspect",
    );
  console.log(
    typeof result === "object" || o.json
      ? JSON.stringify(result, null, 2)
      : String(result),
  );
} catch (error) {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : error}\n`,
  );
  process.exitCode = 1;
}
