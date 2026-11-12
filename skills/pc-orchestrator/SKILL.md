---
name: pc-orchestrator
description: Pure dispatch orchestrator — coordinate Issue delivery workflows strictly through subagent delegation through specialist skills and fixed lifecycle helpers.
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
2. Maintaining workflow runtime state exclusively via the lifecycle kernel helper (`packages/orchestrator/src/cli.ts`), never editing `<receipt_root>/state.json` directly.
3. Requesting Task Input Envelopes and launch authorization from the kernel and launching specialist subagents through the platform adapter.
4. Checking compact execution reports and consuming professional conclusions.
5. Routing to the next stage or dispatching repair subagents.
6. Halting and presenting a Blocker Decision Board when blocked, failed, or when retry budgets expire. Request a concise blocker or decision-options summary from a specialist when needed for the board.

---

## Platform Dispatch Adapter & Execution Providers

Workflow stages are executed through modular Execution Providers resolved at runtime. In accordance
with the pure-skill architecture, execution providers are strictly skill-based:

### 1. Execution Provider Resolution
For every stage, the Orchestrator evaluates `stage.provider`:
- **`skill` Provider** (`type: "skill"`): Dispatches an autonomous LLM Specialist Subagent via platform adapter (`invoke_subagent`), loading the designated skill (`target: "<skill-name>"`) with a standardized slim prompt pointing to the Task Input Envelope file.

### 2. Antigravity Adapter (Default)
In Antigravity:
- **Skill Dispatch**:
  ```json
  {
    "TypeName": "self",
    "Role": "<Specialist Role Name>",
    "Prompt": "<Standardized Slim Prompt>"
  }
  ```

### 3. Extensible Dispatch Signature
Any supporting platform must implement the abstract contract:
- `dispatch_skill(role, envelope_path)` -> `{ execution_status, result, receipt_path, summary }`

Specialist subagents consume the Task Input Envelope file and return the standard compact report contract.

---

## Subagent Dispatch & Receipt Protocol

### Issue Tracking Model
Every workflow maintains two issue identifiers:
- `root_issue_id`: The originating parent Issue assigned to this Orchestrator workflow.
- `current_issue_id`: The specific Issue currently in flight (equals `root_issue_id` for atomic issues; represents child sub-issue during decomposed execution).

### Task Input Envelope Standard

The lifecycle kernel writes the structured Task Input Envelope to
`<receipt_root>/<step_index>-input.json` and assigns its receipt path on each new dispatch.

The Task Input Envelope schema contains 7 top-level sections:
1. `schema_version`: Always `"1.0"`.
2. `task`: `{ "logical_stage": string, "step_index": int, "attempt": int, "root_issue_id": string, "current_issue_id": string }`.
3. `provider`: `{ "type": "skill", "target": string, "args": string[] }`.
4. `environment`: `{ "working_directory": string, "repository": string, "base_branch": string, "branch": string | null, "commit": string | null }`.
5. `inputs`: `{ "objective": string, "scope": string, "acceptance_criteria": string[], "predecessor_receipts": string[], "parameters": object }`.
6. `contract`: `{ "receipt_path": string, "receipt_template": string }`.
7. `budgets`: `{ "delivery_attempts_used": int, "delivery_attempts_max": int, "replans_used": int, "replans_max": int }`.

Resolve `receipt_root` once from the initial absolute checkout supplied in the task environment,
defaulting to `<initial-checkout>-worktrees/.paper-craft/receipts/issue-<root_issue_id>/`.
An explicit root takes precedence. Keep it fixed across worktrees, stages, and retries.
Use filenames:
- Task Input Envelope: `<receipt_root>/<step_index>-input.json`
- Durable Markdown Receipt: `<receipt_root>/<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md`
Assign a unique, increasing `step_index` to each invocation and retain it on recovery.
Use the receipt basename as `dispatch_id`. Rework tasks also identify `original_dispatch_id`.
The assigned absolute path authorizes the report write. Providers create parent directories as needed.
Envelopes and receipts remain outside source checkouts and source commits.

### Standardized Slim Prompt Standard (~15 lines)

When dispatching a `skill` provider, the Orchestrator sends a concise, standardized prompt (~15 lines).
The subagent reads its full task context directly from `<step_index>-input.json`, eliminating prompt drift:

```markdown
You are the specialist agent executing stage: `<logical_stage>`.
Task Input Envelope: `<receipt_root>/<step_index>-input.json`

Instructions:
1. Read the Task Input Envelope at the path above to obtain your full task context, inputs, predecessor receipts, environment, and contract requirements.
2. Bind your execution to `environment.working_directory` and follow the specialized instructions in the installed `<skill_name>` skill’s `SKILL.md`.
3. Complete the assigned objective adhering to `inputs.acceptance_criteria`.
4. Write your full durable Markdown receipt to `contract.receipt_path` matching `contract.receipt_template`.
5. Return ONLY the standard compact JSON execution report:
```json
{
  "execution_status": "succeeded" | "blocked" | "failed",
  "result": { "outcome": "<domain_outcome>", ... },
  "receipt_path": "<assigned_receipt_path>",
  "summary": "<one_sentence_summary>"
}
```
```

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
- Submit the report defect via the lifecycle kernel helper (`packages/orchestrator/src/cli.ts complete`), which records the protocol error against the active dispatch. Never edit `state.json` directly.
- Halt immediately and present the Blocker Decision Board to the user with the observed defect and last confirmed state.
- Do not dispatch speculative repair agents to guess missing conclusions.

---

## Workflow Execution

The Orchestrator coordinates execution by reading a workflow definition and advancing through
its stages as a state machine. It contains no hardcoded stage logic; domain delivery sequences
are fully decoupled into modular workflow files.

Resolve `<skill-dir>` to the real absolute directory containing this `SKILL.md` (follow installation symlinks),
`<paper-craft-root>` to its checkout root two levels above, and `<config-skill-dir>` to the installed
`pc-workspace-config` directory. Run `pnpm install` in that checkout once to provide the TypeScript helpers.
The helper commands below use that checkout explicitly and work from any task working directory.

### 1. Workflow Loading & Completion Policy
- **Default workflow**: Load `<skill-dir>/workflows/default.json` (the standard issue delivery workflow).
- **Custom workflow override**: If the user specifies an alternative workflow path in their prompt or configuration, load and follow that workflow definition instead. Unknown workflows fail fast with an error; fallback to default is not permitted.
- **Completion Policy**: Workflow definitions explicitly declare `completion_policy`:
  - `"issue_delivery"`: Enforces issue-tree delivery completion checks (landing all planned child issues, verifying parent integrated acceptance, issue-tree finalization, and workspace cleanup with zero retained targets before `finish` can succeed).
  - `"basic"`: Standard completion policy for simple workflows without issue-tree delivery constraints.

### 2. Workflow Entry & Configuration Gate
Before creating task worktrees or initializing workflow runtime state:
1. **Workspace Configuration Check**: Verify that `.paper-craft/workspace-config.json` exists and is valid (run `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/workspace-config/src/cli.ts" validate --repo-dir <repo_dir>`).
2. **Missing / Invalid Configuration Handling**: If the configuration is missing or invalid, halt immediately to the Decision Board. Clearly explain the missing configuration and guide the user to run `pc-workspace-config`. Do NOT dispatch task worktrees on the error path.

### 3. Execution Loop
For each stage defined in the loaded workflow:
1. **Identify Stage Contract & Resolve Provider**: Read the stage's `logical_stage`, `provider` (`type: "skill"`, `target`, `args`), inputs, environment source, expected revision, predecessor receipts, expected `result`, and routing rules.
2. **Prepare Environment**: Apply [Workspace lifecycle and dispatch](references/workspaces.md), verifying or creating the assigned workspace before professional execution.
3. **Dispatch and Launch**:
   - Write the [dispatch request](#dispatch-request) with a JSON serializer, then run the [`dispatch` operation](#lifecycle-operations).
   - Launch one fresh specialist subagent only from a response with `"launch_granted": true`. Use the returned provider and paths with the [Standardized Slim Prompt](#standardized-slim-prompt-standard-15-lines).
   - If the response is lost or grants no launch, follow [Dispatch recovery](#dispatch-recovery).
4. **Complete Dispatch & Verify Receipt**:
   - Execute `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" complete --receipt-root "<receipt_root>" --dispatch-id "<dispatch_id>" --report '<compact_json_report>'`.
   - The kernel validates report integrity (the 4 required fields), tags completion with the active dispatch's `issue_id`, and physically verifies that the assigned receipt file exists on disk and is non-empty (`st_size > 0`). If malformed, missing, or empty, halt to the Decision Board.
   - Completing a task preserves any existing pause decision (`halt`/`wait_user`). If execution outcome is unknown or in flight, verify against original execution rather than guessing or restarting.
5. **Evaluate Routing & Resolve Decision**:
   - Match the returned native `result` against the stage's routing table.
   - Execute `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" resolve --receipt-root "<receipt_root>" --decision <continue|wait_user|halt|finish> --reason "<reason>" [--next-stage <stage>] [--plan-dispatch-id <dispatch_id>] [--mark-landed <id> --landing-dispatch-id <dispatch_id>]`.
   - Orchestrator explicitly selects the next stage (via `--next-stage <stage>`) or records steering decisions; arbitrary stage names are rejected as `--decision`. `complete` solely records receipt verification and never auto-advances stages.
   - **Plan Acceptance Rule**:
     - The Orchestrator accepts a completed planning result via `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" resolve --receipt-root "<receipt_root>" --decision continue --plan-dispatch-id <id> --next-stage <stage> --reason "<reason>"`. It references an existing succeeded completion record for `issue_plan` by its `dispatch_id`. Passing file paths, raw JSON, or the removed `--plan`/`--child-issue` parameters is rejected.
     - A `direct` planning result initializes a single-item delivery sequence containing `root_issue_id`. A `decomposed` planning result validates task dependencies and constructs the ordered sequence of child issues. In both cases, the first issue in the sequence becomes `current_issue_id`, and `current_stage` transitions to `next_stage`.
     - **Idempotency & Replay**: Repeating the acceptance request with the identical `plan_dispatch_id` returns the previously accepted `DecisionRecord`. Current runtime state should always be queried via `inspect`. Replaying an acceptance request does not alter control status, does not unpause a subsequent halt/wait_user, and does not rewind stages.
     - **Structural Replanning Boundary**: Structural replanning (modifying, adding, or deleting child tasks in an existing sequence) is outside this initial plan acceptance protocol and cannot overwrite an established delivery sequence via `plan_dispatch_id`. In-place implementation strategy adjustments route via regular `resolve`.
   - **Landed Evidence Rule**: `--mark-landed <issue_id>` and `--landing-dispatch-id <dispatch_id>` must be provided together. The referenced dispatch must be a succeeded completion record whose stage/provider target matches `pc-pr-land` and whose result satisfies `{ outcome: "landed", merged: true, mergedCommit: "<sha>" }`.
   - **Sequence Completion Rule**: `--complete-sequence` requires a delivery sequence where every item is landed with valid landing dispatch evidence.
   - For linear progression, advance to the indicated successor stage.
   - For rework, route to the designated repair role with predecessor findings, tracking consumed retry budgets.
   - For human steering gates defined by the workflow (such as refactoring plan approval or planning decisions), halt and present the Decision Board to the user with the specialist's options summary before proceeding.
   - For scope reassessment, execute the workflow's replanning procedure within allowed replan budgets.
   - For `blocked`, `failed`, or exhausted retry budgets, invoke the [Halt & Escalation Protocol](#halt--escalation-protocol).
6. **Completion Gate**: After the workflow's required professional gates succeed, finalize issue closure and reconcile the full issue-tree resource inventory, then dispatch workspace cleanup. Require a successful tree finalization receipt and cleanup with no retained targets before `resolve --decision finish`. Retained targets mean delivery complete / cleanup incomplete; retry only outstanding finalization work. `finish` is terminal: a finished workflow cannot be reopened via `continue`.

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

- **Structured State Snapshot (`state.json`)** — The authoritative runtime state machine snapshot on disk. The Orchestrator interacts with this state exclusively via the lifecycle kernel helpers, never modifying `state.json` directly:
  ```json
  {
    "schema_version": "1.0",
    "root_issue_id": "<root_issue_id>",
    "current_issue_id": "<current_issue_id>",
    "workflow": "default",
    "current_stage": "<current_stage_name>",
    "stage_status": "pending",
    "next_step_index": 2,
    "active_dispatch": null,
    "completed_stages": [
      {
        "dispatch_id": "<step_index>-<stage>-issue-<id>-try-<attempt>",
        "step_index": 1,
        "stage": "<stage_name>",
        "attempt": 1,
        "issue_id": "<current_issue_id>",
        "execution_status": "succeeded",
        "result": { "outcome": "<domain_outcome>" },
        "receipt_path": "<assigned_absolute_receipt_path>",
        "summary": "<summary>",
        "completed_at": "<iso_timestamp>"
      }
    ],
    "decisions": [
      {
        "decision": "continue",
        "reason": "<reason>",
        "options": [],
        "timestamp": "<iso_timestamp>"
      }
    ],
    "budgets": {
      "delivery_attempts_used": 1,
      "delivery_attempts_max": 3,
      "replans_used": 0,
      "replans_max": 2
    },
    "context": {},
    "last_updated": "<iso_timestamp>"
  }
  ```

### Lifecycle Operations

The lifecycle kernel (`packages/orchestrator/src/cli.ts`) provides five operations:

  - **`init`**: `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" init --receipt-root "<receipt_root>" --root-issue <root_id> [--repo-dir <repo_dir>] [--require-config] [--force]`
    Creates workflow run state in `<receipt_root>/state.json` or resumes an existing run. Validates workspace configuration and populates root context. `init` is strictly narrowed to run initialization and resumption; shortcut plan parameters (`--plan`, `--child-issue`, `--current-issue`, `--initial-stage`) are removed and rejected.
  - **`dispatch`**: `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" dispatch --receipt-root "<absolute_receipt_root>" --request "<absolute_request_path>"`
    Allocates the step index and updates attempt budgets in one commit with the envelope and `handed_off` state. Returns `dispatch_id`, `status`, resolved `provider`, `envelope_path`, `receipt_path`, and `launch_granted`. The skill performs the platform launch.
  - **`complete`**: `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" complete --receipt-root "<receipt_root>" --dispatch-id <id> --report '<compact_json|report_path>'`
    Registers compact execution report (validating `execution_status`, `result`, `receipt_path`, `summary`) and verifies physical non-empty receipt existence on disk.
  - **`resolve`**: `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" resolve --receipt-root "<receipt_root>" --decision <wait_user|continue|halt|finish> --reason "<reason>" [--option "<option>"] [--next-stage <stage>] [--plan-dispatch-id <id>] [--current-issue <id>] [--mark-landed <id> --landing-dispatch-id <id>] [--complete-sequence]`
    Records orchestrator steering decisions. Execution facts (`completed_stages`) and orchestrator decisions (`decisions`) are stored separately. Decisions are strictly constrained to `wait_user`, `continue`, `halt`, or `finish`; transitions to a named stage must use `--decision continue --next-stage <stage>`. Plan acceptance requires `--decision continue --plan-dispatch-id <id> --next-stage <stage> --reason "<reason>"`, which references the recorded planning dispatch, constructs the delivery sequence, and behaves idempotently on repeated submissions without mutating active runtime state. Deprecated `--plan` and `--child-issue` parameters are removed and rejected. `--mark-landed` and `--landing-dispatch-id` must be passed together and reference valid landing evidence from completed stages.
  - **`inspect`**: `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/cli.ts" inspect --receipt-root "<receipt_root>" [--json] [--field <path>]`
    Queries current state, active dispatch, orchestrator decisions, budgets, and reasons blocking progression.

### Runtime References

- **Task Input Envelope Helper (`packages/orchestrator/src/envelope-cli.ts`)** — Low-level validation and inspection:
  - Validate: `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/envelope-cli.ts" validate "<receipt_root>/<step>-input.json"`
  - Inspect: `node --import "<paper-craft-root>/node_modules/tsx/dist/loader.mjs" "<paper-craft-root>/packages/orchestrator/src/envelope-cli.ts" show "<receipt_root>/<step>-input.json" [--json]`
- **Durable File Receipts** — Specialist agents write their evidence, logs, and verification outputs to their assigned `<step_index>-<task_name>-issue-<current_issue_id>-try-<attempt>.md` file using [the receipt template](templates/subagent-receipt.template.md). Receipts remain outside source checkouts.
- **Resumption ($O(1)$)** — To resume an interrupted workflow, the Orchestrator inspects workflow state via `packages/orchestrator/src/cli.ts inspect`:
  1. If valid state exists, restore in-memory tracking from its fields and resume from `current_stage` using recorded receipt references, active dispatch status, and consumed budgets.
  2. If state is missing or corrupted, halt to the Decision Board for human steering rather than guessing past states.
- **External Dashboard**: A dashboard script may observe transcripts for human visibility; the Orchestrator does not query or depend on the dashboard.

### Dispatch Request

Write a JSON object to an absolute file path using a JSON serializer. Required fields are non-empty strings `request_id`, `stage`, and `objective`. Assign a unique `request_id` within the run for each intended launch and retain the original request for retries. Static stage configuration (fixed skill provider target, instructions/templates, configs) is extracted directly from the workflow snapshot, but an explicit `provider` (with `type: "skill"` and non-empty `target`) may be passed.

```json
{
  "request_id": "<unique-request-id>",
  "stage": "workspace_prepare",
  "objective": "Prepare the assigned workspace",
  "provider": {
    "type": "skill",
    "target": "pc-workspace",
    "args": []
  }
}
```

Optional string arrays `provider.args`, `acceptance_criteria`, and `predecessor_receipts` default to empty lists. Each provider argument occupies one array element and retains its exact contents. Predecessor receipts must be explicitly specified; an empty predecessor list remains empty (`[]`). Explicitly referenced predecessor receipts must exist on disk and be non-empty. Optional `scope` is a string defaulting to `""`. Optional `workdir`, `branch`, `commit`, and `receipt_template` are non-empty strings, with workspace fields inherited from runtime context and the bundled receipt template used by default. `attempt_intent` accepts `same` (default) or `new`. Optional `rework_issue` designates an existing issue ID for targeted rework after parent acceptance or during delivery. Pass all task parameters in the JSON request. Unknown fields and invalid values fail request validation. The kernel supplies issue context and allocates the step index, attempts, budgets and output paths.

### Dispatch Recovery

Serialize calls that operate on the same run. The kernel checks request history before checking whether a new dispatch can proceed. Reusing the same `request_id` and original payload returns the existing dispatch with `launch_granted: false`, including the completion record if completed. Changing the payload under the same ID is rejected. An `init --force` reset starts a new run with fresh request history.

If a response is lost, use `inspect` or replay the original request and check the original platform execution. If completion is already recorded, use it to resume routing. Otherwise, use a verified report to complete the original dispatch, or escalate if the execution cannot be verified. A new request ID cannot recover an earlier launch grant. A pause (`halt` or `wait_user`) blocks new grants until `resolve --decision continue`. Previously granted dispatches can still execute and complete.

If an older run has a pending `prepared` dispatch, finish it with the old checkout. Start with a new receipt root only after verifying that the old dispatch was never launched.
