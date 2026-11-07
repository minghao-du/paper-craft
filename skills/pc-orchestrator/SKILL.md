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
3. Parsing subagent receipt outcomes (`completed`, `rework_needed`, `blocked`, `failed`).
4. Routing to the next stage or dispatching repair subagents.
5. Halting and presenting a Blocker Decision Board when blocked or when retry budgets expire.

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
`dispatch(role, skillPath, promptInputs, receiptTemplatePath)` -> `SubagentReceipt`

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
3. **Predecessor Context**: Relevant upstream artifacts (e.g. branch name, commit SHA, PR URL, review feedback if repair).
4. **Receipt Contract**: Directive to inspect the template at `skills/pc-orchestrator/templates/subagent-receipt.template.md`, save the filled receipt to `.paper-craft/receipts/issue-<root_issue_id>/<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md`, and return the receipt content in the subagent's final response.

### Subagent Receipt Schema
Subagents record results following [templates/subagent-receipt.template.md](templates/subagent-receipt.template.md):
- **Metadata**: `root_issue_id`, `current_issue_id`, `task_type`, `attempt`, `outcome`
- **Artifacts**: `branch`, `commit`, `pr`
- **Feedback**: Defect list (if `rework_needed`) or blocker details (if `blocked`)

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
- If outcome is `direct`: Execute single delivery loop with `current_issue_id = root_issue_id`.
- If outcome is `decomposed`: Extract child sub-issues and dependency graph; schedule execution in topological order.

### Stage 2: Issue Delivery Loop (Per Issue)
For each target issue in dependency order:
1. **Implementation (`pc-issue-work`)**: Dispatch subagent to implement changes and verify with TDD tests in an isolated branch. Specialist delivers code and verification evidence; does not create a PR.
2. **Landing & Merge (`pc-pr-land`)**: Dispatch subagent to create/update PR, trigger review, verify HEAD commit, and merge onto the base branch.
3. **Rework Handling**: If `pc-pr-land` reports `rework_needed`, dispatch a fresh repair subagent to `pc-issue-work` supplying the review feedback and predecessor commit SHA. Re-evaluate with a fresh `pc-pr-land`. Repeat up to 3 attempts.

### Stage 3: Integrated Acceptance Verification (`pc-issue-verify`)
Dispatch verification subagent using `skills/pc-issue-verify/SKILL.md` with the parent objective, acceptance criteria, and aggregated delivery receipts. If acceptance gaps remain, dispatch targeted repair tasks back to Stage 2.

### Stage 4: Pipeline File Reorganization (`pc-pipeline-refactor`)
Dispatch subagent to organize workflow files touched during delivery, strictly preserving scientific invariance. If computational logic changes are required, subagent reports `out_of_scope` and aborts refactoring.

### Stage 5: Re-delivery on Pipeline Changes (`pc-pr-land`)
If `pc-pipeline-refactor` produced file modifications, dispatch a fresh `pc-pr-land` subagent to deliver and merge the refactored files.

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
- **Completed Receipts**: `.paper-craft/receipts/issue-<root_issue_id>/`

#### Options:
1. **Retry with manual fix**: [Description of manual intervention]
2. **Adjust requirements**: [Description of scope adjustment]
3. **Abort workflow**: Terminate current issue run
```

Wait for the human user's prompt instruction before proceeding.

---

## State Persistence & Session Recovery

- **In-Memory Tracking**: Under normal operation, the Orchestrator maintains stage progression and task linkages directly in conversation context.
- **Durable File Receipts**: Subagents write receipts to `.paper-craft/receipts/issue-<root_issue_id>/`. This folder serves as the durable audit trail and recovery source.
- **External Dashboard**: A dashboard script may observe transcripts for human visibility; the Orchestrator does not query or depend on the dashboard.
- **Resumption**: To resume an interrupted workflow, the Orchestrator inspects `.paper-craft/receipts/issue-<root_issue_id>/`, identifies the highest completed stage, and resumes from the next pending step.
