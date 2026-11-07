# Default Issue Delivery Workflow

- **Workflow Name**: default
- **Initial Stage**: Stage 1
- **Target**: Coordinate end-to-end issue delivery from planning through implementation, landing, verification, refactoring, and state recording.

---

## Stage 1 — Planning and Decomposition (`pc-issue-plan`)

- **Role**: `pc-issue-plan`
- **Objective**: Determine whether subissues are needed and establish the execution plan.
- **Inputs**: Root objective, problem context, and acceptance criteria.
- **Expected Result**: Native `result.outcome` of `direct` or `decomposed`. For `decomposed`, include child issue IDs in dependency order in the compact result and preserve the full graph in the receipt.
- **Routing**:
  - `direct`: Set `current_issue_id = root_issue_id`, transition to Stage 2.
  - `decomposed`: Retain the ordered child IDs, set `current_issue_id` to the first child issue, and run Stage 2 through completion for each child in sequence.
  - A successful plan completes planning only.

---

## Stage 2 — Issue Delivery Loop

Deliver the `current_issue_id` through an implementation and landing loop.

1. **Implementation (`pc-issue-work`)**:
   - **Role**: `pc-issue-work`
   - **Inputs**: Current issue ID, acceptance criteria, predecessor receipts.
   - **Expected Result**: Verified implementation `commit` and verification conclusion in `result`. Accept only with the required checks and recorded environment.
   - **Routing**: Pass implementation receipt to a fresh landing specialist.

2. **Landing (`pc-pr-land`)**:
   - **Role**: `pc-pr-land`
   - **Inputs**: Implementation receipt with verified worktree and SHA.
   - **Expected Result**: Native `result.outcome`, `merged`, and, for `landed`, `mergedCommit`. The specialist validates and uses predecessor worktree and SHA.
   - **Routing**:
     - `landed` with verified merge evidence: Delivery accepted. If there are remaining child issues, advance `current_issue_id` to the next child and repeat Stage 2. Once all child issues (or the root issue) are delivered, transition to Stage 3.
     - `rework_needed`: Routes to a fresh `pc-issue-work` specialist with the landing receipt. It reads findings, reconciles the recorded environment and SHA, and writes a new receipt. Pass that receipt to a fresh landing specialist. Maximum of 3 delivery attempts per issue, including the initial attempt.
     - `blocked`: Execution status `blocked` when prerequisites prevent landing; halt to Blocker Decision Board.

Accept delivery only for `landed` with verified merge evidence.

---

## Stage 3 — Integrated Acceptance (`pc-issue-verify`)

- **Role**: `pc-issue-verify`
- **Objective**: Verify parent objective against the integrated HEAD across delivered work.
- **Inputs**: Parent objective, acceptance criteria, delivery receipt paths. Verifier resolves integrated base-branch checkout and pins HEAD before checks, recording repository, checkout, and evaluated SHA in receipt. Feature-branch receipts serve as delivery evidence when verifying the integrated tree.
- **Expected Result**: Native `result.outcome` and `evaluatedHead`.
- **Routing**:
  - `verified`: Satisfies acceptance for that integrated HEAD; transition to Stage 4.
  - `rework_needed`: Routes targeted repairs to Stage 2, followed by another integrated verification. For gaps discovered after merge, assign a fresh repair branch and worktree based on the current base branch, retaining the original issue and delivery-attempt count. Supply explicit environment assignments to the worker. Use the merged predecessor for findings and historical evidence. Create repair environment from current base branch. Keep issue delivery-attempt budget across repairs.

---

## Stage 4 — Pipeline Reorganization (`pc-pipeline-refactor`)

Organize touched pipeline files under scientific invariance with a human steering gate on proposed structural changes.

1. **Refactoring Audit & Plan (`pc-pipeline-refactor`)**:
   - **Role**: `pc-pipeline-refactor`
   - **Objective**: Audit touched pipeline scope and generate the migration ledger without modifying code or filesystem structures.
   - **Inputs**: Touched pipeline scope, target pipeline path, and migration ledger template.
   - **Expected Result**: Native `result.outcome` (`plan_ready`, `no_change`, or `out_of_scope`). For `plan_ready`, include `ledgerPath` and a concise summary of proposed path mappings and rewiring in `result`.
   - **Routing**:
     - `no_change` with verification evidence: Layout already conforms; transition to Stage 6.
     - `plan_ready`: Present the refactoring plan (Migration Ledger summary and path) to the human user via Decision Board for confirmation before proceeding.
       - If approved: Dispatch Step 2 (Execution) with the approved ledger receipt.
       - If skipped/rejected: Skip pipeline reorganization and transition to Stage 6.
       - If scope adjustments requested: Dispatch replan or adjust scope.
     - `out_of_scope`: Route to Replanning for Scope Boundaries below. Require rationale, affected objectives, and partial-change state in receipt.

2. **Refactoring Execution (`pc-pipeline-refactor`)**:
   - **Role**: `pc-pipeline-refactor`
   - **Objective**: Execute approved migration ledger atomically under scientific invariance.
   - **Inputs**: Approved migration ledger receipt, target pipeline path, compute environment. Prepare and record fresh branch/worktree from integrated base before changes, preserving merged delivery environment as history.
   - **Expected Result**: Native `result.outcome` (`completed`, `failed`, or `blocked`) and whether files changed. Receipt records changed files, verification evidence, current worktree state, and remaining consistency work.
   - **Routing**:
     - `completed` with changes: Transition to Stage 5 after required checks.
     - `failed` or `blocked`: Present Decision Board.

---

## Stage 5 — Re-delivery of Pipeline Changes (`pc-pr-land`)

- **Role**: `pc-pr-land`
- **Objective**: Deliver refactored pipeline files.
- **Inputs**: Refactor receipt with verified repository, worktree, branch, base branch, and commit.
- **Expected Result**: Native `result.outcome` of `landed` with `mergedCommit`.
- **Routing**:
  - Apply Stage 2 landing gates and rework limit (max 3 delivery attempts). Use a fresh refactor specialist for structural repairs. Logic changes require replanning.
  - `landed`: Transition to Stage 6.

---

## Stage 6 — Research Records (`pc-research-state`)

- **Role**: `pc-research-state`
- **Objective**: Record final research state, artifact locations, and reproduction entry points.
- **Inputs**: Completed delivery and verification receipts.
- **Expected Result**: Updated record paths and pending decisions in `result`.
- **Routing**:
  - All gates satisfied: Declare root issue completion.
  - Unresolved decisions affecting required acceptance: Return to planning or human steering.

---

## Replanning for Scope Boundaries

When any stage reports `out_of_scope`:

1. Dispatch a fresh `pc-issue-plan` agent with a scope-reassessment brief, original acceptance criteria, current authorization, predecessor receipts, and current artifact state. Reassessment only; preserve existing issue-tracker state.
2. Route based on the planner's professional reassessment conclusion:
   | Planning conclusion | Orchestrator action |
   | --- | --- |
   | `revised_plan` | Execute the evidenced alternative within existing scope and acceptance criteria. |
   | `optional_improvement` | Record the deferred improvement and continue only when required acceptance remains satisfied. |
   | `decision_required` | Present the necessary scope, acceptance, or prerequisite decision to the user via Blocker Decision Board. |
3. A specialist must establish a consistent, verified handoff state before continuing or deferring work after partial modifications. Arrange bounded recovery first when needed. Keep verified delivery evidence and identify any gates invalidated by the revised plan.
4. Allow at most 2 automatic replanning dispatches per originating stage and current issue. Track identity across revised task names, repairs, and resumptions. Increment count before dispatch and persist in receipt. A plan requiring expanded authorization or changed acceptance criteria goes directly to human steering. If 2 replans fail to enable progress, present attempted alternatives and remaining decision via Blocker Decision Board. Replanning and delivery-attempt budgets are independent and never reset one another.
