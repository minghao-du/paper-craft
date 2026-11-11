import { describe, expect, it } from "vitest";
import {
  applyDeliveryDecision,
  makeDeliverySequence,
} from "../src/workflow/delivery.js";
import type {
  ApplyDeliveryDecisionParams,
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
    deliverySequence: makeDeliverySequence(["1", "2"], 3),
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
