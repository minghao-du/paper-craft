import { describe, expect, it } from "vitest";
import {
  applyDeliveryDecision,
  assertCanFinish,
  calculateDeliveryDispatch,
  inspectDelivery,
} from "../src/workflow/index.js";
import type {
  ApplyDeliveryDecisionParams,
  CompletionRecordView,
  DeliverySequence,
  DeliveryState,
  PlanningSource,
  WorkflowDefinition,
} from "../src/workflow/types.js";

const workflow: WorkflowDefinition = {
  name: "t",
  completion_policy: "issue_delivery",
  stages: [
    {
      id: "stage_2_work",
      logical_task: "issue_work",
      provider: { type: "skill", target: "pc-issue-work" },
    },
    {
      id: "stage_2_land",
      logical_task: "issue_land",
      provider: { type: "skill", target: "pc-pr-land" },
    },
    {
      id: "custom_work_stage",
      logical_task: "custom_work_stage",
      provider: { type: "skill", target: "pc-issue-work" },
    },
    {
      id: "stage_1_plan",
      logical_task: "issue_plan",
      provider: { type: "skill", target: "pc-issue-plan" },
    },
    {
      id: "scope_replan",
      logical_task: "scope_replan",
      replan: true,
      provider: { type: "skill", target: "pc-issue-plan" },
    },
    {
      id: "workspace_prepare",
      logical_task: "workspace_prepare",
      auxiliary: true,
      provider: { type: "skill", target: "pc-workspace" },
    },
    {
      id: "issue_verify",
      logical_task: "issue_verify",
      provider: { type: "skill", target: "pc-issue-verify" },
    },
    {
      id: "issue_finalize",
      logical_task: "issue_finalize",
      provider: { type: "skill", target: "pc-issue-finalize" },
    },
    {
      id: "workspace_cleanup",
      logical_task: "workspace_cleanup",
      auxiliary: true,
      provider: { type: "skill", target: "pc-workspace" },
    },
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
      budgets: {
        delivery_attempts_used: 0,
        delivery_attempts_max: max,
        replans_used: 0,
        replans_max: 2,
        replans_by_stage: {},
      },
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

  it("rejects different evidence for an already-landed issue in same attempt", () => {
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

  it("allows new landing evidence after explicitly starting new rework attempt (W05)", () => {
    const first = applyDeliveryDecision(params());
    const deliveryState: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "1",
      rootBudgets: first.budgets,
      sequence: first.deliverySequence,
    };

    // Starting new rework attempt requires attempt_intent: "new"
    const reworkDispatch = calculateDeliveryDispatch(
      workflow,
      deliveryState,
      workflow.stages[0], // stage_2_work
      { rework_issue: "1", attempt_intent: "new" },
    );

    const reworkedItem = reworkDispatch.nextDeliveryState.sequence!.items[0];
    expect(reworkedItem.landed).toBe(false);
    expect(reworkedItem.landed_attempt).toBeUndefined();
    expect(reworkDispatch.nextDeliveryState.sequence!.active_rework_issue_id).toBe("1");
    expect(reworkedItem.budgets.delivery_attempts_used).toBe(1);

    // Old attempt evidence (with delivery_attempt: 0) is rejected because current attempt is 1
    expect(() =>
      applyDeliveryDecision({
        ...params({ deliverySequence: reworkDispatch.nextDeliveryState.sequence }),
        landingDispatchId: "d1",
        completedStages: [{ ...landed, dispatch_id: "d1", delivery_attempt: 0 }],
      }),
    ).toThrow(/delivery attempt/);

    // New attempt landing evidence succeeds
    const secondLand = applyDeliveryDecision({
      ...params({ deliverySequence: reworkDispatch.nextDeliveryState.sequence }),
      landingDispatchId: "d2",
      completedStages: [
        {
          ...landed,
          dispatch_id: "d2",
          delivery_attempt: 1,
          receipt_path: "/r/d2.json",
        },
      ],
    });

    const secondItem = secondLand.deliverySequence!.items[0];
    expect(secondItem.landed).toBe(true);
    expect(secondItem.land_dispatch_id).toBe("d2");
    expect(secondItem.land_receipt_path).toBe("/r/d2.json");
    // active_rework_issue_id is cleared
    expect(secondLand.deliverySequence!.active_rework_issue_id).toBeNull();
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
      nextStage: "stage_2_work",
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

  it("rejects plan acceptance when nextStage is omitted", () => {
    const ps = makePlanningSource({ outcome: "direct" });
    expect(() =>
      applyDeliveryDecision(
        basePlanningParams({ planningSource: ps, nextStage: undefined }),
      ),
    ).toThrow(/requires an explicit non-empty 'nextStage'/);
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
    expect(res.budgets.delivery_attempts_used).toBe(0);
    expect(inputBudgets).toEqual(clonedBudgets);
    expect(inputBudgets.delivery_attempts_used).toBe(2);
    expect(res.budgets).not.toBe(inputBudgets);
  });
});

describe("calculateDeliveryDispatch and Domain Rules (W04, W05, W06, W10)", () => {
  it("maintains calculation input immutability in calculateDeliveryDispatch (W04)", () => {
    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "1",
      rootBudgets: {
        delivery_attempts_used: 1,
        delivery_attempts_max: 3,
        replans_used: 0,
        replans_max: 2,
        replans_by_stage: {},
      },
      sequence: makeTestDeliverySequence(["1", "2"], 3),
    };

    const stateClone = structuredClone(state);
    const result = calculateDeliveryDispatch(
      workflow,
      state,
      workflow.stages[0],
      { attempt_intent: "new" },
    );

    expect(state).toEqual(stateClone);
    expect(result.nextDeliveryState).not.toBe(state);
    expect(result.nextDeliveryState.sequence).not.toBe(state.sequence);
    expect(result.nextDeliveryState.sequence!.items[0].budgets.delivery_attempts_used).toBe(1);
    expect(state.sequence!.items[0].budgets.delivery_attempts_used).toBe(0);
  });

  it("attributes replan budgets to child issue and not root budgets (W06)", () => {
    const sequence = makeTestDeliverySequence(["101", "102"], 3);
    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "101",
      rootBudgets: {
        delivery_attempts_used: 1,
        delivery_attempts_max: 3,
        replans_used: 0,
        replans_max: 2,
        replans_by_stage: {},
      },
      sequence,
    };

    const replanStage = workflow.stages.find((s) => s.id === "scope_replan")!;
    const res = calculateDeliveryDispatch(
      workflow,
      state,
      replanStage,
      { originating_stage: "stage_2_work" },
    );

    // Root replans_used must remain 0
    expect(res.nextDeliveryState.rootBudgets.replans_used).toBe(0);
    // Child item budgets received the replan increment
    const item101 = res.nextDeliveryState.sequence!.items[0];
    expect(item101.budgets.replans_used).toBe(1);
    expect(item101.budgets.replans_by_stage?.stage_2_work).toBe(1);
  });

  it("auxiliary success cannot clear rework_needed (W10)", () => {
    const completedStages: CompletionRecordView[] = [
      {
        dispatch_id: "w1",
        stage: "stage_2_work",
        issue_id: "1",
        execution_status: "succeeded",
        result: { outcome: "rework_needed" },
        step_index: 1,
      },
      {
        dispatch_id: "c1",
        stage: "workspace_cleanup",
        issue_id: "0",
        execution_status: "succeeded",
        result: { outcome: "cleaned", retained_paths: [], retained_branches: [] },
        step_index: 2,
      },
    ];

    const basicWorkflow: WorkflowDefinition = {
      ...workflow,
      completion_policy: "basic",
    };

    expect(() =>
      assertCanFinish({
        workflow: basicWorkflow,
        completedStages,
        rootIssueId: "0",
      }),
    ).toThrow(/rework_needed/);

    const inspection = inspectDelivery({
      workflow: basicWorkflow,
      deliveryState: {
        rootIssueId: "0",
        currentIssueId: "1",
        rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
      },
      completedStages,
    });
    expect(inspection.reworkNeeded).toBe(true);
    expect(inspection.canFinish).toBe(false);
    expect(inspection.blockingReasons.length).toBeGreaterThan(0);

    // Later business success for the same issue and stage clears rework_needed
    const resolvedStages: CompletionRecordView[] = [
      ...completedStages,
      {
        dispatch_id: "w2",
        stage: "stage_2_work",
        issue_id: "1",
        execution_status: "succeeded",
        result: { outcome: "completed" },
        step_index: 3,
      },
    ];

    expect(() =>
      assertCanFinish({
        workflow: basicWorkflow,
        completedStages: resolvedStages,
        rootIssueId: "0",
      }),
    ).not.toThrow();
  });

  it("enforces issue_delivery policy: sequence, landings, verify, finalize, cleanup", () => {
    const seq = makeTestDeliverySequence(["1", "2"], 3);
    seq.items[0].landed = true;
    seq.items[0].land_dispatch_id = "d1";
    seq.items[0].land_receipt_path = "/r/d1.json";
    seq.items[1].landed = true;
    seq.items[1].land_dispatch_id = "d2";
    seq.items[1].land_receipt_path = "/r/d2.json";
    seq.completed = true;

    const deliveryState: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "0",
      rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
      sequence: seq,
    };

    const verifyRecord: CompletionRecordView = {
      dispatch_id: "v1",
      stage: "issue_verify",
      issue_id: "0",
      execution_status: "succeeded",
      result: { outcome: "verified", evaluatedHead: "commit-abc" },
      receipt_path: "/r/verify.json",
      step_index: 10,
    };

    const finalizeRecord: CompletionRecordView = {
      dispatch_id: "f1",
      stage: "issue_finalize",
      issue_id: "0",
      execution_status: "succeeded",
      result: {
        outcome: "finalized",
        scope: "tree",
        root_issue_id: "0",
        issues: [
          { number: "0", state: "CLOSED", repository: "repo", acceptance_receipt: "/r/verify.json" },
          { number: "1", state: "CLOSED", repository: "repo", acceptance_receipt: "/r/verify.json" },
          { number: "2", state: "CLOSED", repository: "repo", acceptance_receipt: "/r/verify.json" },
        ],
        unresolved: [],
        candidates: [{ branch: "b1", worktree: "/wt/1", push_remote: "origin" }],
      },
      step_index: 11,
    };

    const cleanupRecord: CompletionRecordView = {
      dispatch_id: "c1",
      stage: "workspace_cleanup",
      issue_id: "0",
      execution_status: "succeeded",
      result: {
        outcome: "cleaned",
        retained_paths: [],
        retained_branches: [],
        removed_paths: ["/wt/1"],
        removed_branches: [
          { branch: "b1", scope: "local", remote: null },
          { branch: "b1", scope: "remote", remote: "origin" },
        ],
      },
      step_index: 12,
    };

    const completedStages = [verifyRecord, finalizeRecord, cleanupRecord];

    expect(() =>
      assertCanFinish({
        workflow,
        deliveryState,
        completedStages,
        rootIssueId: "0",
      }),
    ).not.toThrow();

    const inspection = inspectDelivery({
      workflow,
      deliveryState,
      completedStages,
    });
    expect(inspection.canFinish).toBe(true);
    expect(inspection.blockingReasons).toEqual([]);
    expect(inspection.sequenceCompleted).toBe(true);
    expect(inspection.reworkNeeded).toBe(false);
  });
});
