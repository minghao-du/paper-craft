/**
 * Control-state rules shared by lifecycle operations.
 *
 * Control intent lives in `orchestrator_decision` (halt / wait_user pause the run,
 * continue resumes it, finish ends it). Task results live in `stage_status` and
 * `completed_stages`; completing a task never changes the control intent.
 */
import type { RuntimeState } from "./types.js";

export function isFinished(state: RuntimeState): boolean {
  return (
    state.orchestrator_decision === "finish" && state.current_stage === "completed"
  );
}

export function isPaused(state: RuntimeState): boolean {
  return (
    state.orchestrator_decision === "halt" ||
    state.orchestrator_decision === "wait_user"
  );
}

export function assertNotPaused(state: RuntimeState, action: string): void {
  if (isPaused(state)) {
    throw new Error(
      `Cannot ${action}: workflow is paused by decision '${state.orchestrator_decision}'. Run 'resolve --decision continue' to resume (a paused run does not cancel an already handed-off task).`,
    );
  }
}

/**
 * An explicit `resolve --next-stage X` must not be silently overridden by a different
 * main task. It counts as consumed once any dispatch has been prepared after it
 * (prepare moves the run out of the `pending` status with no active dispatch).
 * Auxiliary tasks never consume or conflict with the selection.
 */
export function assertMatchesPendingStageDecision(
  state: RuntimeState,
  stage: string,
  auxiliary: boolean,
): void {
  if (auxiliary) return;
  const selected = [...(state.decisions ?? [])]
    .reverse()
    .find((d) => typeof d.next_stage === "string");
  if (!selected?.next_stage) return;
  const unconsumed =
    state.active_dispatch == null &&
    state.stage_status === "pending" &&
    state.current_stage === selected.next_stage &&
    !(state.completed_stages ?? []).some(
      (c) => c.completed_at >= selected.timestamp,
    );
  if (unconsumed && selected.next_stage !== stage) {
    throw new Error(
      `Cannot prepare stage '${stage}': the latest resolve decision selected next_stage '${selected.next_stage}'. Prepare that stage, or record a new 'resolve --decision continue --next-stage <stage>' first.`,
    );
  }
}
