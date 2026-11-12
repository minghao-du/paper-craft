import { describe, expect, it } from "vitest";
import { applyDeliveryDecision } from "../src/workflow/delivery.js";
import type {
  ApplyDeliveryDecisionParams,
  DeliverySequence,
  PlanningSource,
  WorkflowDefinition,
} from "../src/workflow/types.js";

const workflow: WorkflowDefinition = {
  name: "t",
  completion_policy: "issue_delivery",
  stages: [
    {
      id: "stage_2_work",
      provider: { type: "skill", target: "pc-issue-work" },
    },
    { id: "stage_2_land", provider: { type: "skill", target: "pc-pr-land" } },
  ],
};

function makeTestDeliverySequence(
  ids: string[],
  max = 3,
  stage = "stage_2_work",
): DeliverySequence {
  return {
    items: ids.map((issue_id) => ({
      issue_id,
      stage,
      status: "pending",
      budgets: { delivery_attempts_used: 0, delivery_attempts_max: max },
      landed: false,
    })),
    current_index: 0,
    completed: false,
  };
}

const landed = {
  dispatch_id: "d1",
  issue_id: "1",
  stage: "stage_2_land",
  execution_status: "succeeded",
  result: { outcome: "landed", merged: true, mergedCommit: "abc" },
  receipt_path: "/r/d1.json",
  step_index: 3,
};

function params(
  over: Partial<ApplyDeliveryDecisionParams> = {},
  record: Record<string, unknown> = {},
): ApplyDeliveryDecisionParams {
  return {
    deliverySequence: makeTestDeliverySequence(["1", "2"], 3),
    budgets: {
      delivery_attempts_used: 0,
      delivery_attempts_max: 3,
      replans_used: 0,
      replans_max: 1,
    },
    currentIssueId: "1",
    rootIssueId: "0",
    decision: "d",
    action: "a",
    workflow,
    markLanded: "1",
    landingDispatchId: "d1",
    completedStages: [{ ...landed, ...record }],
    ...over,
  };
}

describe("delivery landing evidence", () => {
  it("lands with the evidence record's receipt and is idempotent", () => {
    const first = applyDeliveryDecision(params());
    const item = first.deliverySequence!.items[0];
    expect(item.landed).toBe(true);
    expect(item.land_receipt_path).toBe("/r/d1.json");
    const again = applyDeliveryDecision(
      params({ deliverySequence: first.deliverySequence }),
    );
    expect(again.deliverySequence!.items[0].land_receipt_path).toBe(
      "/r/d1.json",
    );
  });

  it.each([
    ["missing dispatch id", { landingDispatchId: null }, {}],
    ["unknown dispatch", { landingDispatchId: "nope" }, {}],
    ["other issue", {}, { issue_id: "2" }],
    ["legacy record without issue_id", {}, { issue_id: undefined }],
    ["non-landing stage", {}, { stage: "stage_2_work" }],
    ["failed execution", {}, { execution_status: "failed" }],
    [
      "rework outcome",
      {},
      { result: { outcome: "rework_needed", merged: false } },
    ],
    ["unmerged", {}, { result: { outcome: "landed", merged: false } }],
    ["unknown issue", { markLanded: "9" }, { issue_id: "9" }],
  ])("rejects %s without mutating state", (_n, over, record) => {
    const p = params(over as never, record);
    const before = structuredClone(p.deliverySequence);
    expect(() => applyDeliveryDecision(p)).toThrow();
    expect(p.deliverySequence).toEqual(before);
  });

  it("rejects different evidence for an already-landed issue", () => {
    const first = applyDeliveryDecision(params());
    expect(() =>
      applyDeliveryDecision(
        params(
          { deliverySequence: first.deliverySequence, landingDispatchId: "d2" },
          { dispatch_id: "d2" },
        ),
      ),
    ).toThrow(/already landed/);
  });

  it("completes only when every item landed; completion is idempotent", () => {
    const partial = applyDeliveryDecision(params());
    const attempt = params({
      deliverySequence: partial.deliverySequence,
      markLanded: null,
      landingDispatchId: null,
      completeSequence: true,
    });
    expect(() => applyDeliveryDecision(attempt)).toThrow(/2/);
    expect(() =>
      applyDeliveryDecision(
        params({
          completeSequence: true,
          deliverySequence: undefined,
          markLanded: null,
          landingDispatchId: null,
        }),
      ),
    ).toThrow(/none exists/);

    const second = applyDeliveryDecision(
      params(
        {
          deliverySequence: partial.deliverySequence,
          markLanded: "2",
          landingDispatchId: "d2",
        },
        { dispatch_id: "d2", issue_id: "2", receipt_path: "/r/d2.json" },
      ),
    );
    const done = applyDeliveryDecision(
      params({
        deliverySequence: second.deliverySequence,
        markLanded: null,
        landingDispatchId: null,
        completeSequence: true,
      }),
    );
    expect(done.deliverySequence!.completed).toBe(true);
    expect(done.currentIssueId).toBe("0");
    const repeat = applyDeliveryDecision(
      params({
        deliverySequence: done.deliverySequence,
        currentIssueId: "0",
        markLanded: null,
        landingDispatchId: null,
        completeSequence: true,
      }),
    );
    expect(repeat.currentIssueId).toBe("0");
  });
});

describe("planning source acceptance in applyDeliveryDecision", () => {
  function makePlanningSource(result: Record<string, unknown>): PlanningSource {
    return {
      dispatch_id: "p1",
      issue_id: "100",
      stage: "stage_1_plan",
      step_index: 1,
      execution_status: "succeeded",
      provider: { type: "skill", target: "pc-issue-plan" },
      result,
      receipt_path: "/r/p1.json",
    };
  }

  function basePlanningParams(
    over: Partial<ApplyDeliveryDecisionParams> = {},
  ): ApplyDeliveryDecisionParams {
    return {
      budgets: {
        delivery_attempts_used: 1,
        delivery_attempts_max: 3,
        replans_used: 1,
        replans_max: 2,
        replans_by_stage: { stage_1_plan: 1 },
      },
      currentIssueId: "100",
      rootIssueId: "100",
      decision: "continue",
      action: "continue",
      workflow,
      ...over,
    };
  }

  it("accepts direct planning outcome: creates 1-item sequence and migrates root replan budgets", () => {
    const ps = makePlanningSource({
      outcome: "direct",
      summary: "single delivery",
    });
    const res = applyDeliveryDecision(
      basePlanningParams({ planningSource: ps, nextStage: "stage_2_work" }),
    );

    expect(res.deliverySequence).toBeDefined();
    expect(res.deliverySequence!.items).toHaveLength(1);
    const item = res.deliverySequence!.items[0];
    expect(item.issue_id).toBe("100");
    expect(item.stage).toBe("stage_2_work");
    expect(item.status).toBe("pending");
    expect(item.landed).toBe(false);
    expect(item.budgets.delivery_attempts_used).toBe(0);
    expect(item.budgets.delivery_attempts_max).toBe(3);
    expect(item.budgets.replans_used).toBe(1);
    expect(item.budgets.replans_by_stage).toEqual({ stage_1_plan: 1 });

    expect(res.currentIssueId).toBe("100");
    expect(res.deliverySequence!.current_index).toBe(0);
    expect(res.deliverySequence!.completed).toBe(false);
    expect(res.budgets.delivery_attempts_used).toBe(0);
    expect(res.budgets.replans_used).toBe(1);
  });

  it("accepts direct planning with default stage fallback when nextStage not specified", () => {
    const ps = makePlanningSource({ outcome: "direct" });
    const res = applyDeliveryDecision(
      basePlanningParams({ planningSource: ps }),
    );
    expect(res.deliverySequence!.items[0].stage).toBe("stage_2_work");
  });

  it("rejects direct planning outcome if non-empty tasks are present", () => {
    const ps = makePlanningSource({
      outcome: "direct",
      plan: { tasks: [{ number: 101 }] },
    });
    expect(() =>
      applyDeliveryDecision(basePlanningParams({ planningSource: ps })),
    ).toThrow(/Direct planning outcome cannot contain tasks/);
  });

  it("rejects plan acceptance if delivery sequence already exists", () => {
    const ps = makePlanningSource({ outcome: "direct" });
    expect(() =>
      applyDeliveryDecision(
        basePlanningParams({
          planningSource: ps,
          deliverySequence: makeTestDeliverySequence(["100"]),
        }),
      ),
    ).toThrow(/Cannot accept plan: delivery sequence already exists/);
  });

  it("accepts decomposed planning outcome: creates sequence with tasks in order", () => {
    const ps = makePlanningSource({
      outcome: "decomposed",
      plan: {
        tasks: [
          { number: 101, blockedBy: [] },
          { number: "102", blockedBy: [101] },
          { issue_id: 103, blocked_by: ["101", 102] },
        ],
      },
    });
    const res = applyDeliveryDecision(
      basePlanningParams({
        planningSource: ps,
        nextStage: "custom_work_stage",
      }),
    );

    expect(res.deliverySequence).toBeDefined();
    expect(res.deliverySequence!.items).toHaveLength(3);
    expect(res.deliverySequence!.items.map((i) => i.issue_id)).toEqual([
      "101",
      "102",
      "103",
    ]);
    expect(
      res.deliverySequence!.items.every(
        (i) => i.stage === "custom_work_stage",
      ),
    ).toBe(true);
    expect(res.currentIssueId).toBe("101");
    expect(res.deliverySequence!.current_index).toBe(0);
    expect(res.deliverySequence!.completed).toBe(false);
    expect(res.budgets.delivery_attempts_used).toBe(0);

    // Each child item has fresh budgets
    for (const item of res.deliverySequence!.items) {
      expect(item.budgets.delivery_attempts_used).toBe(0);
      expect(item.budgets.delivery_attempts_max).toBe(3);
    }
  });

  it.each([
    ["less than 2 tasks", { tasks: [{ number: 101 }] }, /at least 2 tasks/],
    ["missing plan object", undefined, /must contain a 'plan' object/],
    [
      "task matching root issue ID",
      { tasks: [{ number: 100 }, { number: 101 }] },
      /cannot be the root issue ID/,
    ],
    [
      "duplicate task ID",
      { tasks: [{ number: 101 }, { number: 101 }] },
      /Duplicate issue ID/,
    ],
    [
      "self dependency",
      {
        tasks: [
          { number: 101, blockedBy: [101] },
          { number: 102, blockedBy: [] },
        ],
      },
      /cannot depend on itself/,
    ],
    [
      "unknown dependency",
      {
        tasks: [
          { number: 101, blockedBy: [999] },
          { number: 102, blockedBy: [] },
        ],
      },
      /depends on unknown issue '999'/,
    ],
    [
      "forward dependency (order violation)",
      {
        tasks: [
          { number: 101, blockedBy: [102] },
          { number: 102, blockedBy: [] },
        ],
      },
      /does not precede it in the plan order/,
    ],
    [
      "non-array blockedBy",
      {
        tasks: [
          { number: 101, blockedBy: "102" },
          { number: 102, blockedBy: [] },
        ],
      },
      /blockedBy must be an array/,
    ],
    [
      "invalid task ID (non-positive number)",
      { tasks: [{ number: -1 }, { number: 102 }] },
      /must be a positive integer/,
    ],
    [
      "invalid task ID (non-numeric string)",
      { tasks: [{ number: "abc" }, { number: 102 }] },
      /must be a positive integer/,
    ],
  ])(
    "rejects decomposed planning violation: %s",
    (_name, plan, errPattern) => {
      const ps = makePlanningSource({ outcome: "decomposed", plan });
      expect(() =>
        applyDeliveryDecision(basePlanningParams({ planningSource: ps })),
      ).toThrow(errPattern);
    },
  );

  it("rejects unsupported planning outcome", () => {
    const ps = makePlanningSource({ outcome: "unknown" });
    expect(() =>
      applyDeliveryDecision(basePlanningParams({ planningSource: ps })),
    ).toThrow(/Planning outcome must be 'direct' or 'decomposed'/);
  });

  it("rejects planningSource combined with prohibited options", () => {
    const ps = makePlanningSource({ outcome: "direct" });
    expect(() =>
      applyDeliveryDecision(
        basePlanningParams({ planningSource: ps, currentIssue: "101" }),
      ),
    ).toThrow(/Cannot combine planningSource with currentIssue/);

    expect(() =>
      applyDeliveryDecision(
        basePlanningParams({ planningSource: ps, markLanded: "100" }),
      ),
    ).toThrow(
      /Cannot combine planningSource with landing or sequence completion/,
    );

    expect(() =>
      applyDeliveryDecision(
        basePlanningParams({ planningSource: ps, completeSequence: true }),
      ),
    ).toThrow(
      /Cannot combine planningSource with landing or sequence completion/,
    );
  });

  it("maintains pure calculation immutability (does not mutate params.budgets or params)", () => {
    const inputBudgets = {
      delivery_attempts_used: 2,
      delivery_attempts_max: 3,
      replans_used: 1,
      replans_max: 2,
      replans_by_stage: { stage_1_plan: 1 },
    };
    const clonedBudgets = structuredClone(inputBudgets);
    const ps = makePlanningSource({ outcome: "direct" });
    const p = basePlanningParams({
      budgets: inputBudgets,
      planningSource: ps,
    });

    const res = applyDeliveryDecision(p);
    // Returned budgets has delivery_attempts_used reset to 0
    expect(res.budgets.delivery_attempts_used).toBe(0);
    // Original inputBudgets is untouched
    expect(inputBudgets).toEqual(clonedBudgets);
    expect(inputBudgets.delivery_attempts_used).toBe(2);
    expect(res.budgets).not.toBe(inputBudgets);
  });
});
