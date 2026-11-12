/**
 * Internal mapping helper between RuntimeState and Workflow DeliveryState.
 * Contains no business/budget rules, only structural projection.
 */
import type { DeliveryState } from "../workflow/types.js";
import type { RuntimeState } from "./types.js";

export function toDeliveryState(state: RuntimeState): DeliveryState {
  return {
    rootIssueId: String(state.root_issue_id),
    currentIssueId: String(state.current_issue_id || state.root_issue_id),
    rootBudgets: state.budgets,
    sequence: state.delivery_sequence,
    rootLandingEvidence: state.root_landing_evidence,
  };
}

export function applyNextDeliveryState(
  state: RuntimeState,
  nextDeliveryState: DeliveryState,
): Pick<
  RuntimeState,
  "current_issue_id" | "budgets" | "delivery_sequence" | "root_landing_evidence"
> {
  return {
    current_issue_id: nextDeliveryState.currentIssueId,
    budgets: nextDeliveryState.rootBudgets,
    delivery_sequence: nextDeliveryState.sequence,
    root_landing_evidence: nextDeliveryState.rootLandingEvidence,
  };
}
