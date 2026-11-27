import { isNonEmptyString } from "./evidence.js";
import type {
  CleanupInspection,
  CleanupTarget,
  CompletionRecordView,
} from "./types.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function candidateTargets(candidate: Record<string, unknown>): CleanupTarget[] {
  const targets: CleanupTarget[] = [];
  if (isNonEmptyString(candidate.worktree)) {
    targets.push({ kind: "worktree", path: candidate.worktree.trim() });
  }
  if (isNonEmptyString(candidate.branch)) {
    const branch = candidate.branch.trim();
    const remote = candidate.pushRemote ?? candidate.push_remote;
    targets.push(
      { kind: "local_branch", branch },
      {
        kind: "remote_branch",
        branch,
        remote: isNonEmptyString(remote) ? remote : "origin",
      },
    );
  }
  return targets;
}

function targetKey(target: CleanupTarget): string {
  return JSON.stringify(target);
}

function branchTarget(row: Record<string, unknown>): CleanupTarget | undefined {
  if (!isNonEmptyString(row.branch)) return undefined;
  if (row.scope === "local" && row.remote == null) {
    return { kind: "local_branch", branch: row.branch };
  }
  if (row.scope === "remote" && isNonEmptyString(row.remote)) {
    return { kind: "remote_branch", branch: row.branch, remote: row.remote };
  }
  return undefined;
}

function parseCleanupReport(
  result: CompletionRecordView["result"],
  targets: ReadonlyMap<string, CleanupTarget>,
) {
  if (!result) return undefined;
  const {
    outcome,
    removed_paths,
    removed_branches,
    retained_paths,
    retained_branches,
  } = result;
  if (
    (outcome !== "cleaned" && outcome !== "incomplete") ||
    !Array.isArray(removed_paths) ||
    !Array.isArray(removed_branches) ||
    !Array.isArray(retained_paths) ||
    !Array.isArray(retained_branches)
  )
    return undefined;

  const removed = new Set<string>();
  for (const path of removed_paths) {
    if (!isNonEmptyString(path)) return undefined;
    removed.add(targetKey({ kind: "worktree", path }));
  }
  for (const row of removed_branches) {
    const target = object(row) ? branchTarget(row) : undefined;
    if (!target) return undefined;
    removed.add(targetKey(target));
  }

  const retained = new Map<string, string>();
  for (const row of retained_paths) {
    if (
      !object(row) ||
      !isNonEmptyString(row.path) ||
      !isNonEmptyString(row.reason)
    ) {
      return undefined;
    }
    const key = targetKey({ kind: "worktree", path: row.path });
    if (!targets.has(key) || removed.has(key)) return undefined;
    retained.set(key, row.reason);
  }
  for (const row of retained_branches) {
    if (
      !object(row) ||
      !isNonEmptyString(row.branch) ||
      !isNonEmptyString(row.reason)
    ) {
      return undefined;
    }
    const target = branchTarget(row);
    if (target) {
      const key = targetKey(target);
      if (!targets.has(key) || removed.has(key)) return undefined;
      retained.set(key, row.reason);
      continue;
    }
    if (row.scope != null || row.remote != null) return undefined;
    // Older receipts report retention by branch name only. Exclude scopes
    // with positive removal proof from this same attempt.
    const matches = [...targets].filter(
      ([key, target]) =>
        target.kind !== "worktree" &&
        target.branch === row.branch &&
        !removed.has(key),
    );
    if (!matches.length) return undefined;
    for (const [key] of matches) retained.set(key, row.reason);
  }

  if (outcome === "cleaned" && retained.size > 0) return undefined;
  return { outcome, removed, retained };
}

interface CleanupAssessment {
  inspection: CleanupInspection;
  blockingReasons: string[];
}

export function assessCleanup(
  finalization: CompletionRecordView,
  attempts: readonly CompletionRecordView[],
  finalizationStale: boolean,
): CleanupAssessment {
  const closingResult = finalization.result ?? {};
  const inventory = closingResult.candidates;
  const unresolved = closingResult.unresolved;
  const blockingReasons: string[] = [];
  if (!Array.isArray(unresolved) || unresolved.length > 0) {
    blockingReasons.push(
      "Cannot finish workflow: finalization contains unresolved issues.",
    );
  }
  const candidateEntries = Array.isArray(inventory)
    ? inventory.flatMap((candidate: unknown) => {
        if (!object(candidate)) return [];
        const targets = candidateTargets(candidate);
        return targets.length ? [{ candidate, targets }] : [];
      })
    : [];
  const validInventory =
    Array.isArray(inventory) && candidateEntries.length === inventory.length;
  if (!validInventory) {
    blockingReasons.push(
      "Cannot finish workflow: reconciled cleanup inventory is missing or malformed.",
    );
  }
  if (finalizationStale) {
    blockingReasons.push(
      "Cannot finish workflow: repeat issue finalization after intervening work.",
    );
    return {
      inspection: { status: "refinalization_required" },
      blockingReasons,
    };
  }
  if (!validInventory || !Array.isArray(unresolved)) {
    return { inspection: { status: "inventory_unavailable" }, blockingReasons };
  }

  const targets = new Map(
    candidateEntries.flatMap(({ targets }) =>
      targets.map((target) => [targetKey(target), target]),
    ),
  );
  const removed = new Set<string>();
  const retained = new Map<string, string>();

  let latestReport: ReturnType<typeof parseCleanupReport>;
  let hasSuccessfulAttempt = false;
  for (const attempt of attempts) {
    latestReport = undefined;
    if (
      attempt.execution_status !== "succeeded" ||
      (attempt.step_index ?? -1) <= (finalization.step_index ?? -1)
    )
      continue;

    hasSuccessfulAttempt = true;
    latestReport = parseCleanupReport(attempt.result, targets);
    if (!latestReport) continue;
    for (const key of latestReport.removed) {
      removed.add(key);
      retained.delete(key);
    }
    for (const [key, reason] of latestReport.retained) {
      removed.delete(key);
      retained.set(key, reason);
    }
  }

  const missingEvidence = [...targets].flatMap(([key, target]) =>
    removed.has(key)
      ? []
      : [
          {
            ...target,
            ...(retained.has(key) ? { reason: retained.get(key) } : {}),
          },
        ],
  );
  if (!hasSuccessfulAttempt) {
    blockingReasons.push(
      "Cannot finish workflow: successful cleanup after the latest issue-tree finalization is missing.",
    );
  } else {
    if (latestReport?.outcome !== "cleaned") {
      blockingReasons.push(
        "Cannot finish workflow: delivery complete / cleanup incomplete.",
      );
    }
    if (missingEvidence.length > 0) {
      blockingReasons.push(
        "Cannot finish workflow: reconciled resource lacks cleanup evidence.",
      );
    }
  }
  if (blockingReasons.length === 0) {
    return {
      inspection: { status: "complete", missing_evidence: [] },
      blockingReasons,
    };
  }

  const outstanding = candidateEntries.filter(({ targets }) =>
    targets.some((target) => !removed.has(targetKey(target))),
  );
  const fullInventory =
    !latestReport || !outstanding.length || unresolved.length > 0;
  return {
    inspection: {
      status: attempts.length === 0 ? "first_attempt" : "retry",
      parameters: {
        candidates: fullInventory
          ? inventory
          : outstanding.map(({ candidate }) => candidate),
        unresolved,
      },
      missing_evidence: missingEvidence,
    },
    blockingReasons,
  };
}
