import { atomicWriteJson } from "./envelope.js";
import { loadState, getStateFilePath, now } from "./state.js";
import {
  makeDeliverySequence,
  validatePlanOrder,
  readPlan,
  type Data,
} from "./workflow.js";
function assertFinish(state: Data): void {
  if (state.active_dispatch)
    throw Error(
      `Cannot finish workflow: active dispatch '${state.active_dispatch.dispatch_id}' is still in flight.`,
    );
  if (state.protocol_error)
    throw Error(
      `Cannot finish workflow: active protocol error exists: ${state.protocol_error.message}`,
    );
  const stages: Data[] = state.completed_stages ?? [];
  if (stages.at(-1)?.result?.outcome === "rework_needed")
    throw Error(
      `Cannot finish workflow: last completed stage '${stages.at(-1)?.stage}' resulted in 'rework_needed', which is not accepted as business pass. Rework must be routed.`,
    );
  if ((state.workflow ?? "default") !== "default") return;
  const closure =
    stages
      .filter(
        (e) =>
          e.stage === "issue_finalize" &&
          e.execution_status === "succeeded" &&
          e.result?.scope === "tree",
      )
      .at(-1) ?? {};
  const evidence = closure.result ?? {},
    issues = evidence.issues ?? [],
    root = String(state.root_issue_id);
  if (
    evidence.outcome !== "finalized" ||
    String(evidence.root_issue_id) !== root ||
    !Array.isArray(issues) ||
    !issues.length ||
    !issues.every(
      (i: Data) =>
        i && i.state === "CLOSED" && i.repository && i.acceptance_receipt,
    ) ||
    !issues.some((i: Data) => String(i.number) === root)
  )
    throw Error(
      "Cannot finish workflow: verified issue-tree closure evidence is missing.",
    );
  const latest = stages.at(-1) ?? {},
    result = latest.result ?? {},
    empty = (v: unknown): boolean => Array.isArray(v) && v.length === 0;
  if (
    latest.stage !== "workspace_cleanup" ||
    latest.execution_status !== "succeeded" ||
    result.outcome !== "cleaned" ||
    !empty(result.retained_paths) ||
    !empty(result.retained_branches) ||
    !empty(evidence.unresolved) ||
    (latest.step_index ?? -1) <= (closure.step_index ?? -1)
  )
    throw Error(
      "Cannot finish workflow: delivery complete / cleanup incomplete.",
    );
  if (!Array.isArray(evidence.candidates))
    throw Error(
      "Cannot finish workflow: reconciled cleanup inventory is missing.",
    );
  const after = stages.slice(stages.indexOf(closure) + 1),
    cleanups = after
      .filter(
        (e) =>
          e.stage === "workspace_cleanup" && e.execution_status === "succeeded",
      )
      .map((e) => e.result ?? {});
  const paths = new Set(cleanups.flatMap((r) => r.removed_paths ?? []));
  const branches = cleanups.flatMap((r) => r.removed_branches ?? []);
  for (const candidate of evidence.candidates) {
    const branch = candidate.branch;
    if (
      (candidate.worktree && !paths.has(candidate.worktree)) ||
      (branch &&
        (!branches.some(
          (b) => b.branch === branch && b.scope === "local" && b.remote == null,
        ) ||
          !branches.some(
            (b) =>
              b.branch === branch &&
              b.scope === "remote" &&
              b.remote === candidate.push_remote,
          )))
    )
      throw Error(
        "Cannot finish workflow: reconciled resource lacks cleanup evidence.",
      );
  }
  if (after.some((e) => e.stage !== "workspace_cleanup"))
    throw Error(
      "Cannot finish workflow: repeat issue finalization after intervening work.",
    );
}
export function resolveDecision(o: Data): Data {
  const state = loadState(o.receipt_root),
    decision = o.decision;
  const action = ["wait_user", "continue", "halt", "finish"].includes(decision)
    ? decision
    : "continue";
  const stage =
    o.next_stage ||
    (action === "continue" && decision !== "continue" ? decision : null);
  if (action === "finish") assertFinish(state);
  const record: Data = {
    decision,
    action,
    reason: o.reason,
    options: o.options ?? [],
    timestamp: now(),
  };
  if (action === "halt") state.stage_status = "halted";
  else if (action === "wait_user") state.stage_status = "blocked";
  else if (action === "finish") {
    state.stage_status = "succeeded";
    state.current_stage = "completed";
  } else
    state.stage_status = ["handed_off", "running"].includes(
      state.active_dispatch?.status ?? "",
    )
      ? "in_progress"
      : "pending";
  if (stage) {
    state.current_stage = stage;
    state.stage_status = "pending";
    record.next_stage = stage;
  }
  const children = o.child_issues?.length
    ? validatePlanOrder(o.child_issues)
    : o.plan
      ? readPlan(o.plan)
      : null;
  if (children) {
    state.delivery_sequence = makeDeliverySequence(
      children,
      state.budgets?.delivery_attempts_max ?? 3,
    );
    state.current_issue_id = children[0];
    state.budgets.delivery_attempts_used = 0;
  }
  if (o.current_issue != null) {
    const issue = String(o.current_issue).trim();
    state.current_issue_id = issue;
    record.current_issue = issue;
    const seq = state.delivery_sequence;
    if (seq) {
      if (seq.active_rework_issue_id !== issue)
        seq.active_rework_issue_id = null;
      const index = seq.items.findIndex(
        (i: Data) => String(i.issue_id) === issue,
      );
      if (index >= 0) {
        seq.current_index = index;
        const budgets = (seq.items[index].budgets ??= {});
        state.budgets.delivery_attempts_used =
          budgets.delivery_attempts_used ?? 0;
        state.budgets.delivery_attempts_max =
          budgets.delivery_attempts_max ??
          state.budgets.delivery_attempts_max ??
          3;
      }
    }
  }
  if (o.mark_landed != null) {
    const issue = String(o.mark_landed).trim();
    record.mark_landed = issue;
    const seq = state.delivery_sequence;
    if (seq) {
      if (seq.active_rework_issue_id === issue)
        seq.active_rework_issue_id = null;
      const item = seq.items.find((i: Data) => String(i.issue_id) === issue);
      if (item) {
        item.landed = true;
        item.status = "landed";
        item.stage = "landed";
        if (state.completed_stages?.length)
          item.land_receipt_path = String(
            state.completed_stages.at(-1)?.receipt_path ?? "",
          );
      }
    }
  }
  if (o.complete_sequence) {
    record.complete_sequence = true;
    if (state.delivery_sequence) {
      state.delivery_sequence.completed = true;
      state.current_issue_id = String(state.root_issue_id ?? "0");
    }
  }
  (state.decisions ??= []).push(record);
  state.orchestrator_decision = decision;
  state.last_updated = now();
  atomicWriteJson(getStateFilePath(o.receipt_root), state);
  return record;
}
