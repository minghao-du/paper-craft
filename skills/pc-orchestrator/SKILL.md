---
name: pc-orchestrator
description: Pure dispatch orchestrator — coordinate Issue delivery workflows strictly through subagent delegation without CLI or direct execution.
---

# /pc-orchestrator

The Orchestrator coordinates end-to-end Issue delivery strictly through subagent delegation.
It decides execution sequence, role assignments, predecessor context passing, repair routing,
and completion gates.

## Strict Zero-Execution Discipline

The Orchestrator **never performs concrete work itself**. It is strictly prohibited from:
- Editing, creating, or modifying repository code or configuration files directly.
- Running tests, builds, linting, or shell commands via Bash.
- Performing Git operations (branching, commits, merges, worktrees) or GitHub CLI operations (`gh`).
- Reviewing code diffs or judging implementation correctness directly.

All domain work, file modifications, git/PR operations, and specialist judgments are performed
exclusively by dedicated Specialist Subagents. The Orchestrator's sole responsibility is:
1. Receiving the root Issue and goal from the user.
2. Assembling task prompts and dispatching the appropriate Specialist Subagents.
3. Parsing compact subagent result outcomes (`completed`, `rework_needed`, `blocked`, `failed`).
4. Routing to the next stage or dispatching repair subagents.
5. Halting and presenting a Blocker Decision Board when blocked or when retry budgets expire. Request a concise blocker or decision-options summary from a specialist when needed for the board.

---

## Platform Dispatch Adapter

Subagents are invoked through platform-specific dispatch primitives. The target platform can be
provided by the user (defaults to `antigravity`).

### 1. Antigravity Adapter (Default)
In Antigravity, dispatch subagents using `invoke_subagent`:
```json
{
  "TypeName": "self",
  "Role": "<Specialist Role Name>",
  "Prompt": "<Assembled Subagent Prompt>"
}
```

### 2. Extensible Dispatch Signature
Any supporting platform must implement the abstract contract:
`dispatch(role, skillPath, promptInputs, receiptTemplatePath)` -> `{ outcome, receipt_path, summary }`

---

## Subagent Dispatch & Receipt Protocol

### Issue Tracking Model
Every workflow maintains two issue identifiers:
- `root_issue_id`: The originating parent Issue assigned to this Orchestrator workflow.
- `current_issue_id`: The specific Issue currently in flight (equals `root_issue_id` for atomic issues; represents child sub-issue during decomposed execution).

### Prompt Assembly Standard
When dispatching any Specialist Subagent, the Orchestrator supplies:
1. **Target Role & Objective**: Problem statement, target issue (`current_issue_id`), and explicit goal.
2. **Specialist Skill Directive**: Instruction to load and strictly follow `skills/pc-<name>/SKILL.md`.
3. **Predecessor Reference** — Absolute `predecessor_receipt_path` for the relevant upstream result. Instruct the specialist to read that file for environment, verification evidence, and repair findings. Keep detailed artifacts in the file and forward its path between stages.
4. **Receipt Contract** — Supply the absolute template path and an absolute `receipt_path` beneath the fixed `receipt_root`. Instruct the specialist to save the completed receipt there and return only `outcome`, `receipt_path`, and a one-sentence `summary`. The assigned receipt path authorizes that result write separately from source edits in the issue worktree.

Resolve `receipt_root` once from the initial absolute checkout supplied in the task environment, defaulting to `<initial-checkout>-worktrees/.paper-craft/receipts/issue-<root_issue_id>/`. An explicit receipt root takes precedence. Keep it fixed across worktrees, stages, and retries. Use filenames `<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md`. Specialists create parent directories as needed. The default keeps receipts outside source checkouts and source commits without relying on ignore rules.

### Subagent Receipt Schema

Retain only issue/stage/attempt state and compact results in dispatch context. Successor specialists load detailed receipts on demand. For older receipts, dispatch a specialist to resolve missing environment fields and persist an updated receipt before delivery.

Subagents record results following [templates/subagent-receipt.template.md](templates/subagent-receipt.template.md):
- **Metadata**: `root_issue_id`, `current_issue_id`, `task_type`, `attempt`, `outcome`
- **Artifacts** — `repository`, absolute `worktree`, `branch`, `baseBranch`, `commit`, `pr`. Specialists copy available environment fields into successor receipts and update the implementation SHA after repairs.
- **Feedback**: Defect list (if `rework_needed`) or blocker details (if `blocked`)

Normalize a successful `landed` task result to receipt outcome `completed`, preserving the task-specific result and merge SHA in the file.

---

## Default Delivery Procedure

The Orchestrator dispatches subagents across the 6 standard stages:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. pc-issue-plan (Planning & Decomposition)                     │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Issue Delivery Loop (for each sub-issue in dependency order)  │
│    ┌──────────────────┐          ┌─────────────────────────┐    │
│    │  pc-issue-work   │ ───────► │       pc-pr-land        │    │
│    └────────▲─────────┘          └────────────┬────────────┘    │
│             │   rework_needed (max 3 tries)   │                 │
│             └─────────────────────────────────┘                 │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. pc-issue-verify (Integrated Acceptance Verification)         │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. pc-pipeline-refactor (Scientific Invariance Reorganization)  │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. pc-pr-land (Refactor Landing, only if files changed)         │
└───────────────────────────────┬─────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. pc-research-state (Nexus Records & Reproduction Entries)     │
└─────────────────────────────────────────────────────────────────┘
```

### Stage 1: Planning & Decomposition (`pc-issue-plan`)
Dispatch subagent to evaluate `root_issue_id` using `skills/pc-issue-plan/SKILL.md`:
- Persist the full planning result and dependency graph in the receipt. Normalize successful `direct` and `decomposed` task results to receipt outcome `completed`; its one-sentence summary supplies the planning mode and child issue IDs in dependency order.
- For `direct`, execute a single delivery loop with `current_issue_id = root_issue_id`.
- For `decomposed`, retain the ordered child IDs for dispatch. Specialists read the plan receipt for issue details and dependencies.

### Stage 2: Issue Delivery Loop (Per Issue)
For each target issue in dependency order:
1. **Implementation (`pc-issue-work`)**: Dispatch subagent to prepare or validate an isolated worktree, implement changes, and verify with TDD tests. The specialist saves its environment and verification evidence in its receipt and returns a compact result.
2. **Landing & Merge (`pc-pr-land`)**: Pass the implementation `receipt_path` as `predecessor_receipt_path`. The landing specialist reads it, validates and uses the same worktree and delivered SHA, creates/updates the PR, invokes review, and lands the guarded merge.
3. **Rework Handling**: If `pc-pr-land` reports `rework_needed`, dispatch a fresh repair subagent to `pc-issue-work` passing the landing receipt path. The repair specialist reads findings and reuses its recorded worktree, branch, base branch, and predecessor SHA, then saves the updated environment in a new receipt. Pass that repair receipt path to a fresh `pc-pr-land`. Repeat up to 3 attempts.

### Stage 3: Integrated Acceptance Verification (`pc-issue-verify`)
Dispatch verification subagent using `skills/pc-issue-verify/SKILL.md` with the parent objective, acceptance criteria, and delivery receipt paths to read on demand. If acceptance gaps remain, dispatch targeted repair tasks back to Stage 2.

### Stage 4: Pipeline File Reorganization (`pc-pipeline-refactor`)
Dispatch subagent to organize workflow files touched during delivery, strictly preserving scientific invariance. If computational logic changes are required, subagent reports `out_of_scope` and aborts refactoring.

### Stage 5: Re-delivery on Pipeline Changes (`pc-pr-land`)
If `pc-pipeline-refactor` produced file modifications, require its receipt to include the verified worktree, repository, branch, base branch, and commit. Pass that receipt path to a fresh `pc-pr-land` subagent.

### Stage 6: Final Research Records (`pc-research-state`)
Dispatch subagent to record updated research state, artifact locations, and reproduction entry points in the nexus repository.

---

## Halt & Escalation Protocol

The Orchestrator immediately halts dispatch and yields control to the human user when:
1. Any subagent returns `outcome: blocked` (e.g. missing external weights, datasets, credentials).
2. Rework attempts for a task reach the maximum retry limit (default: 3 attempts).
3. Any unexpected fatal failure occurs.

### Blocker Decision Board Format
When halting, the Orchestrator outputs a structured status board:

```markdown
### ⚠️ Orchestrator Halted: Human Steering Required

- **Root Issue**: #<root_issue_id>
- **Current Issue**: #<current_issue_id>
- **Stage**: <stage_name> (Attempt <attempt>)
- **Blocker Reason**: <Clear description of the obstacle or defect summary>
- **Completed Receipts**: `<receipt_root>`

#### Options:
1. **Retry with manual fix**: [Description of manual intervention]
2. **Adjust requirements**: [Description of scope adjustment]
3. **Abort workflow**: Terminate current issue run
```

Wait for the human user's prompt instruction before proceeding.

---

## State Persistence & Session Recovery

- **In-Memory Tracking** — Keep stage progression, issue/attempt identifiers, fixed `receipt_root`, and compact results in conversation context.
- **Durable File Receipts**: Subagents write receipts to `<receipt_root>`. This fixed absolute folder serves as the durable audit trail and recovery source.
- **External Dashboard**: A dashboard script may observe transcripts for human visibility; the Orchestrator does not query or depend on the dashboard.
- **Resumption**: To resume an interrupted workflow, dispatch a specialist to inspect the fixed `receipt_root` and return a compact recovery result identifying completed stages and relevant receipt paths. Resume from the next pending step. If the root is absent from session context, resolve it from the original checkout or user-supplied receipt location.
