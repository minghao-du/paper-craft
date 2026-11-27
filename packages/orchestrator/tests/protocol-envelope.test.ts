import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  EnvelopeValidationError,
  parseTaskInputEnvelope,
  validateTaskInputEnvelope,
  type TaskInputEnvelope,
} from "../src/protocol/index.js";
import {
  createEnvelope,
  loadEnvelope,
  EnvelopeCorruptedError,
} from "../src/run-operations/envelope.js";
import type { EnvelopeCreateOptions } from "../src/run-operations/types.js";

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

it("createEnvelope always validates constructed envelopes even with untyped validate: false", () => {
  const invalidStructured = {
    task: {
      logical_stage: "stage",
      step_index: 0,
      attempt: 1,
      root_issue_id: "1",
    },
    provider: {
      type: "unsupported",
      target: "foo",
    },
    environment: {
      working_directory: "/workspace",
      repository: "repo",
    },
    inputs: {
      objective: "test",
    },
    contract: {
      receipt_path: "/receipt.md",
    },
    budgets: {},
    validate: false,
  } as unknown as EnvelopeCreateOptions;

  expect(() => createEnvelope(invalidStructured)).toThrow(
    EnvelopeValidationError,
  );

  const invalidVersion = {
    schema_version: "2.0",
    task: {
      logical_stage: "stage",
      step_index: 0,
      attempt: 1,
      root_issue_id: "1",
    },
    provider: {
      type: "skill",
      target: "foo",
    },
    environment: {
      working_directory: "/workspace",
      repository: "repo",
    },
    inputs: {
      objective: "test",
    },
    contract: {
      receipt_path: "/receipt.md",
    },
    budgets: {},
    validate: false,
  } as unknown as EnvelopeCreateOptions;

  expect(() => createEnvelope(invalidVersion)).toThrow(
    EnvelopeValidationError,
  );

  const invalidFlat = {
    logical_stage: "stage",
    step_index: 0,
    root_issue_id: "1",
    provider_type: "unsupported",
    provider_target: "foo",
    objective: "test",
    receipt_path: "/receipt.md",
    validate: false,
  } as unknown as EnvelopeCreateOptions;

  expect(() => createEnvelope(invalidFlat)).toThrow(EnvelopeValidationError);

  const validStructured: EnvelopeCreateOptions = {
    task: {
      logical_stage: "workspace_prepare",
      step_index: 0,
      root_issue_id: "1",
    },
    provider: {
      target: "pc-workspace",
    },
    environment: {
      working_directory: "/workspace",
      repository: "repo",
    },
    inputs: {
      objective: "test",
    },
    contract: {
      receipt_path: "/receipt.md",
    },
    budgets: {},
  };

  const envelope = createEnvelope(validStructured);
  expect(envelope.schema_version).toBe("1.0");
  expect(envelope.provider.type).toBe("skill");
}, 5000);

it("loadEnvelope distinguishes filesystem read failures from corrupted JSON and supports raw load", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "envelope-load-test-"),
  );
  try {
    // Missing file throws standard Error
    expect(() =>
      loadEnvelope(path.join(tempDir, "nonexistent.json")),
    ).toThrow("Envelope file not found");

    // Filesystem read failure (reading a directory) throws IO error, NOT EnvelopeCorruptedError
    try {
      loadEnvelope(tempDir);
      expect.unreachable("loadEnvelope on directory should have thrown");
    } catch (err: unknown) {
      expect(err).not.toBeInstanceOf(EnvelopeCorruptedError);
      expect((err as NodeJS.ErrnoException).code).toBe("EISDIR");
    }

    // Corrupted JSON throws EnvelopeCorruptedError
    const corruptFile = path.join(tempDir, "corrupt.json");
    fs.writeFileSync(corruptFile, "{\"invalid_json", "utf8");
    expect(() => loadEnvelope(corruptFile)).toThrow(EnvelopeCorruptedError);

    // Raw load (validate: false) loads non-envelope JSON without validation error
    const nonEnvelopeFile = path.join(tempDir, "non-envelope.json");
    fs.writeFileSync(
      nonEnvelopeFile,
      JSON.stringify({ some_custom_field: 123 }),
      "utf8",
    );
    const rawLoaded = loadEnvelope(nonEnvelopeFile, false);
    expect(rawLoaded).toEqual({ some_custom_field: 123 });

    // Validating load throws EnvelopeValidationError on non-envelope JSON
    expect(() => loadEnvelope(nonEnvelopeFile)).toThrow(
      EnvelopeValidationError,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}, 5000);
