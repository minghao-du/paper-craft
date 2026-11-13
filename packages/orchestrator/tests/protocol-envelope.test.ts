import { expect, it } from "vitest";
import {
  EnvelopeValidationError,
  parseTaskInputEnvelope,
  validateTaskInputEnvelope,
  type TaskInputEnvelope,
} from "../src/protocol/index.js";

const minimalEnvelope: TaskInputEnvelope = {
  schema_version: "1.0",
  task: {
    logical_stage: "workspace_prepare",
    step_index: 0,
    attempt: 1,
    root_issue_id: "42",
    current_issue_id: "42",
  },
  provider: { type: "skill", target: "pc-workspace" },
  environment: { working_directory: "/example/workspace" },
  inputs: { objective: "  Prepare workspace  " },
  contract: { receipt_path: "/example/receipt.md" },
  budgets: {},
};

it("collects errors for present optional fields that violate the envelope type", () => {
  const data = {
    ...minimalEnvelope,
    environment: {
      ...minimalEnvelope.environment,
      repository: 123,
      delivery_target: null,
      base_remote: false,
      push_remote: [],
      base_branch: undefined,
      branch: 123,
      commit: undefined,
    },
    inputs: {
      ...minimalEnvelope.inputs,
      acceptance_criteria: ["valid criterion", 42],
      predecessor_receipts: ["valid receipt", null],
    },
    contract: { ...minimalEnvelope.contract, receipt_template: 123 },
  };

  expect(validateTaskInputEnvelope(data)).toEqual([
    "[environment.repository] Expected string",
    "[environment.delivery_target] Expected string",
    "[environment.base_remote] Expected string",
    "[environment.push_remote] Expected string",
    "[environment.base_branch] Expected string",
    "[environment.branch] Expected string or null",
    "[environment.commit] Expected string or null",
    "[inputs.acceptance_criteria] Expected list of strings",
    "[inputs.predecessor_receipts] Expected list of strings",
    "[contract.receipt_template] Expected string",
  ]);
  expect(() => parseTaskInputEnvelope(data)).toThrow(EnvelopeValidationError);
}, 5000);

it("reports malformed sections without nested field errors", () => {
  expect(
    validateTaskInputEnvelope({
      ...minimalEnvelope,
      environment: null,
      inputs: [],
      contract: 123,
    }),
  ).toEqual([
    "[environment] Expected JSON object (dict)",
    "[inputs] Expected JSON object (dict)",
    "[contract] Expected JSON object (dict)",
  ]);
}, 5000);

it("preserves valid optional values, omitted fields, and extensions", () => {
  const data = {
    ...minimalEnvelope,
    provider: { ...minimalEnvelope.provider, args: [""] },
    environment: {
      ...minimalEnvelope.environment,
      base_branch: "",
      branch: null,
      commit: null,
    },
    inputs: {
      ...minimalEnvelope.inputs,
      scope: "",
      acceptance_criteria: [],
      predecessor_receipts: [""],
      parameters: { specialist_data: [null, 42] },
    },
    contract: { ...minimalEnvelope.contract, receipt_template: "" },
    extension: { note: "  kept as supplied  " },
  };
  const before = structuredClone(data);
  expect(parseTaskInputEnvelope(data)).toBe(data);
  expect(data).toEqual(before);
  expect(parseTaskInputEnvelope(JSON.stringify(before))).toEqual(before);
}, 5000);
