# Default Issue Delivery Workflow

- **Workflow Name**: default
- **Version**: 1.0.0
- **Initial Stage**: stage_1_plan
- **Target**: Coordinate end-to-end issue delivery from planning through implementation, landing, verification, refactoring, and state recording.
- **Workflow Definition**: Defined in [default.yaml](default.yaml).

This document provides natural-language documentation for the lifecycle stages, environment bindings, routing rules, and acceptance gates declared in `default.yaml`.

---

---

## Environment assignments & lifecycle

Apply [workspace lifecycle and dispatch](../references/workspaces.md) before every professional task.
Environment preparation and cleanup are defined as decoupled logical tasks (`workspace_prepare` and `workspace_cleanup`), executable via dedicated skill subagents.

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
| `issue_finalize` | Retained persistent checkout | Accepted verification and research receipts |
| `workspace_cleanup` | Retained persistent checkout | Reconciled issue-tree resources, including evidenced historical resources |

Carry explicit artifact locations into verification and research recording. After all professional stages succeed, dispatch `issue_finalize`, then `workspace_cleanup`. Finish only after verified issue closure and zero retained cleanup targets.

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
- **Objective**: Determine whether subissues are needed and establish a filed, dispatch-ready execution plan.
- **Environment**: Explicit existing repository checkout validated by `workspace_prepare`.
- **Inputs**: Root objective, problem context, acceptance criteria, and delivery intent authorizing the planner to create necessary child issues and synchronize their native relationships and parent tasklist.
- **Expected Result**: Native `result.outcome` of `direct` or `decomposed`. The receipt contains the stage table, candidate disposition reasons, and parent-requirement coverage required by `pc-issue-plan`. For `decomposed`, include real child issue IDs and `blockedBy` dependencies in the compact result and preserve the full graph and verified filing evidence in the receipt.
- **Acceptance**: Before routing, check the planning evidence. A root `direct` requires one cohesive stage and reasons why other candidates lack separate acceptance checkpoints; a depth-limited `direct` requires verified parent evidence. A `decomposed` plan requires filed children, synchronized relationships and tasklist, and an acyclic dependency graph covering the planned work. For a structurally valid report with incomplete planning evidence, dispatch one fresh planner with the missing evidence and predecessor receipt; if still incomplete, halt to the Decision Board. Pending filing is not permission to implement the root instead.
- **Routing**:
  - `direct`: Set `current_issue_id = root_issue_id`, transition to `stage_2_work`.
  - `decomposed`: Accept the planned child issue sequence snapshot. Initialize the delivery sequence and set `current_issue_id` to the first child issue in the ordered sequence, transitioning to `stage_2_work`. Execute child issues strictly sequentially through `stage_2_work` → `stage_2_land`; child issues do not execute independent verify/finalize. The root remains the integrated acceptance target.
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
- **Objective**: Implement required code/tests for `current_issue_id` satisfying all acceptance criteria.
- **Environment**: Prepared isolated feature worktree for `current_issue_id` validated by `workspace_prepare`.
- **Inputs**: Current issue ID, acceptance criteria, predecessor receipts, and accepted workspace preparation with an explicit execution directory.
- **Expected Result**: Verified implementation `commit` and verification conclusion in `result`. Accept only with the required checks and recorded environment.
- **Routing**:
  - `succeeded`: Transition to `stage_2_land`, passing the implementation receipt to the landing provider. A single delivery attempt covers the paired `stage_2_work` and `stage_2_land`.
  - `failed` or `rework_needed`: Execution stops and stays on `current_issue_id`. The orchestrator may explicitly initiate the next attempt for this issue via `prepare` with `attempt_intent="new"`, which consumes only that issue's independent delivery budget. Other issues in the delivery sequence are unaffected, and previous attempt history is preserved without zeroing.

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
- **Inputs**: Implementation receipt with verified worktree and SHA. Pass issue association references without automatic closing keywords. Parent tasklists are updated after acceptance, not landing.
- **Expected Result**: Native `result.outcome`, `merged`, and, for `landed`, `mergedCommit`. The provider validates and uses predecessor worktree and SHA.
- **Routing**:
  - `landed` with verified merge evidence: Record merge evidence. For a child issue, advance directly to the next child issue in the ordered delivery sequence (`stage_2_work`), without child-level independent verification or finalization. Child issues rely on merge evidence for sequence progression; final closure verification is unified at root finalization. If children remain in the delivery sequence, execute the next child sequentially through `stage_2_work` and `stage_2_land`, passing predecessor receipts. Once all child issues (or the direct root issue) in the delivery sequence are landed, transition to `stage_3_verify` with the parent root objective and all delivery receipts.
  - `rework_needed` or `failed`: Execution stays on `current_issue_id`. Routes to a fresh `stage_2_work` execution with `attempt_intent="new"`, consuming one delivery attempt from that issue's independent budget (maximum 3 delivery attempts per issue). Switching targets, run recovery, and post-merge repairs never zero consumed attempts. When budget is exhausted, further attempts are blocked.
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
- **Entry Gate**: All planned children have accepted delivery evidence, or the root was delivered directly. Individual child completion does not establish parent acceptance.
- **Objective**: Verify every original parent requirement and acceptance threshold against the integrated HEAD and combined artifacts. Check that the delivered children collectively fulfill the parent, including cross-child integration; child receipts support this verification but do not replace it.
- **Environment**: Isolated detached worktree pinned to the integrated base commit prepared by `workspace_prepare`.
- **Inputs**: Parent objective, acceptance criteria, delivery receipt paths. Supply execution directory and expected SHA; the verifier validates and records them before checks. Feature-branch receipts serve as delivery evidence when verifying the integrated tree.
- **Expected Result**: Native `result.outcome` and `evaluatedHead`.
- **Routing**:
  - `verified`: Every original parent acceptance criterion has passing evidence for that integrated HEAD; transition to `stage_4_refactor_audit`. Missing evidence or unmet criteria keep parent acceptance incomplete, even when all children are closed.
  - `rework_needed`: When parent acceptance identifies defects attributable to an existing issue, the orchestrator designates that issue for targeted rework via `prepare` with `--rework-issue <issue_id>` (or in the prepare request) and `attempt_intent="new"`. Targeted rework reuses the target issue's work/land loop and its own independent delivery budget, retaining previous attempt history without zeroing. When the targeted rework issue lands, the delivery sequence routes directly back to `stage_3_verify` for the root issue; other already landed issues are not re-executed, their budgets and records remain untouched, and sequence order is preserved. Gaps that cannot be attributed to an existing issue must be routed to replanning (`scope_replan`); the kernel rejects unattributable rework targets rather than guessing attribution or replacing the plan.

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
  - `landed`: Reverify the root criteria against the new integrated HEAD before transitioning to `stage_6_research_record`.

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
  - All gates satisfied: Dispatch `issue_finalize` for the root and all descendants, then `workspace_cleanup` with its reconciled resource inventory.
  - Unresolved decisions affecting required acceptance: Return to planning or human steering.

---

## Auxiliary Stage — Issue Finalization (`issue_finalize`)

- **Stage ID**: `issue_finalize`
- **Logical Task**: `issue_finalize`
- **Default Provider**:
  ```yaml
  provider:
    type: skill
    target: pc-issue-verify
    args: []
  ```
- **Objective**: Execute the acceptance-backed closure task in its [closure contract](../../pc-issue-verify/references/closure.md).
- **Environment**: Retained persistent checkout, with durable acceptance and research receipts.
- **Inputs**: Root issue, current closure target, accepted integrated SHA, acceptance receipts and historical delivery records. For root finalization, include completed research recording.
- **Gate**: Unified closure reconciliation happens after integrated acceptance and research recording. Child issues do not run independent finalize stages during Stage 2; their closed states and the parent tasklist are verified together during root finalization.
- **Result**: `outcome: finalized`, `root_issue_id`, `scope: tree` for final root reconciliation, nonempty `issues` containing repository, number, observed `state: CLOSED` and acceptance receipt, plus reconciled cleanup candidates and unresolved ownership items. Missing evidence or unresolved issue state blocks finalization.
- **Routing**: Root finalization proceeds to cleanup. Retry only unfinished closure/reconciliation operations, reading live states first.

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
- **Objective**: Remove eligible worktrees and merged local and remote task branches belonging to the root issue tree, including evidenced historical resources; retain changed or still-used resources with reasons.
- **Inputs**: Supply `inputs.parameters.candidates` using the cleanup candidate contract in `pc-workspace` §5. Reconcile the finalization inventory and historical ownership evidence with final SHAs, PR identities, delivery/verification receipts, durable artifact locations, and completed-consumer status. Carry the recorded delivery target, base remote, and push remote for each branch, and forward unresolved inventory items in `inputs.parameters.unresolved`.
- **Contract**: Writes cleanup receipt to `contract.receipt_path` and emits `{ execution_status: "succeeded", result: { outcome: "cleaned" | "incomplete", removed_paths: [...], retained_paths: [...], removed_branches: [...], retained_branches: [...] }, receipt_path, summary }`.
- **Routing**:
  - Finish only when `result.outcome` is `cleaned` and both retained lists are empty, with a preceding successful root `issue_finalize` receipt. Otherwise report delivery complete / cleanup incomplete and retry outstanding resources after rechecking live state. Preserve closed issues and accepted delivery; do not repeat implementation or merges.

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
