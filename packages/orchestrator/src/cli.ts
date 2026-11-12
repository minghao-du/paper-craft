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

type ArgOption = { type: "string" | "boolean"; multiple?: boolean };

const INIT_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string" },
  "root-issue": { type: "string" },
  "repo-dir": { type: "string" },
  workflow: { type: "string" },
  force: { type: "boolean" },
  "require-config": { type: "boolean" },
  "delivery-attempts-max": { type: "string" },
  "replans-max": { type: "string" },
  "delivery-target": { type: "string" },
  "base-remote": { type: "string" },
  "push-remote": { type: "string" },
  "base-branch": { type: "string" },
  "worktree-container": { type: "string" },
  json: { type: "boolean" },
};

const DISPATCH_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string" },
  request: { type: "string" },
  json: { type: "boolean" },
};

const COMPLETE_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string" },
  "dispatch-id": { type: "string" },
  report: { type: "string" },
  json: { type: "boolean" },
};

const RESOLVE_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string" },
  decision: { type: "string" },
  reason: { type: "string" },
  "next-stage": { type: "string" },
  "plan-dispatch-id": { type: "string" },
  "current-issue": { type: "string" },
  "mark-landed": { type: "string" },
  "landing-dispatch-id": { type: "string" },
  "complete-sequence": { type: "boolean" },
  option: { type: "string", multiple: true },
  json: { type: "boolean" },
};

const INSPECT_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string" },
  field: { type: "string" },
  json: { type: "boolean" },
};

const COMMAND_OPTIONS: Record<string, Record<string, ArgOption>> = {
  init: INIT_OPTIONS,
  dispatch: DISPATCH_OPTIONS,
  complete: COMPLETE_OPTIONS,
  resolve: RESOLVE_OPTIONS,
  inspect: INSPECT_OPTIONS,
};

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (!command || !COMMAND_OPTIONS[command]) {
      throw new Error(
        "Expected command: init | dispatch | complete | resolve | inspect",
      );
    }

    const { values } = parseArgs({
      args,
      options: COMMAND_OPTIONS[command],
      strict: true,
      allowPositionals: false,
    });
    const o: CliOptions = {};
    for (const [key, value] of Object.entries(values)) {
      o[key.replaceAll("-", "_")] = value;
    }
    if (command === "resolve") {
      o.options = o.option;
    }
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
        plan_dispatch_id: o.plan_dispatch_id,
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
