---
name: pc-orchestrator
description: Schedule Issue delivery through configured role contracts and workflow steps, reconcile interrupted work, and report verified completion.
---

# /pc-orchestrator

The Orchestrator defines the task sequence in text, decides task assignments, executors,
predecessor result linkages, and repair dispatches. Execution support (`Run`) prepares
inputs according to task contracts, starts independent agent conversations in dedicated
worktrees, validates submissions, and ensures verified resource cleanup and recovery.
Specialist skills own their implementation and professional judgments without knowledge of
the scheduling protocol.

## Run Interface & Task Contracts

The Orchestrator interacts exclusively with the `Run` interface:

```bash
# Open or allocate a Run
pc workflow open <issue> --provider agy

# Dispatch an isolated task
pc workflow dispatch <run-id> --task-type <task-type> --instructions-file <instructions-file>

# Observe execution observation and validated result
pc workflow observe <run-id>

# Submit structured result for an assigned task
pc workflow submit-result --run <run-id> --task <task-id> --outcome <outcome> --summary <summary> --artifacts <json>

# Stop active executions and pause Run
pc workflow stop <run-id> --reason <reason>

# Reconnect and reconcile interrupted Run
pc workflow resume <run-id>

# Finish Run and safely retire worktree
pc workflow finish <run-id> --conclusion <conclusion>
```

The Orchestrator supplies only the task type, instructions, predecessor result references,
and supplementary constraints. Professional inputs, delivery requirements, and output schemas
are prepared by pinned task contracts (version `1.0`) across 5 directly dispatched skills
supporting 6 task types:

1. `pc-issue-plan` (planning & decomposition mode)
2. `pc-issue-work` (implementation & testing mode)
3. `pc-pr-land` (PR creation, review invocation, commit assertion & landing)
4. `pc-issue-verify` (`pc-issue-plan` integrated acceptance verification mode)
5. `pc-pipeline-refactor` (pipeline file reorganization maintaining scientific invariance)
6. `pc-research-state` (final research records, artifacts, and reproduction entries)

Every dispatched task spawns a completely fresh agent conversation—including repair/rework
tasks and consecutive assignments. No session state is shared across task dispatches.

## Default Delivery Procedure

The workflow sequence is an editable reference in text below, not hardcoded in scripts or
automatic state machine transitions. The Orchestrator may adjust task orders, repeat tasks,
or skip unneeded steps without modifying execution code.

### 1. Planning & Decomposition (`pc-issue-plan`)
Invoke `pc-issue-plan` with the target issue and goal. If decomposed into sub-issues,
record the task dependency plan in Run:
- When outcome is `direct`: proceed directly to single-issue delivery.
- When outcome is `decomposed`: schedule sub-issues in topological dependency order.

### 2. Issue Delivery Loop (for each issue in dependency order)
For each target issue:
1. **Implementation (`pc-issue-work`)**: Dispatch task to implement changes and verify with tests.
   Specialist delivers code changes and test results in worktree; does not create a PR.
2. **Landing & Merge (`pc-pr-land`)**: Dispatch task to create/update PR, invoke `pc-pr-review`,
   verify head commit, and land onto base branch.
3. **Rework Handling**: If `pc-pr-land` reports `rework_needed`, the Orchestrator explicitly
   dispatches a repair task to `pc-issue-work`, referencing the predecessor task ID and review
   findings (`--predecessor <taskId>`). The repaired code is then re-evaluated by a fresh `pc-pr-land`.

### 3. Integrated Acceptance Verification (`pc-issue-verify`)
Invoke `pc-issue-plan` in verification mode with `originalObjective`, `acceptanceCriteria`,
and aggregated `deliveryEvidence`. If gaps remain, the Orchestrator explicitly dispatches
repair tasks back to step 2.

### 4. Pipeline File Reorganization (`pc-pipeline-refactor`)
Invoke `pc-pipeline-refactor` scoped strictly to the files involved in the delivered changes.
**Scientific Invariance**: Reorganization must strictly preserve scientific methods, computation
logic, numerical results, and conclusions. If computational logic changes are required, it must
report `out_of_scope`.

### 5. Re-delivery on Pipeline Changes (`pc-pr-land`)
If `pc-pipeline-refactor` produced file changes (`changedFiles` is non-empty), dispatch a fresh
`pc-pr-land` task to deliver and merge the refactored files.

### 6. Final Research Records (`pc-research-state`)
Invoke `pc-research-state` to record updated research records, artifact locations, and
reproduction entry points in the nexus repository.

### 7. Run Completion & Teardown (`pc workflow finish`)
Verify all tasks have exited, confirm worktree is clean, and invoke `pc workflow finish` to safely
retire the worktree and record overall completion evidence.

## Recovery & Lifecycle Discipline

- **Deduplication**: Repeated dispatch requests for the same task ID return the existing task
  idempotently; no duplicate agent conversations are launched.
- **Uncertain States**: If process state or launch confirmation is unconfirmed, report `uncertain`
  conservatively; never blindly relaunch or create duplicate worktrees.
- **Safe Teardown**: Worktrees with uncommitted changes or active processes cannot be deleted.
  All evidence and snapshots remain durably preserved in append-only event logs.
