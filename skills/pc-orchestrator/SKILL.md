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
3. Checking compact execution reports and consuming professional conclusions.
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
`dispatch(role, skillPath, promptInputs, receiptTemplatePath)` -> `{ execution_status, result, receipt_path, summary }`

The dispatch boundary supplies the report contract below. In this skills-only implementation,
agents check it through instructions. Programmatic validation belongs in a future execution adapter.

---

## Subagent Dispatch & Receipt Protocol

### Issue Tracking Model
Every workflow maintains two issue identifiers:
- `root_issue_id`: The originating parent Issue assigned to this Orchestrator workflow.
- `current_issue_id`: The specific Issue currently in flight (equals `root_issue_id` for atomic issues; represents child sub-issue during decomposed execution).

### Prompt Assembly Standard

Every dispatch opens a fresh agent conversation, including repeated roles, report repairs,
and replanning. Supply the following inputs.

1. **Role and objective** — Target `current_issue_id`, authorized scope, acceptance criteria,
   and the professional skill to load and follow.
2. **Predecessor references** — Absolute receipt paths. Specialists read detailed environment,
   evidence, and findings from these files directly.
3. **Report contract** — Absolute template and assigned `receipt_path`, the execution-status
   definitions below, and the task-specific routing fields required in `result`. Inject this
   envelope at dispatch time. Professional skills own their domain outputs.
4. **Completion evidence** — What must be verified before the assigned task can be accepted.
   Preserve available repository, worktree, branch, base branch, and implementation SHA in
   successor receipts, updating the SHA after repairs.

Resolve `receipt_root` once from the initial absolute checkout supplied in the task environment,
defaulting to `<initial-checkout>-worktrees/.paper-craft/receipts/issue-<root_issue_id>/`.
An explicit root takes precedence. Keep it fixed across worktrees, stages, and retries.
Use filenames `<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md`.
Assign a unique, increasing `step_index` to each invocation and retain it on recovery.
Use the receipt basename as `dispatch_id`. Repairs also identify `original_dispatch_id`.
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

### Report Checks and Repair

Before routing, check the four required fields, the execution-status enum, an object-valued
`result`, the assigned absolute receipt path, and a one-sentence summary. Check routing fields
against the dispatched task requirements. A specialist confirms the receipt exists and agrees
with the compact report. For a complete report, its writer performs this check before returning.
Unknown or contradictory conclusions require report repair before routing.

For a missing, malformed, or inconsistent report, dispatch one fresh report-repair agent for
that original invocation. Supply the expected contract, observed defect, assigned report path,
and known artifact references. It may read existing evidence and repair the report only.
It must not rerun tests, merge, migrate files, or repeat the original task. Missing evidence
stays explicit. If one repair cannot establish a valid report, record `failed` with the protocol
error and halt. If the agent terminated without writing a receipt, recover a conclusion only
from existing evidence. Otherwise record the failure, missing evidence, and last confirmed state.

The report-repair allowance is one per original invocation. Record its use durably and retain
the original report before correction. Use a separate `-report-repair.md` receipt to identify
what was corrected. Task re-execution requires a separate Orchestrator decision after a
specialist reconciles side effects. Report repair never consumes or resets task retry budgets.

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
1. **Identify Stage Contract**: Read the stage's target specialist role, required inputs, predecessor receipts, expected `result` schema, and routing rules.
2. **Dispatch Specialist**: Assemble the task prompt according to [Prompt Assembly Standard](#prompt-assembly-standard), complete the [pre-dispatch reservation](#state-persistence--session-recovery), then dispatch a fresh specialist subagent using the platform adapter.
3. **Verify Report & Receipt**: Check the compact report and receipt integrity according to [Report Checks and Repair](#report-checks-and-repair). If malformed or missing, invoke the report-repair agent.
4. **Evaluate Routing**:
   - Match the returned native `result` against the stage's routing table.
   - For linear progression, advance to the indicated successor stage.
   - For rework, route to the designated repair role with predecessor findings, tracking consumed retry budgets.
   - For human steering gates defined by the workflow (such as refactoring plan approval or planning decisions), halt and present the Decision Board to the user with the specialist's options summary before proceeding.
   - For scope reassessment, execute the workflow's replanning procedure within allowed replan budgets.
   - For `blocked`, `failed`, or exhausted retry budgets, invoke the [Halt & Escalation Protocol](#halt--escalation-protocol).
5. **Completion Gate**: Conclude the orchestration session only when the workflow's terminal gates are satisfied and recorded.

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

- **In-Memory Tracking** — Keep stage progression, issue/attempt identifiers, fixed `receipt_root`, compact reports, and separate delivery, report-repair, and replanning counters in context.
- **Durable File Receipts** — Before a domain task, report repair, or replan, assign an absolute reservation path and dispatch a recording-only specialist with [the dispatch template](templates/dispatch.template.md), the task's assigned receipt path, identity, and consumed budgets. Match its confirmation to the assigned reservation path, `dispatch_id`, and task receipt path before dispatching the task. State-maintenance calls use the compact report envelope and are exempt from reservation, ending this bookkeeping step. An unconfirmed reservation halts dispatch. Result receipts copy the reserved identity and budgets. The fixed folder is the recovery source.
- **External Dashboard**: A dashboard script may observe transcripts for human visibility; the Orchestrator does not query or depend on the dashboard.
- **Resumption**: To resume an interrupted workflow, dispatch a specialist to inspect the fixed `receipt_root` and return a compact recovery report identifying accepted stages, relevant receipt paths, pending side effects, and consumed budgets. Resume from the next pending step. If the root is absent from session context, resolve it from the original checkout or user-supplied receipt location.

For legacy receipts with only the old top-level `outcome`, dispatch report repair before
routing. Recover execution status and professional conclusion from recorded evidence, preserving
the original receipt. Never infer success from an unknown value. If consumed budgets cannot be
established during recovery, request human steering before another automatic attempt.
