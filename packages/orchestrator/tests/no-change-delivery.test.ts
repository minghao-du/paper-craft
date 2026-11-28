import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  completeDispatch,
  dispatchTask,
  initWorkflow,
  inspectState,
  resolveDecision,
} from "../src/run-operations/index.js";
import { createTestDir, runLifecycleKernelCli } from "./helpers.js";

const workResult = {
  commit: "a".repeat(40),
  quality_gates: "passed",
  self_review: "completed",
  external_compute: "none",
};
const baseline = "b".repeat(40);

it("records direct zero-diff delivery after rework, replays without moving the run, and still requires root acceptance", () => {
  const env = createTestDir("pc-no-change-direct-");
  const receipt_root = env.dir;
  try {
    initWorkflow({ receipt_root, root_issue: "100" });

    function start(stage: string, request_id: string, attempt_intent?: "new") {
      return dispatchTask({
        receipt_root, stage, request_id, objective: "Deliver issue 100",
        workdir: env.dir, attempt_intent,
      });
    }

    function settle(task: ReturnType<typeof start>, result: Record<string, unknown>) {
      fs.writeFileSync(task.receipt_path, "# Verified task receipt\n");
      completeDispatch({
        receipt_root,
        dispatch_id: task.dispatch_id,
        report: { execution_status: "succeeded", result, receipt_path: task.receipt_path, summary: "Verified result" },
      });
    }

    const plan = start("stage_1_plan", "plan");
    settle(plan, { outcome: "direct" });
    resolveDecision({
      receipt_root, decision: "continue", reason: "Direct plan accepted",
      plan_dispatch_id: plan.dispatch_id, next_stage: "stage_2_work",
    });

    const formerWork = start("stage_2_work", "first-work");
    settle(formerWork, workResult);
    const landing = start("stage_2_land", "landing");
    settle(landing, { outcome: "rework_needed" });

    const work = start("stage_2_work", "second-work", "new");
    settle(work, { ...workResult, no_change_base: baseline });
    const accept = {
      receipt_root, decision: "continue" as const,
      reason: "Clean worktree and empty PR diff. Criterion A passed on the fetched baseline.",
      no_change_dispatch_id: work.dispatch_id,
    };
    expect(() => resolveDecision({ ...accept, no_change_dispatch_id: formerWork.dispatch_id }))
      .toThrow(/not a successful receipt/);

    const cli = runLifecycleKernelCli([
      "resolve", "--receipt-root", receipt_root, "--decision", "continue",
      "--no-change-dispatch-id", work.dispatch_id, "--reason", accept.reason,
    ]);
    expect(cli.status, cli.stderr).toBe(0);
    const record = JSON.parse(cli.stdout);
    expect(record).toMatchObject({ next_stage: "stage_3_verify", no_change_base: baseline });
    const statePath = path.join(receipt_root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(state.delivery_sequence).toMatchObject({
      completed: true,
      items: [
        {
          issue_id: "100", landed: false,
          no_change_evidence: {
            dispatch_id: work.dispatch_id, base_commit: baseline, delivery_attempt: 2,
          },
        },
      ],
    });
    expect(state.delivery_sequence.items[0]).not.toHaveProperty("land_dispatch_id");
    expect(() => resolveDecision({ receipt_root, decision: "finish", reason: "Finish" }))
      .toThrow(/root-level acceptance evidence/);

    const verify = start("stage_3_verify", "verify");
    const beforeReplay = fs.readFileSync(statePath, "utf8");
    expect(resolveDecision(accept)).toEqual(record);
    expect(fs.readFileSync(statePath, "utf8")).toBe(beforeReplay);
    expect(() => resolveDecision({ ...accept, reason: "Conflicting rationale" })).toThrow(/Conflicting/);
    settle(verify, { outcome: "verified", evaluatedHead: baseline });
    expect(() => resolveDecision({ receipt_root, decision: "finish", reason: "Finish" }))
      .toThrow(/issue-tree closure evidence/);

    const retry = dispatchTask({
      receipt_root, request_id: "targeted-rework", stage: "stage_2_work",
      objective: "Repair acceptance for issue 100", workdir: env.dir,
      rework_issue: "100", attempt_intent: "new",
    });
    expect(retry.attempt).toBe(3);
    expect(inspectState({ receipt_root, field: "delivery_sequence.items.0" })).not.toHaveProperty("no_change_evidence");
    settle(retry, { ...workResult, no_change_base: "c".repeat(40) });
    expect(resolveDecision({ ...accept, no_change_dispatch_id: retry.dispatch_id }))
      .toMatchObject({ next_stage: "stage_3_verify", no_change_base: "c".repeat(40) });
    expect(() => resolveDecision({ receipt_root, decision: "finish", reason: "Finish" }))
      .toThrow(/repeat verification is required/);
  } finally {
    env.cleanup();
  }
});
