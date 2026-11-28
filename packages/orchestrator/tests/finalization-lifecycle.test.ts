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

it("keeps a defective tree finalization open until the same worker supplies evidence for cleanup", () => {
  const env = createTestDir("pc-finalization-");
  const receipt_root = env.dir;
  try {
    initWorkflow({ receipt_root, root_issue: "100" });

    function dispatch(stage: string, scope?: string) {
      return dispatchTask({
        receipt_root, stage, request_id: stage, objective: "Deliver issue 100",
        workdir: env.dir, scope,
      });
    }

    function report(task: ReturnType<typeof dispatch>, result: Record<string, unknown>) {
      fs.writeFileSync(task.receipt_path, "# Confirmed task receipt\n");
      return {
        dispatch_id: task.dispatch_id, execution_status: "succeeded",
        result, receipt_path: task.receipt_path, summary: "Confirmed task result.",
      };
    }

    function settle(task: ReturnType<typeof dispatch>, result: Record<string, unknown>) {
      return completeDispatch({ receipt_root, report: report(task, result) });
    }

    const plan = dispatch("stage_1_plan");
    settle(plan, { outcome: "direct" });
    resolveDecision({
      receipt_root, decision: "continue", reason: "Direct plan accepted",
      plan_dispatch_id: plan.dispatch_id, next_stage: "stage_2_work",
    });
    const work = dispatch("stage_2_work");
    const head = "a".repeat(40);
    settle(work, {
      commit: head, no_change_base: head, quality_gates: "passed",
      self_review: "completed", external_compute: "none",
    });
    resolveDecision({
      receipt_root, decision: "continue", reason: "Acceptance confirmed on the unchanged baseline.",
      no_change_dispatch_id: work.dispatch_id,
    });
    const verification = dispatch("stage_3_verify");
    settle(verification, { outcome: "verified", evaluatedHead: head });
    const research = dispatch("stage_6_research_record");
    settle(research, { outcome: "recorded" });

    const finalization = dispatch("issue_finalize", "tree");
    const statePath = path.join(receipt_root, "state.json");
    const before = fs.readFileSync(statePath, "utf8");
    const rootIssue = { repository: "OWNER/REPO", number: 100, state: "CLOSED" };
    const childIssue = { repository: "OWNER/REPO", number: 101, state: "CLOSED" };
    const joined = `${verification.receipt_path}; ${research.receipt_path}`;
    const result = {
      outcome: "finalized", root_issue_id: "100", scope: "tree", candidates: [], unresolved: [],
    };
    const malformed = report(finalization, {
      ...result,
      issues: [
        { ...rootIssue, receipt: joined },
        { ...childIssue, receipt: work.receipt_path },
      ],
    });
    const cli = runLifecycleKernelCli([
      "complete", "--receipt-root", receipt_root, "--report", JSON.stringify(malformed),
    ]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual({
      action: "continue_same_dispatch",
      dispatch_id: finalization.dispatch_id,
      missing_evidence: [
        expect.stringMatching(/issues\[0\]\.acceptance_receipt.*100.*required/),
        expect.stringContaining(`Use the single path ${JSON.stringify(verification.receipt_path)}`),
        expect.stringMatching(/issues\[1\]\.acceptance_receipt.*101.*required/),
      ],
    });

    const child = { ...childIssue, acceptance_receipt: work.receipt_path };
    const tree = [{ ...rootIssue, acceptance_receipt: verification.receipt_path }, child];
    expect(settle(finalization, {
      ...result, scope: "issue", issues: tree,
    })).toMatchObject({
      action: "continue_same_dispatch", dispatch_id: finalization.dispatch_id,
      missing_evidence: [expect.stringContaining("result.scope")],
    });
    expect(settle(finalization, {
      ...result, issues: [{ ...rootIssue, acceptance_receipt: joined }, child],
    })).toMatchObject({
      action: "continue_same_dispatch", dispatch_id: finalization.dispatch_id,
      missing_evidence: [expect.stringContaining(verification.receipt_path)],
    });
    expect(fs.readFileSync(statePath, "utf8")).toBe(before);
    expect(inspectState({ receipt_root }).cleanup).toBeUndefined();

    expect(settle(finalization, { ...result, issues: tree })).toMatchObject({
      dispatch_id: finalization.dispatch_id, execution_status: "succeeded",
    });
    expect(inspectState({ receipt_root }).cleanup).toMatchObject({
      status: "first_attempt", parameters: { candidates: [], unresolved: [] },
    });
    settle(dispatch("workspace_cleanup"), {
      outcome: "cleaned", removed_paths: [], retained_paths: [],
      removed_branches: [], retained_branches: [],
    });
    expect(inspectState({ receipt_root }).finish_check.status).toBe("ready");
    expect(resolveDecision({ receipt_root, decision: "finish", reason: "Closure and cleanup verified." }))
      .toMatchObject({ decision: "finish" });
  } finally {
    env.cleanup();
  }
});
