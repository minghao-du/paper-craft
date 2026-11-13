import { describe, expect, it } from "vitest";
import {
  applyDeliveryDecision,
  assertCanFinish,
  inspectDelivery,
  WorkflowIntegrityError,
} from "../src/workflow/index.js";
import { calculateDeliveryDispatch } from "../src/workflow/delivery.js";
import type {
  ApplyDeliveryDecisionParams,
  CompletionRecordView,
  DeliveryDecision,
  DeliverySequence,
  DeliveryState,
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
  used = 1,
): DeliverySequence {
  return {
    items: ids.map((issue_id) => ({
      issue_id,
      stage,
      status: "pending",
      budgets: {
        delivery_attempts_used: used,
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

const landed: CompletionRecordView = {
  dispatch_id: "d1",
  issue_id: "1",
  stage: "stage_2_land",
  execution_status: "succeeded",
  result: { outcome: "landed", merged: true, mergedCommit: "abc" },
  receipt_path: "/r/d1.json",
  delivery_attempt: 1,
  step_index: 3,
};

function defaultDeliveryState(
  over: Partial<DeliveryState> = {},
): DeliveryState {
  return {
    rootIssueId: "0",
    currentIssueId: "1",
    rootBudgets: {
      delivery_attempts_used: 1,
      delivery_attempts_max: 3,
      replans_used: 0,
      replans_max: 1,
    },
    sequence: makeTestDeliverySequence(["1", "2"], 3, "stage_2_work", 1),
    ...over,
  };
}

function params(
  overState: Partial<DeliveryState> = {},
  decisionOver: Partial<
    Extract<DeliveryDecision, { kind: "update_delivery" }>
  > = {},
  record: Partial<CompletionRecordView> = {},
): ApplyDeliveryDecisionParams {
  const deliveryState = defaultDeliveryState(overState);
  return {
    workflow,
    deliveryState,
    decision: {
      kind: "update_delivery",
      landing: { issueId: "1", dispatchId: "d1" },
      ...decisionOver,
    },
    completedStages: [{ ...landed, ...record }],
  };
}

describe("delivery landing evidence", () => {
  it("lands with the evidence record's receipt and is idempotent", () => {
    const first = applyDeliveryDecision(params());
    const item = first.nextDeliveryState.sequence!.items[0];
    expect(item.landed).toBe(true);
    expect(item.land_receipt_path).toBe("/r/d1.json");
    const again = applyDeliveryDecision({
      workflow,
      deliveryState: first.nextDeliveryState,
      decision: {
        kind: "update_delivery",
        landing: { issueId: "1", dispatchId: "d1" },
      },
      completedStages: [landed],
    });
    expect(again.nextDeliveryState.sequence!.items[0].land_receipt_path).toBe(
      "/r/d1.json",
    );
  });

  it.each([
    ["missing dispatch id", { landing: { issueId: "1", dispatchId: "" } }, {}],
    ["unknown dispatch", { landing: { issueId: "1", dispatchId: "nope" } }, {}],
    [
      "other issue",
      { landing: { issueId: "1", dispatchId: "d1" } },
      { issue_id: "2" },
    ],
    [
      "legacy record without issue_id",
      { landing: { issueId: "1", dispatchId: "d1" } },
      { issue_id: undefined },
    ],
    [
      "non-landing stage",
      { landing: { issueId: "1", dispatchId: "d1" } },
      { stage: "stage_2_work" },
    ],
    [
      "failed execution",
      { landing: { issueId: "1", dispatchId: "d1" } },
      { execution_status: "failed" },
    ],
    [
      "rework outcome",
      { landing: { issueId: "1", dispatchId: "d1" } },
      { result: { outcome: "rework_needed", merged: false } },
    ],
    [
      "unmerged",
      { landing: { issueId: "1", dispatchId: "d1" } },
      { result: { outcome: "landed", merged: false } },
    ],
    [
      "unknown issue",
      { landing: { issueId: "9", dispatchId: "d1" } },
      { issue_id: "9" },
    ],
    [
      "missing delivery attempt (F16)",
      { landing: { issueId: "1", dispatchId: "d1" } },
      { delivery_attempt: undefined },
    ],
  ])("rejects %s without mutating state", (_n, decOver, record) => {
    const p = params({}, decOver, record);
    const before = structuredClone(p.deliveryState);
    expect(() => applyDeliveryDecision(p)).toThrow();
    expect(p.deliveryState).toEqual(before);
  });

  it("rejects different evidence for an already-landed issue in same attempt", () => {
    const first = applyDeliveryDecision(params());
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: first.nextDeliveryState,
        decision: {
          kind: "update_delivery",
          landing: { issueId: "1", dispatchId: "d2" },
        },
        completedStages: [
          landed,
          {
            ...landed,
            dispatch_id: "d2",
            delivery_attempt: 1,
            receipt_path: "/r/d2.json",
          },
        ],
      }),
    ).toThrow(/already landed/);
  });

  it("allows new landing evidence after explicitly starting new rework attempt (W05)", () => {
    const first = applyDeliveryDecision(params());
    const deliveryState = first.nextDeliveryState;

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
    expect(
      reworkDispatch.nextDeliveryState.sequence!.active_rework_issue_id,
    ).toBe("1");
    expect(reworkedItem.budgets.delivery_attempts_used).toBe(2);

    // Old attempt evidence (with delivery_attempt: 1) is rejected because current attempt is 2
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: reworkDispatch.nextDeliveryState,
        decision: {
          kind: "update_delivery",
          landing: { issueId: "1", dispatchId: "d1" },
        },
        completedStages: [
          { ...landed, dispatch_id: "d1", delivery_attempt: 1 },
        ],
      }),
    ).toThrow(/delivery attempt/);

    // New attempt landing evidence succeeds
    const secondLand = applyDeliveryDecision({
      workflow,
      deliveryState: reworkDispatch.nextDeliveryState,
      decision: {
        kind: "update_delivery",
        landing: { issueId: "1", dispatchId: "d2" },
      },
      completedStages: [
        {
          ...landed,
          dispatch_id: "d2",
          delivery_attempt: 2,
          receipt_path: "/r/d2.json",
        },
      ],
    });

    const secondItem = secondLand.nextDeliveryState.sequence!.items[0];
    expect(secondItem.landed).toBe(true);
    expect(secondItem.land_dispatch_id).toBe("d2");
    expect(secondItem.land_receipt_path).toBe("/r/d2.json");
    // active_rework_issue_id is cleared
    expect(
      secondLand.nextDeliveryState.sequence!.active_rework_issue_id,
    ).toBeNull();
  });

  it("completes only when every item landed; completion is idempotent", () => {
    const partial = applyDeliveryDecision(params());
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: partial.nextDeliveryState,
        decision: {
          kind: "update_delivery",
          completeSequence: true,
        },
        completedStages: [landed],
      }),
    ).toThrow(/2/);

    const second = applyDeliveryDecision({
      workflow,
      deliveryState: partial.nextDeliveryState,
      decision: {
        kind: "update_delivery",
        landing: { issueId: "2", dispatchId: "d2" },
      },
      completedStages: [
        landed,
        {
          ...landed,
          dispatch_id: "d2",
          issue_id: "2",
          receipt_path: "/r/d2.json",
          delivery_attempt: 1,
        },
      ],
    });

    const done = applyDeliveryDecision({
      workflow,
      deliveryState: second.nextDeliveryState,
      decision: {
        kind: "update_delivery",
        completeSequence: true,
      },
      completedStages: [
        landed,
        {
          ...landed,
          dispatch_id: "d2",
          issue_id: "2",
          receipt_path: "/r/d2.json",
          delivery_attempt: 1,
        },
      ],
    });
    expect(done.nextDeliveryState.sequence!.completed).toBe(true);
    expect(done.nextDeliveryState.currentIssueId).toBe("0");
  });
});

describe("planning source acceptance in applyDeliveryDecision", () => {
  function makePlanningRecord(
    result: Record<string, unknown>,
    over: Partial<CompletionRecordView> = {},
  ): CompletionRecordView {
    return {
      dispatch_id: "p1",
      issue_id: "100",
      stage: "stage_1_plan",
      step_index: 1,
      execution_status: "succeeded",
      provider: { type: "skill", target: "pc-issue-plan" },
      result,
      receipt_path: "/r/p1.json",
      ...over,
    };
  }

  function basePlanningState(): DeliveryState {
    return {
      rootIssueId: "100",
      currentIssueId: "100",
      rootBudgets: {
        delivery_attempts_used: 1,
        delivery_attempts_max: 3,
        replans_used: 1,
        replans_max: 2,
        replans_by_stage: { stage_1_plan: 1 },
      },
    };
  }

  it("accepts direct planning outcome: creates 1-item sequence and migrates root replan budgets", () => {
    const pRecord = makePlanningRecord({
      outcome: "direct",
      summary: "single delivery",
    });
    const res = applyDeliveryDecision({
      workflow,
      deliveryState: basePlanningState(),
      decision: {
        kind: "accept_plan",
        planDispatchId: "p1",
        nextStage: "stage_2_work",
      },
      completedStages: [pRecord],
    });

    expect(res.nextDeliveryState.sequence).toBeDefined();
    expect(res.nextDeliveryState.sequence!.items).toHaveLength(1);
    const item = res.nextDeliveryState.sequence!.items[0];
    expect(item.issue_id).toBe("100");
    expect(item.stage).toBe("stage_2_work");
    expect(item.status).toBe("pending");
    expect(item.landed).toBe(false);
    expect(item.budgets.delivery_attempts_used).toBe(0);
    expect(item.budgets.delivery_attempts_max).toBe(3);
    expect(item.budgets.replans_used).toBe(1);
    expect(item.budgets.replans_by_stage).toEqual({ stage_1_plan: 1 });

    expect(res.nextDeliveryState.currentIssueId).toBe("100");
    expect(res.nextDeliveryState.sequence!.current_index).toBe(0);
    expect(res.nextDeliveryState.sequence!.completed).toBe(false);
    expect(res.nextDeliveryState.rootBudgets.delivery_attempts_used).toBe(0);
    expect(res.nextDeliveryState.rootBudgets.replans_used).toBe(1);
  });

  it("rejects plan acceptance when nextStage is omitted", () => {
    const pRecord = makePlanningRecord({ outcome: "direct" });
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: basePlanningState(),
        decision: {
          kind: "accept_plan",
          planDispatchId: "p1",
          nextStage: "",
        },
        completedStages: [pRecord],
      }),
    ).toThrow(/requires an explicit non-empty 'nextStage'/);
  });

  it("rejects direct planning outcome if non-empty tasks are present", () => {
    const pRecord = makePlanningRecord({
      outcome: "direct",
      plan: { tasks: [{ number: 101 }] },
    });
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: basePlanningState(),
        decision: {
          kind: "accept_plan",
          planDispatchId: "p1",
          nextStage: "stage_2_work",
        },
        completedStages: [pRecord],
      }),
    ).toThrow(/Direct planning outcome cannot contain tasks/);
  });

  it("rejects plan acceptance if delivery sequence already exists", () => {
    const pRecord = makePlanningRecord({ outcome: "direct" });
    const state = basePlanningState();
    state.sequence = makeTestDeliverySequence(["100"]);
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: state,
        decision: {
          kind: "accept_plan",
          planDispatchId: "p1",
          nextStage: "stage_2_work",
        },
        completedStages: [pRecord],
      }),
    ).toThrow(/Cannot accept plan: delivery sequence already exists/);
  });

  it("accepts decomposed planning outcome: creates sequence with tasks in order", () => {
    const pRecord = makePlanningRecord({
      outcome: "decomposed",
      plan: {
        tasks: [
          { number: 101, blockedBy: [] },
          { number: "102", blockedBy: [101] },
          { issue_id: 103, blocked_by: ["101", 102] },
        ],
      },
    });
    const res = applyDeliveryDecision({
      workflow,
      deliveryState: basePlanningState(),
      decision: {
        kind: "accept_plan",
        planDispatchId: "p1",
        nextStage: "custom_work_stage",
      },
      completedStages: [pRecord],
    });

    expect(res.nextDeliveryState.sequence).toBeDefined();
    expect(res.nextDeliveryState.sequence!.items).toHaveLength(3);
    expect(
      res.nextDeliveryState.sequence!.items.map((i) => i.issue_id),
    ).toEqual(["101", "102", "103"]);
    expect(
      res.nextDeliveryState.sequence!.items.every(
        (i) => i.stage === "custom_work_stage",
      ),
    ).toBe(true);
    expect(res.nextDeliveryState.currentIssueId).toBe("101");
    expect(res.nextDeliveryState.sequence!.current_index).toBe(0);
    expect(res.nextDeliveryState.sequence!.completed).toBe(false);
    expect(res.nextDeliveryState.rootBudgets.delivery_attempts_used).toBe(0);

    for (const item of res.nextDeliveryState.sequence!.items) {
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
      const pRecord = makePlanningRecord({ outcome: "decomposed", plan });
      expect(() =>
        applyDeliveryDecision({
          workflow,
          deliveryState: basePlanningState(),
          decision: {
            kind: "accept_plan",
            planDispatchId: "p1",
            nextStage: "stage_2_work",
          },
          completedStages: [pRecord],
        }),
      ).toThrow(errPattern);
    },
  );

  it("rejects unsupported planning outcome", () => {
    const pRecord = makePlanningRecord({ outcome: "unknown" });
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: basePlanningState(),
        decision: {
          kind: "accept_plan",
          planDispatchId: "p1",
          nextStage: "stage_2_work",
        },
        completedStages: [pRecord],
      }),
    ).toThrow(/Planning outcome must be 'direct' or 'decomposed'/);
  });

  it("maintains pure calculation immutability", () => {
    const state = basePlanningState();
    const clonedState = structuredClone(state);
    const pRecord = makePlanningRecord({ outcome: "direct" });

    const res = applyDeliveryDecision({
      workflow,
      deliveryState: state,
      decision: {
        kind: "accept_plan",
        planDispatchId: "p1",
        nextStage: "stage_2_work",
      },
      completedStages: [pRecord],
    });

    expect(res.nextDeliveryState.rootBudgets.delivery_attempts_used).toBe(0);
    expect(state).toEqual(clonedState);
    expect(res.nextDeliveryState).not.toBe(state);
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
    expect(
      result.nextDeliveryState.sequence!.items[0].budgets
        .delivery_attempts_used,
    ).toBe(2);
    expect(state.sequence!.items[0].budgets.delivery_attempts_used).toBe(1);
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
        result: {
          outcome: "cleaned",
          retained_paths: [],
          retained_branches: [],
        },
        step_index: 2,
      },
    ];

    const basicWorkflow: WorkflowDefinition = {
      ...workflow,
      completion_policy: "basic",
    };

    const basicDeliveryState: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "1",
      rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
    };

    expect(() =>
      assertCanFinish({
        workflow: basicWorkflow,
        deliveryState: basicDeliveryState,
        completedStages,
      }),
    ).toThrow(/rework_needed/);

    const inspection = inspectDelivery({
      workflow: basicWorkflow,
      deliveryState: basicDeliveryState,
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
        deliveryState: basicDeliveryState,
        completedStages: resolvedStages,
      }),
    ).not.toThrow();
  });

  it("enforces issue_delivery policy: sequence, landings, verify, finalize, cleanup", () => {
    const seq = makeTestDeliverySequence(["1", "2"], 3);
    seq.items[0].landed = true;
    seq.items[0].land_dispatch_id = "d1";
    seq.items[0].land_receipt_path = "/r/d1.json";
    seq.items[0].landed_attempt = 1;
    seq.items[1].landed = true;
    seq.items[1].land_dispatch_id = "d2";
    seq.items[1].land_receipt_path = "/r/d2.json";
    seq.items[1].landed_attempt = 1;
    seq.completed = true;

    const deliveryState: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "0",
      rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
      sequence: seq,
    };

    const landingRecord1: CompletionRecordView = {
      dispatch_id: "d1",
      stage: "stage_2_land",
      issue_id: "1",
      execution_status: "succeeded",
      result: { outcome: "landed", merged: true, mergedCommit: "abc" },
      receipt_path: "/r/d1.json",
      delivery_attempt: 1,
      step_index: 1,
    };

    const landingRecord2: CompletionRecordView = {
      dispatch_id: "d2",
      stage: "stage_2_land",
      issue_id: "2",
      execution_status: "succeeded",
      result: { outcome: "landed", merged: true, mergedCommit: "abc" },
      receipt_path: "/r/d2.json",
      delivery_attempt: 1,
      step_index: 2,
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
          {
            number: "0",
            state: "CLOSED",
            repository: "repo",
            acceptance_receipt: "/r/verify.json",
          },
          {
            number: "1",
            state: "CLOSED",
            repository: "repo",
            acceptance_receipt: "/r/verify.json",
          },
          {
            number: "2",
            state: "CLOSED",
            repository: "repo",
            acceptance_receipt: "/r/verify.json",
          },
        ],
        unresolved: [],
        candidates: [
          { branch: "b1", worktree: "/wt/1", push_remote: "origin" },
        ],
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

    const completedStages = [
      landingRecord1,
      landingRecord2,
      verifyRecord,
      finalizeRecord,
      cleanupRecord,
    ];

    expect(() =>
      assertCanFinish({
        workflow,
        deliveryState,
        completedStages,
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

describe("F01: root verification ownership", () => {
  it("rejects child-only verification from satisfying root completion", () => {
    const seq = makeTestDeliverySequence(["1"], 3);
    seq.items[0].landed = true;
    seq.items[0].land_dispatch_id = "d1";
    seq.items[0].land_receipt_path = "/r/d1.json";
    seq.items[0].landed_attempt = 1;
    seq.completed = true;

    const deliveryState: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "0",
      rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
      sequence: seq,
    };

    // Child-owned verification record (issue_id: "1")
    const childVerifyRecord: CompletionRecordView = {
      dispatch_id: "v-child",
      stage: "issue_verify",
      issue_id: "1",
      execution_status: "succeeded",
      result: { outcome: "verified", evaluatedHead: "commit-abc" },
      receipt_path: "/r/verify.json",
      step_index: 10,
    };

    const completedStages = [
      { ...landed, dispatch_id: "d1", issue_id: "1", delivery_attempt: 1 },
      childVerifyRecord,
    ];

    const inspection = inspectDelivery({
      workflow,
      deliveryState,
      completedStages,
    });
    expect(inspection.canFinish).toBe(false);
    expect(inspection.blockingReasons).toContain(
      "Cannot finish workflow: verified root-level acceptance evidence (issue_verify) is missing.",
    );

    expect(() =>
      assertCanFinish({
        workflow,
        deliveryState,
        completedStages,
      }),
    ).toThrow(/issue_verify/);

    // Root-owned verification record (issue_id: "0") satisfies it
    const rootVerifyRecord: CompletionRecordView = {
      ...childVerifyRecord,
      dispatch_id: "v-root",
      issue_id: "0",
      step_index: 11,
    };
    const inspectionWithRoot = inspectDelivery({
      workflow,
      deliveryState,
      completedStages: [...completedStages, rootVerifyRecord],
    });
    expect(inspectionWithRoot.blockingReasons).not.toContain(
      "Cannot finish workflow: verified root-level acceptance evidence (issue_verify) is missing.",
    );
  });
});

describe("F07: root budget contamination prevention", () => {
  it("switching to child preserves root budget without contamination", () => {
    const seq = makeTestDeliverySequence(["1", "2"], 3);
    seq.items[0].budgets.delivery_attempts_used = 2;
    seq.items[0].budgets.delivery_attempts_max = 2;
    seq.items[0].budgets.replans_used = 1;

    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "0",
      rootBudgets: {
        delivery_attempts_used: 0,
        delivery_attempts_max: 5,
        replans_used: 0,
        replans_max: 3,
      },
      sequence: seq,
    };

    // Switch current issue to "1"
    const result = applyDeliveryDecision({
      workflow,
      deliveryState: state,
      decision: {
        kind: "update_delivery",
        currentIssueId: "1",
      },
      completedStages: [],
    });

    // Root budgets MUST remain untouched
    expect(result.nextDeliveryState.rootBudgets.delivery_attempts_used).toBe(0);
    expect(result.nextDeliveryState.rootBudgets.delivery_attempts_max).toBe(5);
    expect(result.nextDeliveryState.rootBudgets.replans_used).toBe(0);
    expect(result.nextDeliveryState.rootBudgets.replans_max).toBe(3);

    // Also verify calculateDeliveryDispatch for child does not contaminate root budgets
    const dispatchRes = calculateDeliveryDispatch(
      workflow,
      result.nextDeliveryState,
      workflow.stages[0], // stage_2_work
      { attempt_intent: "same" },
    );
    expect(
      dispatchRes.nextDeliveryState.rootBudgets.delivery_attempts_used,
    ).toBe(0);
    expect(
      dispatchRes.nextDeliveryState.rootBudgets.delivery_attempts_max,
    ).toBe(5);
  });
});

describe("F08: switching current issue cannot abandon active rework", () => {
  it("rejects switching current issue away from active rework without landing it", () => {
    const seq = makeTestDeliverySequence(["1", "2"], 3);
    seq.active_rework_issue_id = "1";

    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "1",
      rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
      sequence: seq,
    };

    // Attempting to switch to issue "2" without landing issue "1" must be rejected
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: state,
        decision: {
          kind: "update_delivery",
          currentIssueId: "2",
        },
        completedStages: [],
      }),
    ).toThrow(
      /Cannot switch current issue to '2': active rework is in progress for issue '1'/,
    );

    // Atomically landing issue "1" AND switching to issue "2" succeeds
    const landRecord: CompletionRecordView = {
      ...landed,
      dispatch_id: "d1",
      issue_id: "1",
      delivery_attempt: 1,
    };
    const atomicRes = applyDeliveryDecision({
      workflow,
      deliveryState: state,
      decision: {
        kind: "update_delivery",
        landing: { issueId: "1", dispatchId: "d1" },
        currentIssueId: "2",
      },
      completedStages: [landRecord],
    });

    expect(atomicRes.nextDeliveryState.currentIssueId).toBe("2");
    expect(
      atomicRes.nextDeliveryState.sequence!.active_rework_issue_id,
    ).toBeNull();
    expect(atomicRes.nextDeliveryState.sequence!.items[0].landed).toBe(true);
  });
});

describe("F09: malformed finalization issues shape", () => {
  it("produces clean blocking reason without throwing TypeError when issues is an object", () => {
    const seq = makeTestDeliverySequence(["1"], 3);
    seq.items[0].landed = true;
    seq.items[0].land_dispatch_id = "d1";
    seq.items[0].land_receipt_path = "/r/d1.json";
    seq.items[0].landed_attempt = 1;
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

    // Malformed issues shape: object instead of array
    const malformedFinalizeRecord: CompletionRecordView = {
      dispatch_id: "f1",
      stage: "issue_finalize",
      issue_id: "0",
      execution_status: "succeeded",
      result: {
        outcome: "finalized",
        scope: "tree",
        root_issue_id: "0",
        issues: {}, // MALFORMED: object instead of array
      },
      step_index: 11,
    };

    const completedStages = [
      { ...landed, dispatch_id: "d1", issue_id: "1", delivery_attempt: 1 },
      verifyRecord,
      malformedFinalizeRecord,
    ];

    // Must NOT throw TypeError: issues.some is not a function
    const inspection = inspectDelivery({
      workflow,
      deliveryState,
      completedStages,
    });
    expect(inspection.canFinish).toBe(false);
    expect(
      inspection.blockingReasons.some((r) => r.includes("malformed")),
    ).toBe(true);
  });
});

describe("F13: verification after landing in direct and decomposed modes", () => {
  it("succeeds in direct mode after landing without allocating new delivery attempt", () => {
    const seq = makeTestDeliverySequence(["0"], 3);
    seq.items[0].landed = true;
    seq.items[0].land_dispatch_id = "d0";
    seq.items[0].land_receipt_path = "/r/d0.json";
    seq.completed = false;

    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "0",
      rootBudgets: {
        delivery_attempts_used: 1,
        delivery_attempts_max: 3,
        replans_used: 0,
        replans_max: 2,
      },
      sequence: seq,
    };

    const verifyStage = workflow.stages.find((s) => s.id === "issue_verify")!;

    // In direct mode with issue landed, verifying MUST NOT throw "already landed"
    // and MUST NOT allocate a new attempt.
    const res = calculateDeliveryDispatch(workflow, state, verifyStage, {
      attempt_intent: "same",
    });

    expect(res.attempt).toBe(1);
    expect(res.deliveryAttempt).toBe(1);
    expect(res.budgets.delivery_attempts_used).toBe(1);
    expect(res.nextDeliveryState.sequence!.items[0].landed).toBe(true);
  });

  it("succeeds in decomposed mode after landing without allocating new delivery attempt", () => {
    const seq = makeTestDeliverySequence(["1", "2"], 3);
    seq.items[0].landed = true;
    seq.items[0].land_dispatch_id = "d1";
    seq.items[0].land_receipt_path = "/r/d1.json";
    seq.items[1].landed = true;
    seq.items[1].land_dispatch_id = "d2";
    seq.items[1].land_receipt_path = "/r/d2.json";
    seq.completed = true;

    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "0",
      rootBudgets: {
        delivery_attempts_used: 0,
        delivery_attempts_max: 3,
        replans_used: 0,
        replans_max: 2,
      },
      sequence: seq,
    };

    const verifyStage = workflow.stages.find((s) => s.id === "issue_verify")!;

    // Root verification after sequence completion
    const res = calculateDeliveryDispatch(workflow, state, verifyStage, {
      attempt_intent: "same",
    });

    expect(res.currentIssueId).toBe("0");
    expect(res.budgets.delivery_attempts_used).toBe(0);
    expect(res.attempt).toBe(1); // envelope attempt default Math.max(1, 0)
    expect(res.deliveryAttempt).toBe(0); // actual delivery attempt count remains 0
  });
});

describe("F14: child sequence budget inheritance", () => {
  it("child sequence inherits replans_max: 0 when root has 0", () => {
    const pRecord: CompletionRecordView = {
      dispatch_id: "p1",
      issue_id: "100",
      stage: "stage_1_plan",
      step_index: 1,
      execution_status: "succeeded",
      provider: { type: "skill", target: "pc-issue-plan" },
      result: {
        outcome: "decomposed",
        plan: {
          tasks: [
            { number: 101, blockedBy: [] },
            { number: 102, blockedBy: [] },
          ],
        },
      },
      receipt_path: "/r/p1.json",
    };

    const state: DeliveryState = {
      rootIssueId: "100",
      currentIssueId: "100",
      rootBudgets: {
        delivery_attempts_used: 1,
        delivery_attempts_max: 4,
        replans_used: 0,
        replans_max: 0, // Root has replans_max = 0
      },
    };

    const res = applyDeliveryDecision({
      workflow,
      deliveryState: state,
      decision: {
        kind: "accept_plan",
        planDispatchId: "p1",
        nextStage: "stage_2_work",
      },
      completedStages: [pRecord],
    });

    // Children must inherit replans_max = 0 (NOT hardcoded 2!)
    expect(
      res.nextDeliveryState.sequence!.items[0].budgets.replans_max,
    ).toBe(0);
    expect(
      res.nextDeliveryState.sequence!.items[1].budgets.replans_max,
    ).toBe(0);
    expect(
      res.nextDeliveryState.sequence!.items[0].budgets.delivery_attempts_max,
    ).toBe(4);
    expect(
      res.nextDeliveryState.sequence!.items[0].budgets.replans_used,
    ).toBe(0);
  });
});

describe("F16: reject landing record missing delivery_attempt", () => {
  it("rejects landing record when delivery_attempt is missing/undefined", () => {
    const state = defaultDeliveryState();
    const missingAttemptRecord: CompletionRecordView = {
      ...landed,
      delivery_attempt: undefined, // MISSING
    };

    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: state,
        decision: {
          kind: "update_delivery",
          landing: { issueId: "1", dispatchId: "d1" },
        },
        completedStages: [missingAttemptRecord],
      }),
    ).toThrow(/lacks required numeric delivery_attempt/);
  });
});

describe("F17: dangling accepted landing reference validation", () => {
  it("throws WorkflowIntegrityError when accepted landing dispatch is missing from completedStages", () => {
    const seq = makeTestDeliverySequence(["1"], 3);
    seq.items[0].landed = true;
    seq.items[0].land_dispatch_id = "d-dangling";
    seq.items[0].land_receipt_path = "/r/d-dangling.json";
    seq.completed = true;

    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "0",
      rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
      sequence: seq,
    };

    // completedStages does not have "d-dangling"
    expect(() =>
      inspectDelivery({
        workflow,
        deliveryState: state,
        completedStages: [],
      }),
    ).toThrow(WorkflowIntegrityError);

    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: { ...state, sequence: { ...seq, completed: false } },
        decision: {
          kind: "update_delivery",
          completeSequence: true,
        },
        completedStages: [],
      }),
    ).toThrow(WorkflowIntegrityError);
  });
});

describe("F18: invalid sequence cursor validation", () => {
  it("throws WorkflowIntegrityError when current_index is out of range and never falls back to root", () => {
    const seq = makeTestDeliverySequence(["1", "2"], 3);
    seq.current_index = 99; // Out of range for length 2!

    const state: DeliveryState = {
      rootIssueId: "0",
      currentIssueId: "1",
      rootBudgets: { delivery_attempts_used: 1, delivery_attempts_max: 3 },
      sequence: seq,
    };

    // calculateDeliveryDispatch throws WorkflowIntegrityError instead of falling back to root
    expect(() =>
      calculateDeliveryDispatch(workflow, state, workflow.stages[0], {
        attempt_intent: "same",
      }),
    ).toThrow(WorkflowIntegrityError);

    // inspectDelivery throws WorkflowIntegrityError
    expect(() =>
      inspectDelivery({
        workflow,
        deliveryState: state,
        completedStages: [],
      }),
    ).toThrow(WorkflowIntegrityError);

    // applyDeliveryDecision throws WorkflowIntegrityError
    expect(() =>
      applyDeliveryDecision({
        workflow,
        deliveryState: state,
        decision: {
          kind: "update_delivery",
          nextStage: "stage_2_work",
        },
        completedStages: [],
      }),
    ).toThrow(WorkflowIntegrityError);
  });
});
