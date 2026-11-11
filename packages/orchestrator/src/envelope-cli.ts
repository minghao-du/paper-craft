/** Internal skill helper; not a separate execution provider. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvelope } from "./lifecycle/index.js";
import { isObject, validateTaskInputEnvelope } from "./protocol/index.js";

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" }, field: { type: "string" } },
    });
    const [command, filename] = positionals;
    if (
      !["validate", "show"].includes(command) ||
      !filename ||
      positionals.length !== 2
    ) {
      throw new Error(
        "Usage: envelope-cli.ts <validate|show> <envelope_path> [--json] [--field <path>]",
      );
    }
    const absolute = path.resolve(filename);
    const data = loadEnvelope(absolute, false);
    if (command === "validate") {
      const errors = validateTaskInputEnvelope(data);
      if (values.json) console.log(JSON.stringify(errors, null, 2));
      else if (errors.length)
        console.error(
          `Validation failed for ${absolute}:\n  - ${errors.join("\n  - ")}`,
        );
      else console.log(`Valid envelope: ${absolute}`);
      if (errors.length) return 1;
      return 0;
    }
    if (values.json) {
      console.log(JSON.stringify(data, null, 2));
      return 0;
    }
    if (values.field) {
      let value: unknown = data;
      for (const key of values.field.split(".")) {
        if (!isObject(value) || !(key in value))
          throw new Error(`Field '${values.field}' not found in envelope.`);
        value = value[key];
      }
      console.log(
        typeof value === "object" ? JSON.stringify(value, null, 2) : value,
      );
      return 0;
    }
    if (!isObject(data)) throw new Error("Envelope must be a JSON object");
    const section = (name: string) => (isObject(data[name]) ? data[name] : {});
    const t = section("task"),
      e = section("environment"),
      p = section("provider"),
      b = section("budgets");
    const inputs = section("inputs"),
      contract = section("contract");
    const criteria = inputs.acceptance_criteria;
    console.log(
      `Envelope: ${absolute} (v${data.schema_version ?? "1.0"})\nTask: ${t.logical_stage ?? "unknown"} (step ${t.step_index ?? "?"}, attempt ${t.attempt ?? "?"}) | Root: #${t.root_issue_id ?? "?"}, Current: #${t.current_issue_id ?? "?"}\nProvider: ${p.type ?? "unknown"} -> ${p.target ?? "unknown"}\nEnvironment: ${e.working_directory ?? "unknown"} (repo: ${e.repository ?? ""}, base: ${e.base_branch ?? ""}, branch: ${e.branch ?? ""})\nInputs: Objective="${inputs.objective ?? ""}", Criteria=${Array.isArray(criteria) ? criteria.length : 0}\nContract: Receipt=${contract.receipt_path ?? ""}\nBudgets: Delivery=${b.delivery_attempts_used ?? 0}/${b.delivery_attempts_max ?? 3}, Replans=${b.replans_used ?? 0}/${b.replans_max ?? 2}`,
    );
    return 0;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
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
      console.error(String(err));
      process.exit(1);
    });
}
