---
name: pc-orchestrator
description: Pure dispatch orchestrator — coordinate Issue delivery workflows strictly through subagent delegation without CLI or direct execution.
---

# /pc-orchestrator

The Orchestrator coordinates end-to-end Issue delivery strictly through subagent delegation.
It decides execution sequence, role assignments, predecessor context passing, repair routing,
and completion gates.

## Execution Discipline & State Authority

The Orchestrator **never performs concrete domain work itself**. It is strictly prohibited from:
- Editing, creating, or modifying repository source code, tests, build configurations, or domain assets directly.
- Running test suites, builds, linters, or repository code execution commands via Bash.
- Performing Git operations (branching, commits, merges, worktrees) or GitHub CLI operations (`gh`).
- Reviewing code diffs or judging domain implementation correctness directly.

All domain work, file modifications, git/PR operations, and specialist judgments are performed
exclusively by dedicated Specialist Subagents.

### Authorized Orchestrator Responsibilities
The Orchestrator's sole responsibilities are:
1. Receiving the root Issue and goal from the user.
2. Maintaining workflow runtime state directly by recording state snapshots to `<receipt_root>/state.json`.
3. Assigning execution environments and dispatching workspace preparation, professional tasks, and cleanup through Specialist Subagents.
4. Checking compact execution reports and consuming professional conclusions.
5. Routing to the next stage or dispatching repair subagents.
6. Halting and presenting a Blocker Decision Board when blocked, failed, or when retry budgets expire. Request a concise blocker or decision-options summary from a specialist when needed for the board.

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
`dispatch(role, skillPath, working_directory, promptInputs, receiptTemplatePath)` -> `{ execution_status, result, receipt_path, summary }`

Use a native working-directory field when supported. For prompt-only adapters such as the example
above, inject explicit per-command directory binding as defined in [Workspace lifecycle and dispatch](references/workspaces.md).

The dispatch boundary supplies the report contract below. In this skills-only implementation,
agents check it through instructions. Programmatic validation belongs in a future execution adapter.

---

## Subagent Dispatch & Receipt Protocol

### Issue Tracking Model
Every workflow maintains two issue identifiers:
- `root_issue_id`: The originating parent Issue assigned to this Orchestrator workflow.
- `current_issue_id`: The specific Issue currently in flight (equals `root_issue_id` for atomic issues; represents child sub-issue during decomposed execution).

### Prompt Assembly Standard

Every dispatch opens a fresh agent conversation, including repeated roles, rework,
and replanning. Supply the following inputs.

1. **Role and objective** — Target `current_issue_id`, authorized scope, acceptance criteria,
   and the professional skill to load and follow.
2. **Predecessor references** — Absolute receipt paths. Specialists read detailed environment,
   evidence, and findings from these files directly.
3. **Report contract** — Absolute template and assigned `receipt_path`, the execution-status
   definitions below, and the task-specific routing fields required in `result`. Inject this
   envelope at dispatch time. Professional skills own their domain outputs.
4. **Execution environment** — Required absolute `working_directory`, accepted environment receipt,
   repository, branch or detached HEAD, base branch, expected revision, fixed research entry, and
   required artifact locations. Apply [Workspace lifecycle and dispatch](references/workspaces.md)
   to every stage and nested dispatch.
5. **Completion evidence** — What must be verified before the assigned task can be accepted.
   Preserve available repository, worktree, branch, base branch, and implementation SHA in
   successor receipts, updating the SHA after repairs.

Resolve `receipt_root` once from the initial absolute checkout supplied in the task environment,
defaulting to `<initial-checkout>-worktrees/.paper-craft/receipts/issue-<root_issue_id>/`.
An explicit root takes precedence. Keep it fixed across worktrees, stages, and retries.
Use filenames `<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md`.
Assign a unique, increasing `step_index` to each invocation and retain it on recovery.
Use the receipt basename as `dispatch_id`. Rework tasks also identify `original_dispatch_id`.
The assigned absolute path separately authorizes the report write. Specialists create parent
directories as needed. Receipts remain outside source checkouts and source commits.

### Execution Report Contract

Save the full report using [the receipt template](templates/subagent-receipt.template.md).
Return only this compact JSON object, with task-specific routing fields in `result`.

```json
{
  "execution_status": "succeeded",
  "result": { "outcome": "verified" },
  "receipt_path": "/absolute/path/to/receipt.md",
  "summary": "Integrated acceptance verified"
}
```

- `succeeded` — The assigned evaluation or work produced a valid professional conclusion.
  Review findings, unmet acceptance criteria, and `out_of_scope` can all be valid conclusions.
- `blocked` — A missing prerequisite, access barrier, or environment conflict prevents
  completing the assigned task. Preserve any partial findings and the required intervention.
- `failed` — An execution error or unrecoverable report defect prevents a reliable result.
  Record known side effects and the last confirmed state.

`result` is an object containing the professional conclusion and fields needed for routing.
Retain native terms such as `direct`, `decomposed`, `landed`, `verified`, `rework_needed`,
`no_change`, and `out_of_scope`. `outcome` and `verdict` inside `result` remain domain fields.
An execution status alone never establishes stage acceptance or completion of the root issue.

Keep full findings, environment, evidence, and predecessor references in the receipt.
For tasks with no named domain outcome, request their concrete completion facts in `result`,
such as the verified implementation commit or updated record paths.

### Report Checks and Protocol Integrity

Before routing, check the four required fields (`execution_status`, `result`, `receipt_path`, and `summary`),
the execution-status enum, an object-valued `result`, the assigned absolute receipt path, and a one-sentence summary.
Check routing fields and reported execution environment against the dispatched task requirements.

If a compact report is missing, unparseable, contradictory, or the referenced receipt file does not exist,
the Orchestrator follows Constitution's **Fail Fast**:
- Record the protocol defect in `<receipt_root>/state.json`.
- Halt immediately and present the Blocker Decision Board to the user with the observed defect and last confirmed state.
- Do not dispatch speculative repair agents to guess missing conclusions.

---

## Workflow Execution Engine

The Orchestrator coordinates execution by reading a workflow definition and advancing through
its stages as a state machine. It contains no hardcoded stage logic; domain delivery sequences
are fully decoupled into modular workflow files.

### 1. Workflow Loading
- **Default workflow**: Load `skills/pc-orchestrator/workflows/default.md` (the standard 6-stage delivery workflow).
- **Custom workflow override**: If the user specifies an alternative workflow path in their prompt or configuration, load and follow that workflow definition instead.

### 2. Execution Loop
For each stage defined in the loaded workflow:
1. **Identify Stage Contract & Prepare Environment**: Read the stage's role, inputs, environment source, expected revision, predecessor receipts, expected `result`, and routing rules. Apply [Workspace lifecycle and dispatch](references/workspaces.md), accepting preparation before professional execution.
2. **Record State & Dispatch Specialist**: Update `<receipt_root>/state.json` with the current stage, attempt count, and target receipt path. Assemble the task prompt according to [Prompt Assembly Standard](#prompt-assembly-standard), then dispatch a fresh specialist subagent using the platform adapter.
3. **Verify Report & Receipt**: Check the compact report and receipt integrity according to [Report Checks and Protocol Integrity](#report-checks-and-protocol-integrity). If malformed, missing, or contradictory, halt to the Decision Board.
4. **Evaluate Routing**:
   - Match the returned native `result` against the stage's routing table.
   - For linear progression, advance to the indicated successor stage.
   - For rework, route to the designated repair role with predecessor findings, tracking consumed retry budgets.
   - For human steering gates defined by the workflow (such as refactoring plan approval or planning decisions), halt and present the Decision Board to the user with the specialist's options summary before proceeding.
   - For scope reassessment, execute the workflow's replanning procedure within allowed replan budgets.
   - For `blocked`, `failed`, or exhausted retry budgets, invoke the [Halt & Escalation Protocol](#halt--escalation-protocol).
5. **Completion Gate**: After the workflow's required professional gates succeed, dispatch workspace cleanup and record removed or retained paths with reasons. Conclude only when terminal gates and cleanup results are recorded.

---

## Halt & Escalation Protocol

Halt and present a Decision Board for execution status `blocked` or `failed`,
a workflow human-steering gate (such as refactoring plan approval), a planning conclusion
requiring human steering, a required additional attempt beyond its delivery/replanning allowance,
or an unexpected fatal dispatch failure. A successful final allowed attempt proceeds through its
normal acceptance gates. Valid professional conclusions route according to the loaded workflow
definition. `out_of_scope` enters the workflow's replanning procedure.

### Decision Board Format
When halting, the Orchestrator outputs a structured status board:

```markdown
### ⚠️ Orchestrator Halted: Human Steering Required

- **Root Issue**: #<root_issue_id>
- **Current Issue**: #<current_issue_id>
- **Stage**: <stage_name> (Attempt <attempt>)
- **Reason**: <Clear description of the obstacle, decision required, or plan for review>
- **Completed Receipts**: `<receipt_root>`

#### Options:
1. **[Option 1]**: [Description of option, e.g. Approve plan / Retry with manual fix]
2. **[Option 2]**: [Description of option, e.g. Skip reorganization / Adjust requirements]
3. **[Option 3]**: [Description of option, e.g. Abort workflow / Adjust scope]
```

Wait for the human user's prompt instruction before proceeding.

---

## State Persistence & Session Recovery

- **Structured State Snapshot (`state.json`)** — The Orchestrator maintains `<receipt_root>/state.json` directly as the authoritative runtime state. It updates this file before dispatching a stage and after accepting a receipt.
  ```json
  {
    "root_issue_id": "<root_issue_id>",
    "current_issue_id": "<current_issue_id>",
    "current_stage": "<current_stage_name>",
    "completed_stages": [
      {
        "stage": "<stage_name>",
        "outcome": "<domain_outcome>",
        "receipt_path": "<assigned_absolute_receipt_path>",
        "commit": "<implementation_or_merged_commit>"
      }
    ],
    "context": {
      "workspaces": {}
    },
    "budgets": {
      "delivery_attempts_used": 0,
      "replans_used": 0
    },
    "last_updated": "<iso_timestamp>"
  }
  ```
- **State Machine Helper (`scripts/state_machine.py`)** — The Orchestrator may execute the bundled helper script to perform atomic state transitions, fast budget checks, and crash-resilient updates without manually assembling JSON:
  - Initialize: `python3 <skill-dir>/scripts/state_machine.py init --receipt-root "<receipt_root>" --root-issue <root_id>`
  - Transition: `python3 <skill-dir>/scripts/state_machine.py transition --receipt-root "<receipt_root>" --stage <stage> --status <status> [--outcome <outcome>] [--receipt "<receipt_path>"] [--incr-budget delivery_attempts_used] [--set <key=val>]`
  - Inspect / Resume: `python3 <skill-dir>/scripts/state_machine.py show --receipt-root "<receipt_root>" [--json]`
  - Check Budget: `python3 <skill-dir>/scripts/state_machine.py check-budget --receipt-root "<receipt_root>" --type <delivery|replan> --limit <max>`
- **Durable File Receipts** — Specialist agents write their evidence, logs, and verification outputs to their assigned `<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md` file using [the receipt template](templates/subagent-receipt.template.md). Receipts remain outside source checkouts.
- **Resumption ($O(1)$)** — To resume an interrupted workflow, the Orchestrator reads `<receipt_root>/state.json` directly:
  1. If `state.json` exists, restore in-memory tracking from its fields and resume from `current_stage` using the recorded receipt references, workspace assignments, and consumed budgets. If an older snapshot lacks workspace assignments, have `pc-workspace` validate the environment in the last accepted receipt before professional work. Preserve uncertain ownership as reused for automatic cleanup.
  2. If `state.json` is missing or corrupted, halt to the Decision Board for human steering rather than guessing past states.
- **External Dashboard**: A dashboard script may observe transcripts for human visibility; the Orchestrator does not query or depend on the dashboard.
