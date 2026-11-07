# Default Issue Delivery Workflow

- **Workflow Name**: default
- **Version**: 1.0.0
- **Initial Stage**: stage_1_plan
- **Target**: Coordinate end-to-end issue delivery from planning through implementation, landing, verification, refactoring, and state recording.

```yaml
workflow:
  name: default
  version: "1.0.0"
  initial_stage: stage_1_plan
  target: "End-to-end issue delivery lifecycle"
  stages:
    - id: workspace_prepare
      logical_task: workspace_prepare
      name: "Workspace Lifecycle Preparation"
      provider:
        type: skill
        target: pc-workspace
        args: []
      # Script substitution alternative:
      # provider:
      #   type: script
      #   target: skills/pc-workspace/scripts/prepare-worktree.py

    - id: stage_1_plan
      logical_task: issue_plan
      name: "Stage 1 — Planning and Decomposition"
      provider:
        type: skill
        target: pc-issue-plan
        args: []

    - id: stage_2_work
      logical_task: issue_work
      name: "Stage 2.1 — Issue Implementation"
      provider:
        type: skill
        target: pc-issue-work
        args: []

    - id: stage_2_land
      logical_task: issue_land
      name: "Stage 2.2 — Landing and Merge"
      provider:
        type: skill
        target: pc-pr-land
        args: []

    - id: stage_3_verify
      logical_task: issue_verify
      name: "Stage 3 — Integrated Acceptance Verification"
      provider:
        type: skill
        target: pc-issue-verify
        args: []

    - id: stage_4_refactor_audit
      logical_task: pipeline_refactor_audit
      name: "Stage 4.1 — Pipeline Refactoring Audit & Plan"
      provider:
        type: skill
        target: pc-pipeline-refactor
        args: ["--audit"]

    - id: stage_4_refactor_execute
      logical_task: pipeline_refactor_execute
      name: "Stage 4.2 — Pipeline Refactoring Execution"
      provider:
        type: skill
        target: pc-pipeline-refactor
        args: ["--execute"]

    - id: stage_5_redeliver
      logical_task: pipeline_refactor_redeliver
      name: "Stage 5 — Re-delivery of Pipeline Changes"
      provider:
        type: skill
        target: pc-pr-land
        args: []

    - id: stage_6_research_record
      logical_task: research_record
      name: "Stage 6 — Research Records and State Finalization"
      provider:
        type: skill
        target: pc-research-state
        args: []

    - id: workspace_cleanup
      logical_task: workspace_cleanup
      name: "Workspace Lifecycle Cleanup"
      provider:
        type: skill
        target: pc-workspace
        args: ["--cleanup"]

    - id: scope_replan
      logical_task: scope_replan
      name: "Replanning for Scope Boundaries"
      provider:
        type: skill
        target: pc-issue-plan
        args: ["--replan"]
```

---

## Environment assignments & lifecycle

Apply [workspace lifecycle and dispatch](../references/workspaces.md) before every professional task.
Environment preparation and cleanup are defined as decoupled logical tasks (`workspace_prepare` and `workspace_cleanup`), executable via skill or script provider.

| Logical Task | Assigned environment | Preparation Requirement |
| --- | --- | --- |
| `issue_plan` | Explicit existing repository checkout | Validated persistent checkout |
| `issue_work` | Prepared isolated feature worktree | Fresh or existing feature worktree for `current_issue_id` |
| `issue_land` | Same feature worktree | Retain verified worktree and latest delivered SHA |
| `issue_verify` | Prepared detached worktree | Detached worktree pinned to integrated base commit |
| `pipeline_refactor_audit` | Integrated checkout environment | Accepted integrated environment |
| `pipeline_refactor_execute` | Fresh refactor feature worktree | Prepared branch/worktree from current integrated base |
| `pipeline_refactor_redeliver` | Same refactor worktree | Retain refactor worktree with latest delivered SHA |
| `research_record` | Validated persistent checkout | Persistent checkout plus fixed shared research entry |
| `workspace_cleanup` | Retained persistent checkout | Candidate worktrees from current run |

Carry explicit artifact locations into verification and research recording. After all professional stages succeed, dispatch `workspace_cleanup` for this run's eligible created environments and record retention reasons before declaring root completion.

---

## Auxiliary Stage — Workspace Preparation (`workspace_prepare`)

- **Stage ID**: `workspace_prepare`
- **Logical Task**: `workspace_prepare`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-workspace
    args: []
  ```
  *(Alternative script provider: `type: script`, `target: skills/pc-workspace/scripts/prepare-worktree.py`)*
- **Objective**: Prepare and validate the Git execution directory (persistent checkout, isolated feature worktree, or pinned detached worktree) required for the target logical stage.
- **Inputs**: Target repository, base branch, requested feature branch or commit SHA, and workspace configuration.
- **Contract**: Writes Markdown receipt to `contract.receipt_path` and emits `{ execution_status, result: { repository, working_directory, worktree, branch, baseBranch, commit, created }, receipt_path, summary }`.
- **Routing**:
  - `succeeded`: Record environment in `<receipt_root>/state.json` under `context.workspaces` and proceed to the scheduled professional stage.
  - `blocked` or `failed`: Halt immediately and present Blocker Decision Board.

---

## Stage 1 — Planning and Decomposition (`stage_1_plan`)

- **Stage ID**: `stage_1_plan`
- **Logical Task**: `issue_plan`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-issue-plan
    args: []
  ```
- **Objective**: Determine whether subissues are needed and establish the execution plan.
- **Environment**: Explicit existing repository checkout validated by `workspace_prepare`.
- **Inputs**: Root objective, problem context, and acceptance criteria.
- **Expected Result**: Native `result.outcome` of `direct` or `decomposed`. For `decomposed`, include child issue IDs in dependency order in the compact result and preserve the full graph in the receipt.
- **Routing**:
  - `direct`: Set `current_issue_id = root_issue_id`, transition to `stage_2_work`.
  - `decomposed`: Retain the ordered child IDs, set `current_issue_id` to the first child issue, and transition to `stage_2_work` for each child in sequence.
  - A successful plan completes planning only.

---

## Stage 2 — Issue Delivery Loop

Deliver the `current_issue_id` through an implementation and landing loop.

### Stage 2.1 — Issue Implementation (`stage_2_work`)
- **Stage ID**: `stage_2_work`
- **Logical Task**: `issue_work`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-issue-work
    args: []
  ```
  *(Alternative script provider: `type: script`, `target: scripts/automated-worker.py`)*
- **Objective**: Implement required code/tests for `current_issue_id` satisfying all acceptance criteria.
- **Environment**: Prepared isolated feature worktree for `current_issue_id` validated by `workspace_prepare`.
- **Inputs**: Current issue ID, acceptance criteria, predecessor receipts, and accepted workspace preparation with an explicit execution directory.
- **Expected Result**: Verified implementation `commit` and verification conclusion in `result`. Accept only with the required checks and recorded environment.
- **Routing**: Transition to `stage_2_land`, passing the implementation receipt to the landing provider.

### Stage 2.2 — Landing and Merge (`stage_2_land`)
- **Stage ID**: `stage_2_land`
- **Logical Task**: `issue_land`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-pr-land
    args: []
  ```
- **Objective**: Review, verify pre-merge checks, and land (merge) the implementation changes.
- **Environment**: Same feature worktree with verified worktree and latest delivered SHA.
- **Inputs**: Implementation receipt with verified worktree and SHA.
- **Expected Result**: Native `result.outcome`, `merged`, and, for `landed`, `mergedCommit`. The provider validates and uses predecessor worktree and SHA.
- **Routing**:
  - `landed` with verified merge evidence: Delivery accepted. If there are remaining child issues, advance `current_issue_id` to the next child and repeat `stage_2_work`. Once all child issues (or the root issue) are delivered, transition to `stage_3_verify`.
  - `rework_needed`: Routes to a fresh `stage_2_work` execution with the landing receipt. It reads findings, reconciles the recorded environment and SHA, and writes a new receipt. Pass that receipt to a fresh `stage_2_land` execution. Maximum of 3 delivery attempts per issue, including the initial attempt.
  - `blocked`: Execution status `blocked` when prerequisites prevent landing; halt to Blocker Decision Board.

Accept delivery only for `landed` with verified merge evidence.

---

## Stage 3 — Integrated Acceptance Verification (`stage_3_verify`)

- **Stage ID**: `stage_3_verify`
- **Logical Task**: `issue_verify`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-issue-verify
    args: []
  ```
  *(Alternative script provider: `type: script`, `target: scripts/acceptance-runner.py`)*
- **Objective**: Verify parent objective against the integrated HEAD across delivered work.
- **Environment**: Isolated detached worktree pinned to the integrated base commit prepared by `workspace_prepare`.
- **Inputs**: Parent objective, acceptance criteria, delivery receipt paths. Supply execution directory and expected SHA; the verifier validates and records them before checks. Feature-branch receipts serve as delivery evidence when verifying the integrated tree.
- **Expected Result**: Native `result.outcome` and `evaluatedHead`.
- **Routing**:
  - `verified`: Satisfies acceptance for that integrated HEAD; transition to `stage_4_refactor_audit`.
  - `rework_needed`: Routes targeted repairs to `stage_2_work`, followed by another integrated verification. For gaps discovered after merge, assign a fresh repair branch and worktree based on the current base branch, retaining the original issue and delivery-attempt count. Dispatch `workspace_prepare` first, then supply the accepted environment assignment to the worker. Use the merged predecessor for findings and historical evidence. Create repair environment from current base branch. Keep issue delivery-attempt budget across repairs.

---

## Stage 4 — Pipeline Reorganization

Organize touched pipeline files under scientific invariance with a human steering gate on proposed structural changes.

### Stage 4.1 — Pipeline Refactoring Audit & Plan (`stage_4_refactor_audit`)
- **Stage ID**: `stage_4_refactor_audit`
- **Logical Task**: `pipeline_refactor_audit`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-pipeline-refactor
    args: ["--audit"]
  ```
- **Objective**: Audit touched pipeline scope and generate the migration ledger without modifying code or filesystem structures.
- **Environment**: Accepted integrated checkout environment.
- **Inputs**: Touched pipeline scope, target pipeline path, and migration ledger template.
- **Expected Result**: Native `result.outcome` (`plan_ready`, `no_change`, or `out_of_scope`). For `plan_ready`, include `ledgerPath` and a concise summary of proposed path mappings and rewiring in `result`.
- **Routing**:
  - `no_change` with verification evidence: Layout already conforms; transition to `stage_6_research_record`.
  - `plan_ready`: Present the refactoring plan (Migration Ledger summary and path) to the human user via Decision Board for confirmation before proceeding.
    - If approved: Dispatch `stage_4_refactor_execute` with the approved ledger receipt.
    - If skipped/rejected: Skip pipeline reorganization and transition to `stage_6_research_record`.
    - If scope adjustments requested: Dispatch replan or adjust scope.
  - `out_of_scope`: Route to `scope_replan`. Require rationale, affected objectives, and partial-change state in receipt.

### Stage 4.2 — Pipeline Refactoring Execution (`stage_4_refactor_execute`)
- **Stage ID**: `stage_4_refactor_execute`
- **Logical Task**: `pipeline_refactor_execute`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-pipeline-refactor
    args: ["--execute"]
  ```
- **Objective**: Execute approved migration ledger atomically under scientific invariance.
- **Environment**: Fresh branch/worktree prepared from the current integrated base by `workspace_prepare`.
- **Inputs**: Approved migration ledger receipt, target pipeline path, compute environment. Reconcile ledger source paths with the new checkout before changes.
- **Expected Result**: Native `result.outcome` (`completed`, `failed`, or `blocked`) and whether files changed. Receipt records changed files, verification evidence, current worktree state, and remaining consistency work.
- **Routing**:
  - `completed` with changes: Transition to `stage_5_redeliver` after required checks.
  - `failed` or `blocked`: Present Decision Board.

---

## Stage 5 — Re-delivery of Pipeline Changes (`stage_5_redeliver`)

- **Stage ID**: `stage_5_redeliver`
- **Logical Task**: `pipeline_refactor_redeliver`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-pr-land
    args: []
  ```
- **Objective**: Deliver refactored pipeline files.
- **Environment**: Same refactor worktree with verified repository, branch, base branch, and commit.
- **Inputs**: Refactor receipt with verified repository, worktree, branch, base branch, and commit.
- **Expected Result**: Native `result.outcome` of `landed` with `mergedCommit`.
- **Routing**:
  - Apply Stage 2 landing gates and rework limit (max 3 delivery attempts). Use a fresh refactor specialist for structural repairs. Logic changes require replanning.
  - `landed`: Transition to `stage_6_research_record`.

---

## Stage 6 — Research Records & State Finalization (`stage_6_research_record`)

- **Stage ID**: `stage_6_research_record`
- **Logical Task**: `research_record`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-research-state
    args: []
  ```
- **Objective**: Record final research state, artifact locations, and reproduction entry points.
- **Environment**: Validated persistent checkout plus the fixed shared research entry.
- **Inputs**: Completed delivery and verification receipts, validated persistent checkout, fixed shared research entry, and durable artifact locations.
- **Expected Result**: Updated record paths and pending decisions in `result`.
- **Routing**:
  - All gates satisfied: Dispatch `workspace_cleanup` for eligible created environments, record removed and retained paths with reasons, then declare root issue completion.
  - Unresolved decisions affecting required acceptance: Return to planning or human steering.

---

## Auxiliary Stage — Workspace Cleanup (`workspace_cleanup`)

- **Stage ID**: `workspace_cleanup`
- **Logical Task**: `workspace_cleanup`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-workspace
    args: ["--cleanup"]
  ```
  *(Alternative script provider: `type: script`, `target: skills/pc-workspace/scripts/prepare-worktree.py`, `args: ["--cleanup"]`)*
- **Objective**: Perform deterministic cleanup of temporary worktrees and branches created during the workflow run while preserving retained directories.
- **Inputs**: Created workspace candidates, final SHAs, delivery/verification receipts, artifact retention evidence.
- **Contract**: Writes cleanup receipt to `contract.receipt_path` and emits `{ execution_status: "succeeded", result: { removed_paths: [...], retained_paths: [...] }, receipt_path, summary }`.
- **Routing**:
  - Conclude workflow run and declare root issue completed.

---

## Stage — Replanning for Scope Boundaries (`scope_replan`)

When any stage reports `out_of_scope`:

- **Stage ID**: `scope_replan`
- **Logical Task**: `scope_replan`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-issue-plan
    args: ["--replan"]
  ```

1. Dispatch a fresh replanning provider with a scope-reassessment brief, original acceptance criteria, current authorization, predecessor receipts, current artifact state, and a validated planning checkout with explicit directory binding. Reassessment only; preserve existing issue-tracker state.
2. Route based on the planner's professional reassessment conclusion:
   | Planning Conclusion | Orchestrator Action |
   | --- | --- |
   | `revised_plan` | Execute the evidenced alternative within existing scope and acceptance criteria. |
   | `optional_improvement` | Record the deferred improvement and continue only when required acceptance remains satisfied. |
   | `decision_required` | Present the necessary scope, acceptance, or prerequisite decision to the user via Blocker Decision Board. |
3. A provider must establish a consistent, verified handoff state before continuing or deferring work after partial modifications. Arrange bounded recovery first when needed. Keep verified delivery evidence and identify any gates invalidated by the revised plan.
4. Allow at most 2 automatic replanning dispatches per originating stage and current issue. Track identity across revised task names, repairs, and resumptions. Increment count before dispatch and persist in receipt. A plan requiring expanded authorization or changed acceptance criteria goes directly to human steering. If 2 replans fail to enable progress, present attempted alternatives and remaining decision via Blocker Decision Board. Replanning and delivery-attempt budgets are independent and never reset one another.
