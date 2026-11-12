/** Skill-internal command entry point; workflow routing remains the agent's responsibility. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  initWorkflow,
  dispatchTask,
  completeDispatch,
  resolveDecision,
  inspectState,
  parseDispatchRequest,
  type NormalizedDispatchRequest,
  type InitOptions,
  type CompleteOptions,
  type ResolveOptions,
  type InspectOptions,
} from "./lifecycle/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CliOptions = Record<string, any>;

export function loadDispatchRequest(
  filename: string,
): NormalizedDispatchRequest {
  if (!path.isAbsolute(filename)) {
    throw new Error(`Request path must be absolute, received '${filename}'`);
  }
  const content = fs.readFileSync(filename, "utf8");
  return parseDispatchRequest(content);
}

export function parseReportInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid compact report JSON: ${String(error)}`, {
        cause: error,
      });
    }
  }
  const filePath = path.resolve(trimmed);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Report file not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid report JSON in ${filePath}: ${String(error)}`, {
      cause: error,
    });
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const [command, ...args] = argv;
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
      "dispatch-id",
      "report",
      "decision",
      "reason",
      "next-stage",
      "mark-landed",
      "landing-dispatch-id",
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
      options:
        command === "dispatch"
          ? { "receipt-root": { type: "string" }, request: { type: "string" } }
          : options,
      strict: true,
      allowPositionals: false,
    });
    const o: CliOptions = {};
    for (const [key, value] of Object.entries(values)) {
      o[key.replaceAll("-", "_")] = value;
    }
    o.child_issues = o.child_issue;
    o.options = o.option;
    for (const key of ["delivery_attempts_max", "replans_max"]) {
      if (o[key] != null) {
        if (!/^-?\d+$/.test(String(o[key]))) {
          throw new Error(`--${key.replaceAll("_", "-")} must be an integer`);
        }
        o[key] = Number(o[key]);
      }
    }

    if (command !== "init" && !o.receipt_root) {
      throw new Error("--receipt-root is required");
    }

    let result: unknown;
    if (command === "init") {
      if (!o.root_issue) throw new Error("--root-issue is required");
      result = initWorkflow({ ...o, root_issue: o.root_issue } as InitOptions);
    } else if (command === "dispatch") {
      if (!path.isAbsolute(o.receipt_root)) {
        throw new Error(
          `Receipt root must be absolute, received '${o.receipt_root}'`,
        );
      }
      if (!o.request) throw new Error("--request is required");
      result = dispatchTask({
        receipt_root: o.receipt_root,
        ...loadDispatchRequest(o.request),
      });
    } else if (command === "complete") {
      if (!o.dispatch_id) {
        throw new Error("--dispatch-id is required for complete");
      }
      if (!o.report) throw new Error("--report is required");
      const reportData = parseReportInput(String(o.report));
      result = completeDispatch({
        receipt_root: o.receipt_root,
        dispatch_id: o.dispatch_id,
        report: reportData,
      } as CompleteOptions);
    } else if (command === "resolve") {
      if (!o.decision || !o.reason) {
        throw new Error("--decision and --reason are required");
      }
      const validDecisions = ["wait_user", "continue", "halt", "finish"];
      if (!validDecisions.includes(o.decision)) {
        throw new Error(
          `Invalid decision '${o.decision}'. Must strictly be one of 'wait_user' | 'continue' | 'halt' | 'finish'.`,
        );
      }
      result = resolveDecision({
        receipt_root: o.receipt_root,
        decision: o.decision as "wait_user" | "continue" | "halt" | "finish",
        reason: o.reason,
        options: o.options,
        next_stage: o.next_stage ?? null,
        child_issues: o.child_issues,
        plan: o.plan,
        current_issue: o.current_issue,
        mark_landed: o.mark_landed,
        landing_dispatch_id: o.landing_dispatch_id,
        complete_sequence: o.complete_sequence,
      } as ResolveOptions);
    } else if (command === "inspect") {
      result = inspectState({
        receipt_root: o.receipt_root,
        field: o.field,
      } as InspectOptions);
    } else {
      throw new Error(
        "Expected command: init | dispatch | complete | resolve | inspect",
      );
    }

    console.log(
      (typeof result === "object" && result !== null) || o.json
        ? JSON.stringify(result, null, 2)
        : String(result),
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(String(err) + "\n");
      process.exit(1);
    });
}
