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
  type InitOptions,
  type DispatchOptions,
  type CompleteOptions,
  type ResolveOptions,
  type InspectOptions,
} from "./lifecycle/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CliOptions = Record<string, any>;

export function loadDispatchRequest(filename: string): unknown {
  if (!path.isAbsolute(filename)) {
    throw new Error(`Request path must be absolute, received '${filename}'`);
  }
  const content = fs.readFileSync(filename, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid dispatch request JSON: ${String(error)}`, {
      cause: error,
    });
  }
}

/**
 * Reads a compact report payload from an inline JSON object string or file path.
 * Decoding and schema validation stay in Lifecycle/Protocol so protocol errors
 * correlate with the target dispatch on the same path as programmatic callers.
 */
export function readReportText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  const filePath = path.resolve(trimmed);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Report file not found: ${filePath}`);
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read report file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

type ArgOption =
  | { type: "boolean" }
  | { type: "string"; valueLabel: string; required?: true; multiple?: true };

const CLI_INVOCATION = "node --import tsx packages/orchestrator/src/cli.ts";
const HELP_OPTION = { type: "boolean", short: "h" } as const;
const VALID_DECISIONS = ["wait_user", "continue", "halt", "finish"];

const INIT_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string", valueLabel: "directory" },
  "root-issue": { type: "string", valueLabel: "issue-id", required: true },
  "repo-dir": { type: "string", valueLabel: "directory" },
  workflow: { type: "string", valueLabel: "default|workflow-json-path" },
  force: { type: "boolean" },
  "require-config": { type: "boolean" },
  "delivery-attempts-max": { type: "string", valueLabel: "integer" },
  "replans-max": { type: "string", valueLabel: "integer" },
  "delivery-target": { type: "string", valueLabel: "owner/repo" },
  "base-remote": { type: "string", valueLabel: "remote" },
  "push-remote": { type: "string", valueLabel: "remote" },
  "base-branch": { type: "string", valueLabel: "branch" },
  "worktree-container": { type: "string", valueLabel: "directory" },
  json: { type: "boolean" },
};

const DISPATCH_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": {
    type: "string",
    valueLabel: "absolute-directory",
    required: true,
  },
  request: { type: "string", valueLabel: "absolute-json-path", required: true },
  json: { type: "boolean" },
};

const COMPLETE_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string", valueLabel: "directory", required: true },
  "dispatch-id": { type: "string", valueLabel: "id", required: true },
  report: { type: "string", valueLabel: "inline-json|file-path", required: true },
  json: { type: "boolean" },
};

const RESOLVE_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string", valueLabel: "directory", required: true },
  decision: {
    type: "string",
    valueLabel: VALID_DECISIONS.join("|"),
    required: true,
  },
  reason: { type: "string", valueLabel: "text", required: true },
  "next-stage": { type: "string", valueLabel: "stage" },
  "plan-dispatch-id": { type: "string", valueLabel: "id" },
  "current-issue": { type: "string", valueLabel: "issue-id" },
  "mark-landed": { type: "string", valueLabel: "issue-id" },
  "landing-dispatch-id": { type: "string", valueLabel: "id" },
  "complete-sequence": { type: "boolean" },
  option: { type: "string", valueLabel: "text", multiple: true },
  json: { type: "boolean" },
};

const INSPECT_OPTIONS: Record<string, ArgOption> = {
  "receipt-root": { type: "string", valueLabel: "directory", required: true },
  field: { type: "string", valueLabel: "field-path" },
  json: { type: "boolean" },
};

const COMMAND_OPTIONS: Record<string, Record<string, ArgOption>> = {
  init: INIT_OPTIONS,
  dispatch: DISPATCH_OPTIONS,
  complete: COMPLETE_OPTIONS,
  resolve: RESOLVE_OPTIONS,
  inspect: INSPECT_OPTIONS,
};

const COMMAND_NAMES = Object.keys(COMMAND_OPTIONS).join(" | ");

function formatUsage(command?: string): string {
  if (command === undefined) {
    return [
      `Usage: ${CLI_INVOCATION} <command> [options]`,
      `Commands: ${COMMAND_NAMES}`,
      "Run from the repository root. Use <command> --help for command options.",
    ].join("\n");
  }

  const required: string[] = [];
  const optional = ["  -h, --help"];
  for (const [name, option] of Object.entries(COMMAND_OPTIONS[command])) {
    const flag = `--${name}`;
    if (option.type === "boolean") {
      optional.push(`  ${flag}`);
    } else {
      const labeledFlag = `${flag} <${option.valueLabel}>`;
      if (option.required) {
        required.push(labeledFlag);
      } else {
        optional.push(
          `  ${labeledFlag}${option.multiple ? " (repeatable)" : ""}`,
        );
      }
    }
  }

  return [
    `Usage: ${CLI_INVOCATION} ${command} ${required.join(" ")} [options]`,
    "",
    "Options:",
    ...optional,
  ].join("\n");
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const [command, ...args] = argv;
    if (args.length === 0 && (command === "-h" || command === "--help")) {
      process.stdout.write(`${formatUsage()}\n`);
      return 0;
    }
    if (!command || !Object.hasOwn(COMMAND_OPTIONS, command)) {
      throw new Error(`Expected command: ${COMMAND_NAMES}`);
    }

    const { values } = parseArgs({
      args,
      options: { ...COMMAND_OPTIONS[command], help: HELP_OPTION },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      process.stdout.write(`${formatUsage(command)}\n`);
      return 0;
    }

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
      const initOpts: InitOptions = {
        root_issue: o.root_issue,
        ...(o.receipt_root ? { receipt_root: o.receipt_root } : {}),
        ...(o.repo_dir ? { repo_dir: o.repo_dir } : {}),
        ...(o.workflow ? { workflow: o.workflow } : {}),
        ...(o.force !== undefined ? { force: Boolean(o.force) } : {}),
        ...(o.require_config !== undefined
          ? { require_config: Boolean(o.require_config) }
          : {}),
        ...(o.delivery_attempts_max !== undefined
          ? { delivery_attempts_max: Number(o.delivery_attempts_max) }
          : {}),
        ...(o.replans_max !== undefined
          ? { replans_max: Number(o.replans_max) }
          : {}),
        ...(o.delivery_target ? { delivery_target: o.delivery_target } : {}),
        ...(o.base_remote ? { base_remote: o.base_remote } : {}),
        ...(o.push_remote ? { push_remote: o.push_remote } : {}),
        ...(o.base_branch ? { base_branch: o.base_branch } : {}),
        ...(o.worktree_container
          ? { worktree_container: o.worktree_container }
          : {}),
      };
      result = initWorkflow(initOpts);
    } else if (command === "dispatch") {
      if (!path.isAbsolute(o.receipt_root)) {
        throw new Error(
          `Receipt root must be absolute, received '${o.receipt_root}'`,
        );
      }
      if (!o.request) throw new Error("--request is required");
      const decodedRequest = loadDispatchRequest(o.request);
      if (
        !decodedRequest ||
        typeof decodedRequest !== "object" ||
        Array.isArray(decodedRequest)
      ) {
        throw new Error("Dispatch request must be a JSON object");
      }
      const requestRecord = decodedRequest as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(requestRecord, "receipt_root")) {
        throw new Error(
          "Dispatch request cannot specify 'receipt_root'; use CLI --receipt-root.",
        );
      }
      result = dispatchTask({
        ...requestRecord,
        receipt_root: o.receipt_root,
      } as DispatchOptions);
    } else if (command === "complete") {
      if (!o.dispatch_id) {
        throw new Error("--dispatch-id is required for complete");
      }
      if (!o.report) throw new Error("--report is required");
      const reportText = readReportText(String(o.report));
      result = completeDispatch({
        receipt_root: o.receipt_root,
        dispatch_id: o.dispatch_id,
        report: reportText,
      } as CompleteOptions);
    } else if (command === "resolve") {
      if (!o.decision || !o.reason) {
        throw new Error("--decision and --reason are required");
      }
      if (!VALID_DECISIONS.includes(o.decision)) {
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
