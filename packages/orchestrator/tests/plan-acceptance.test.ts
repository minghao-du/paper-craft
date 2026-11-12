/**
 * Plan Acceptance and Retry Verification Suite.
 *
 * Validates the planning acceptance lifecycle:
 * - Direct vs. decomposed planning acceptance and sequence construction
 * - Idempotent replay returning original DecisionRecord with zero state mutation
 * - Conflict detection on mismatched next_stage
 * - Rejection of invalid combinations, deprecated options, and illegal sources
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  completeDispatch,
  dispatchTask,
  initWorkflow,
  resolveDecision,
} from "../src/lifecycle/index.js";
import { createTestDir, runLifecycleKernelCli } from "./helpers.js";

describe("Plan Acceptance Lifecycle (Phase 2B)", () => {
  it("accepts direct plan, creates 1-item sequence with root issue and preserves replan budgets", () => {
    const env = createTestDir("pc-plan-direct-");
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: "500",
        replans_max: 3,
        delivery_attempts_max: 4,
      });

      const prep = dispatchTask({
        receipt_root: env.dir,
        request_id: "plan-req-1",
        stage: "stage_1_plan",
        objective: "Plan root issue 500",
        provider: { type: "skill", target: "pc-issue-plan" },
        workdir: env.dir,
      });

      fs.writeFileSync(prep.receipt_path, "# Plan Receipt\nDirect delivery");

      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
        report: {
          execution_status: "succeeded",
          result: {
            outcome: "direct",
            summary: "Single delivery item for root issue",
          },
          receipt_path: prep.receipt_path,
          summary: "Direct planning completed",
        },
      });

      const decision = resolveDecision({
        receipt_root: env.dir,
        decision: "continue",
        reason: "Direct plan approved",
        plan_dispatch_id: prep.dispatch_id,
        next_stage: "stage_2_work",
      });

      expect(decision.decision).toBe("continue");
      expect(decision.action).toBe("continue");
      expect(decision.plan_dispatch_id).toBe(prep.dispatch_id);
      expect(decision.next_stage).toBe("stage_2_work");

      const statePath = path.join(env.dir, "state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.current_stage).toBe("stage_2_work");
      expect(state.current_issue_id).toBe("500");
      expect(state.delivery_sequence).toBeDefined();
      expect(state.delivery_sequence.items).toHaveLength(1);
      expect(state.delivery_sequence.items[0].issue_id).toBe("500");
      expect(state.delivery_sequence.items[0].stage).toBe("stage_2_work");
      expect(state.delivery_sequence.items[0].budgets.delivery_attempts_used).toBe(0);
      expect(state.budgets.delivery_attempts_used).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("accepts decomposed plan, creates multi-item sequence and sets first task as current", () => {
    const env = createTestDir("pc-plan-decomposed-");
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: "600",
      });

      const prep = dispatchTask({
        receipt_root: env.dir,
        request_id: "plan-req-decomp",
        stage: "stage_1_plan",
        objective: "Plan root issue 600",
        provider: { type: "skill", target: "pc-issue-plan" },
        workdir: env.dir,
      });

      fs.writeFileSync(prep.receipt_path, "# Plan Receipt\nDecomposed delivery");

      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
        report: {
          execution_status: "succeeded",
          result: {
            outcome: "decomposed",
            plan: {
              tasks: [
                { number: 601, blockedBy: [] },
                { number: 602, blockedBy: [601] },
              ],
            },
          },
          receipt_path: prep.receipt_path,
          summary: "Decomposed into 601 and 602",
        },
      });

      const decision = resolveDecision({
        receipt_root: env.dir,
        decision: "continue",
        reason: "Decomposed plan approved",
        plan_dispatch_id: prep.dispatch_id,
        next_stage: "stage_2_work",
      });

      expect(decision.decision).toBe("continue");
      expect(decision.plan_dispatch_id).toBe(prep.dispatch_id);
      expect(decision.next_stage).toBe("stage_2_work");

      const statePath = path.join(env.dir, "state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.current_stage).toBe("stage_2_work");
      expect(state.current_issue_id).toBe("601");
      expect(state.delivery_sequence.items).toHaveLength(2);
      expect(state.delivery_sequence.items[0].issue_id).toBe("601");
      expect(state.delivery_sequence.items[1].issue_id).toBe("602");
      expect(state.delivery_sequence.items[0].stage).toBe("stage_2_work");
      expect(state.delivery_sequence.items[1].stage).toBe("stage_2_work");
    } finally {
      env.cleanup();
    }
  });

  it("idempotently handles plan acceptance retries with zero state mutation and preserves pause", () => {
    const env = createTestDir("pc-plan-retry-");
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: "700",
      });

      const prep = dispatchTask({
        receipt_root: env.dir,
        request_id: "plan-req-retry",
        stage: "stage_1_plan",
        objective: "Plan root issue 700",
        provider: { type: "skill", target: "pc-issue-plan" },
        workdir: env.dir,
      });

      fs.writeFileSync(prep.receipt_path, "# Plan Receipt\nDirect");

      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
        report: {
          execution_status: "succeeded",
          result: { outcome: "direct" },
          receipt_path: prep.receipt_path,
          summary: "Plan done",
        },
      });

      const firstAcceptance = resolveDecision({
        receipt_root: env.dir,
        decision: "continue",
        reason: "Initial approval",
        plan_dispatch_id: prep.dispatch_id,
        next_stage: "stage_2_work",
      });

      const statePath = path.join(env.dir, "state.json");
      const stateBeforeRetry = fs.readFileSync(statePath, "utf8");

      // Retry with identical key choices (even with a different reason string)
      const secondAcceptance = resolveDecision({
        receipt_root: env.dir,
        decision: "continue",
        reason: "Different retry reason",
        plan_dispatch_id: prep.dispatch_id,
        next_stage: "stage_2_work",
      });

      // Returns exact original DecisionRecord
      expect(secondAcceptance).toEqual(firstAcceptance);
      expect(secondAcceptance.reason).toBe("Initial approval");
      expect(secondAcceptance.timestamp).toBe(firstAcceptance.timestamp);

      // State file on disk has not changed by even a single byte
      const stateAfterRetry = fs.readFileSync(statePath, "utf8");
      expect(stateAfterRetry).toBe(stateBeforeRetry);

      // Subsequent pause must not be lifted by an acceptance retry
      resolveDecision({
        receipt_root: env.dir,
        decision: "halt",
        reason: "Paused for external review",
      });

      const statePaused = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(statePaused.orchestrator_decision).toBe("halt");

      const thirdAcceptance = resolveDecision({
        receipt_root: env.dir,
        decision: "continue",
        reason: "Retry while halted",
        plan_dispatch_id: prep.dispatch_id,
        next_stage: "stage_2_work",
      });

      expect(thirdAcceptance).toEqual(firstAcceptance);
      const stateStillPaused = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(stateStillPaused.orchestrator_decision).toBe("halt");
    } finally {
      env.cleanup();
    }
  });

  it("rejects retry conflict when same plan_dispatch_id is submitted with different next_stage", () => {
    const env = createTestDir("pc-plan-conflict-");
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: "800",
      });

      const prep = dispatchTask({
        receipt_root: env.dir,
        request_id: "plan-req-conflict",
        stage: "stage_1_plan",
        objective: "Plan issue 800",
        provider: { type: "skill", target: "pc-issue-plan" },
        workdir: env.dir,
      });

      fs.writeFileSync(prep.receipt_path, "# Plan Receipt\nDirect");

      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prep.dispatch_id,
        report: {
          execution_status: "succeeded",
          result: { outcome: "direct" },
          receipt_path: prep.receipt_path,
          summary: "Plan done",
        },
      });

      resolveDecision({
        receipt_root: env.dir,
        decision: "continue",
        reason: "First accepted with stage_2_work",
        plan_dispatch_id: prep.dispatch_id,
        next_stage: "stage_2_work",
      });

      const statePath = path.join(env.dir, "state.json");
      const stateBytesBefore = fs.readFileSync(statePath, "utf8");

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Conflict attempt with stage_1_plan",
          plan_dispatch_id: prep.dispatch_id,
          next_stage: "stage_1_plan",
        }),
      ).toThrow(/Conflicting plan acceptance retry/);

      expect(fs.readFileSync(statePath, "utf8")).toBe(stateBytesBefore);
    } finally {
      env.cleanup();
    }
  });

  it("strictly rejects forbidden field combinations and deprecated options", () => {
    const env = createTestDir("pc-plan-forbidden-");
    try {
      // Deprecated options on resolve
      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Using deprecated plan",
          plan: "plan.json",
        } as any),
      ).toThrow(/Resolve option 'plan' has been removed/);

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Using deprecated child_issues",
          child_issues: ["801"],
        } as any),
      ).toThrow(/Resolve option 'child_issues' has been removed/);

      // Forbidden combinations with plan_dispatch_id
      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Mixed with current_issue",
          plan_dispatch_id: "disp-1",
          next_stage: "stage_2_work",
          current_issue: "801",
        }),
      ).toThrow(/Field 'current_issue' cannot be combined with 'plan_dispatch_id'/);

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Mixed with mark_landed",
          plan_dispatch_id: "disp-1",
          next_stage: "stage_2_work",
          mark_landed: "801",
        }),
      ).toThrow(/Field 'mark_landed' cannot be combined with 'plan_dispatch_id'/);

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Mixed with complete_sequence",
          plan_dispatch_id: "disp-1",
          next_stage: "stage_2_work",
          complete_sequence: false,
        }),
      ).toThrow(/Field 'complete_sequence' cannot be combined with 'plan_dispatch_id'/);

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Mixed with options",
          plan_dispatch_id: "disp-1",
          next_stage: "stage_2_work",
          options: ["opt1"],
        }),
      ).toThrow(/Field 'options' cannot be combined with 'plan_dispatch_id'/);

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "wait_user",
          reason: "Wrong decision for plan acceptance",
          plan_dispatch_id: "disp-1",
          next_stage: "stage_2_work",
        }),
      ).toThrow(/Decision must be 'continue' when accepting a plan/);

      // CLI rejects --plan and --child-issue on resolve
      const cliRes = runLifecycleKernelCli([
        "resolve",
        "--receipt-root",
        env.dir,
        "--decision",
        "continue",
        "--reason",
        "CLI test",
        "--child-issue",
        "801",
      ]);
      expect(cliRes.status).not.toBe(0);
      expect(cliRes.stderr).toContain("Unknown option '--child-issue'");
    } finally {
      env.cleanup();
    }
  });

  it("rejects illegal sources: missing, failed, wrong stage, or already-present sequence", () => {
    const env = createTestDir("pc-plan-illegal-");
    try {
      initWorkflow({
        receipt_root: env.dir,
        root_issue: "900",
      });

      // 1. Non-existent plan_dispatch_id
      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Non-existent",
          plan_dispatch_id: "does-not-exist",
          next_stage: "stage_2_work",
        }),
      ).toThrow(/not found in completed stages/);

      // 2. Non-planning stage (workspace_prepare)
      const prepAux = dispatchTask({
        receipt_root: env.dir,
        request_id: "aux-req",
        stage: "workspace_prepare",
        objective: "Prepare workspace",
        provider: { type: "skill", target: "pc-workspace" },
        workdir: env.dir,
      });
      fs.writeFileSync(prepAux.receipt_path, "# Aux Receipt");
      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prepAux.dispatch_id,
        report: {
          execution_status: "succeeded",
          result: { outcome: "prepared" },
          receipt_path: prepAux.receipt_path,
          summary: "Workspace prepared",
        },
      });

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Wrong stage",
          plan_dispatch_id: prepAux.dispatch_id,
          next_stage: "stage_2_work",
        }),
      ).toThrow(/is not an initial planning stage/);

      // 3. Failed planning stage
      const prepPlan = dispatchTask({
        receipt_root: env.dir,
        request_id: "plan-failed-req",
        stage: "stage_1_plan",
        objective: "Plan task",
        provider: { type: "skill", target: "pc-issue-plan" },
        workdir: env.dir,
      });
      fs.writeFileSync(prepPlan.receipt_path, "# Failed Receipt");
      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prepPlan.dispatch_id,
        report: {
          execution_status: "failed",
          result: { error: "Planning failed" },
          receipt_path: prepPlan.receipt_path,
          summary: "Planning failed",
        },
      });

      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Failed source",
          plan_dispatch_id: prepPlan.dispatch_id,
          next_stage: "stage_2_work",
        }),
      ).toThrow(/execution status is 'failed', expected 'succeeded'/);

      // 4. Successful plan is accepted
      const prepPlanSuccess = dispatchTask({
        receipt_root: env.dir,
        request_id: "plan-success-req",
        stage: "stage_1_plan",
        objective: "Plan task",
        provider: { type: "skill", target: "pc-issue-plan" },
        workdir: env.dir,
      });
      fs.writeFileSync(prepPlanSuccess.receipt_path, "# Success Receipt");
      completeDispatch({
        receipt_root: env.dir,
        dispatch_id: prepPlanSuccess.dispatch_id,
        report: {
          execution_status: "succeeded",
          result: { outcome: "direct" },
          receipt_path: prepPlanSuccess.receipt_path,
          summary: "Plan success",
        },
      });

      resolveDecision({
        receipt_root: env.dir,
        decision: "continue",
        reason: "Valid acceptance",
        plan_dispatch_id: prepPlanSuccess.dispatch_id,
        next_stage: "stage_2_work",
      });

      // 5. Trying to accept another plan when sequence already exists
      expect(() =>
        resolveDecision({
          receipt_root: env.dir,
          decision: "continue",
          reason: "Another plan",
          plan_dispatch_id: "another-dispatch",
          next_stage: "stage_2_work",
        }),
      ).toThrow(/a delivery sequence already exists/);
    } finally {
      env.cleanup();
    }
  });
});
