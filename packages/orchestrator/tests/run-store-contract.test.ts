import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  commitRun,
  inspectRunStorage,
  loadRun,
  replaceRun,
  StorageInconsistentError,
  StorageIOError,
} from "../src/run-store/index.js";

let root: string;
let statePath: string;
let pendingPath: string;

const previous = { step: 0 };
const target = { step: 1 };
const next = { step: 2 };
const envelope = { filename: "01-input.json", content: { step: 1 } };

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-run-store-"));
  statePath = path.join(root, "state.json");
  pendingPath = path.join(root, "pending-commit.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a new commit leaves pending work intact until it is recovered", () => {
  writeJson(statePath, previous);
  writeJson(pendingPath, {
    version: "1.0",
    expected_previous_state: previous,
    target_state: target,
    envelope,
  });
  const pendingBytes = fs.readFileSync(pendingPath, "utf8");
  const stateBytes = fs.readFileSync(statePath, "utf8");
  const envelopePath = path.join(root, envelope.filename);

  expect(() =>
    commitRun(root, {
      expected_previous_state: previous,
      target_state: next,
      envelope: { filename: "02-input.json", content: next },
    }),
  ).toThrow(expect.objectContaining({ code: "STORAGE_RECOVERY_REQUIRED" }));
  expect(fs.readFileSync(pendingPath, "utf8")).toBe(pendingBytes);
  expect(fs.readFileSync(statePath, "utf8")).toBe(stateBytes);
  expect(fs.readdirSync(root).sort()).toEqual([
    "pending-commit.json",
    "state.json",
  ]);

  const recovered = loadRun(root);
  expect(recovered).toEqual(target);
  expect(JSON.parse(fs.readFileSync(envelopePath, "utf8"))).toEqual(
    envelope.content,
  );
  const nestedEnvelope = { filename: "nested/state.json", content: next };
  commitRun(root, {
    expected_previous_state: recovered,
    target_state: next,
    envelope: nestedEnvelope,
  });
  expect(
    JSON.parse(
      fs.readFileSync(path.join(root, nestedEnvelope.filename), "utf8"),
    ),
  ).toEqual(next);
  expect(loadRun(root)).toEqual(next);
}, 5_000);

test.each([
  {
    description: "missing previous state",
    fields: {},
  },
  {
    description: "reserved envelope path",
    fields: {
      expected_previous_state: previous,
      envelope: { filename: "./sub/../state.json", content: target },
    },
  },
])(
  "inspection and recovery preserve pending evidence with $description",
  ({ fields }) => {
    writeJson(statePath, target);
    writeJson(pendingPath, {
      version: "1.0",
      target_state: target,
      ...fields,
    });
    const pendingBytes = fs.readFileSync(pendingPath, "utf8");

    expect(inspectRunStorage(root)).toMatchObject({
      pending: null,
      pendingCorrupt: true,
    });
    expect(() => loadRun(root)).toThrow(StorageInconsistentError);
    expect(fs.readFileSync(pendingPath, "utf8")).toBe(pendingBytes);
    expect(fs.readFileSync(statePath, "utf8")).toBe(JSON.stringify(target));
  },
  5_000,
);

test.each([
  "state.json",
  "./state.json",
  "pending-commit.json",
  "sub/../state.json",
  "sub/../pending-commit.json",
])(
  "a commit rejects reserved envelope path %s before writing",
  (filename) => {
    expect(() =>
      commitRun(root, {
        expected_previous_state: null,
        target_state: target,
        envelope: { filename, content: envelope.content },
      }),
    ).toThrow(StorageInconsistentError);
    expect(fs.readdirSync(root)).toEqual([]);
  },
  5_000,
);

test("a pending read failure propagates without archiving or replacing the run", () => {
  writeJson(statePath, previous);
  writeJson(pendingPath, {
    version: "1.0",
    expected_previous_state: previous,
    target_state: target,
  });
  const readFileSync = fs.readFileSync;
  const pendingBytes = readFileSync(pendingPath, "utf8");
  const read = vi
    .spyOn(fs, "readFileSync")
    .mockImplementation((file, options) => {
      if (file === pendingPath) {
        throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
      }
      return readFileSync(file, options);
    });

  expect(() => inspectRunStorage(root)).toThrow(StorageIOError);
  expect(() => replaceRun(root, next)).toThrow(StorageIOError);
  read.mockRestore();

  expect(fs.readdirSync(root).sort()).toEqual([
    "pending-commit.json",
    "state.json",
  ]);
  expect(readFileSync(pendingPath, "utf8")).toBe(pendingBytes);
  expect(readFileSync(statePath, "utf8")).toBe(JSON.stringify(previous));
}, 5_000);

test("a pending removal failure leaves the written state recoverable", () => {
  writeJson(statePath, previous);
  const unlinkSync = fs.unlinkSync;
  const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
    if (file === pendingPath) {
      throw Object.assign(new Error("injected EPERM"), { code: "EPERM" });
    }
    unlinkSync(file);
  });

  expect(() =>
    commitRun(root, {
      expected_previous_state: previous,
      target_state: target,
    }),
  ).toThrow(StorageIOError);
  expect(inspectRunStorage(root)).toMatchObject({
    state: target,
    pending: { target_state: target },
    pendingCorrupt: false,
  });

  unlink.mockRestore();
  expect(loadRun(root)).toEqual(target);
  expect(fs.existsSync(pendingPath)).toBe(false);
}, 5_000);
