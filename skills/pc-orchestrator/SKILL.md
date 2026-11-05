---
name: pc-orchestrator
description: Coordinate Issue delivery or composite child deliveries through managed agents, verified acceptance, and resource release.
---

# /pc-orchestrator

The Run's active managed Orchestrator attempt schedules persistent work; durable files retain decisions and execution evidence.
Issue delivery is the shared workflow below; planning coordination adds triage, decomposition, and integrated acceptance around it.

## Branch selection

For an explicit managed Run/Attempt assignment, read [the shared execution contract](managed-lifecycle.md), its selected provider procedure, and the supplied immutable context. Validate every initialization field and context hash. Invalid or incomplete managed context stops with an error; it never enters Launcher intake. Write assignment-bound initialization and native readiness, then end that turn. The startup helper sends a separate activation message after verifying this exact Attempt. On that message, verify the Run and authority before using Shared Issue Delivery. **Done:** committed activation and continuation input are verified.

Without managed context, use Intake as Launcher. Report the actual startup and activation status, including pending background recovery, and end this invocation; the independent Orchestrator schedules delivery. **Done:** report actual Run/Attempt state and available inspection commands.

## Intake

Require a target issue number.
Resolve the repository from the authoritative Fleet config and collect or reuse `provider` (`agy`), config path, and additional scope requirements.

```text
Issue: #79
Provider: agy
Config: /absolute/path/.epic-config.json
Requirements: Keep changes within the requested scope
```

Read the GitHub issue, native parent/dependency metadata, and native sub-Issues before starting.
- **Sub-issue intake (Depth = 1):** If the Issue is identified as a child/sub-issue of an existing parent (via native parent metadata or body reference), skip decomposition planning entirely and proceed directly to atomic Worker execution.
- **Root Issue intake:** Dispatch the initial planning stage via `pc-issue-plan` (`role: 'planner'`, `stage: 'planning'`) to determine whether the Issue can be delivered directly in a single iteration or must be decomposed into sub-issues.

```bash
pc workflow init --repo owner/repo
pc workflow start 79 --provider agy --config /absolute/path/.pc-workflow.yml
pc workflow status --config /absolute/path/.pc-workflow.yml
pc workflow resume <run-id>
```

Resume recovers an interrupted Run explicitly without background daemons:
- Progress is reconstructed solely from durable `events.jsonl` (never a secondary current-step file).
- Inspects the provider by stable `taskId` even when an interruption occurred before handle recording (`task_launched`), reconnecting to running processes or collecting durable results.
- Represents unreconciled execution as uncertainty (`status: uncertain`); never assumes an unknown execution was not started or blindly launches a replacement.
- Preserves worktree ownership safeguards (`.pc-execution-owner`) and restores `SchedulingContext` for orchestrator scheduling.

Supply additional Requirements with `--requirements <text>` or `--requirements-file <file>` (UTF-8), never both. File contents are captured at intake, so later work does not depend on the source file. Requirements become immutable Run context inherited by every role, retry, and replacement; child-specific assignments add scope without replacing those constraints. Repeated start may omit Requirements to reuse them or supply identical text; different text rejects. For Demo rounds, pass `--demo-round <id>` and `--demo-config <file>` (or bind via the generated workflow config) to apply minimal immutable demo run constraints. Retain the returned Run identity.
Follow independent startup in [agy procedure](agy-interactive.md).

For decomposed parent issues, also read [Planning & child coordination](planning-workflow.md) before child dispatch or integrated acceptance.

The startup, provider, and ownership gates in the execution contract determine whether dispatch is available.

**Done:** Repository/number, authorized scope, provider, config, and owning Run are resolved, and persisted assignment context includes every additional requirement.

## Shared Issue Delivery

Apply these steps to standalone Issues, decomposed child Issues, and finalization maintenance Issues.
For child Issues, retain the parent's scope, dependency, and professional acceptance context; the parent Run remains the scheduler and these steps do not create a new Run per child.

### 1. Establish readiness

Read the Issue's acceptance criteria and current implementation state, open dependencies, and checkout ownership.
Use [child-only intake and overlapping Runs](managed-lifecycle.md#child-only-intake-and-overlapping-runs) to reconnect or reference existing delivery.
For decomposed children, the [child scheduling rules](planning-workflow.md#child-scheduling) additionally determine readiness.

**Done:** Every prerequisite is resolved, the delivery has one owner, and the immutable assignment identifies its scope and acceptance evidence.

### 2. Implement and assess

The Orchestrator receives the workflow, role contract, and current scheduling context automatically from the Engine (`WorkflowEngine.getSchedulingContext`).
Dispatch the Worker by providing task instructions; the Engine binds Run identity, step, role, provider, inputs, and the dedicated worktree workspace:

```bash
pc workflow dispatch <run-id> --instructions "Implement requested changes adhering to acceptance criteria"
```

The Engine persists dispatch intent before launching the specialist role via `AgyExecutor`, records the provider execution handle, and prepares the worktree with `.pc-execution-owner` and `initialization.json`.

Specialist roles submit their structured result via the `submit-result` contract:

```bash
pc workflow submit-result --run <run-id> --task <task-id> --outcome completed --summary "Implemented changes" --artifacts '{"diff":"...","test_results":"..."}'
```

The Engine validates ownership, permitted outcomes, and required artifacts before acknowledging the result, verifies execution termination, and records the collected implementation outcome.
Chat text or normal process exit alone does not complete a business step.
Use `/pc-issue-lead` for an independent stopping-point assessment and `/pc-pr-check` plus `/pc-pr-review` for PR readiness and quality.
Record a reason and evidence for any stage that does not apply; missing implementation or review evidence is not completion.

**Done:** The scoped implementation is accepted with validation tied to its revision, or the evidence establishes that no implementation is required.

### 3. Review and land

The Engine automatically transitions from `implementation` to `review` upon receiving a `completed` worker result.
The Orchestrator queries `getSchedulingContext` and dispatches the Reviewer role via `pc workflow dispatch <run-id> --instructions "..."`.
The Reviewer evaluates the implementation against acceptance criteria and submits either `pass` (transitioning to `merge`), `rework` (transitioning back to `implementation`), or `blocked`:

```bash
pc workflow submit-result --run <run-id> --task <task-id> --outcome rework --summary "Found defects" --artifacts '{"reviewed_commit":"<sha>","findings":"<details>"}'
```

On `rework`, the Engine checks the rework count against `rework_limit` (default: 3 rounds). If under the limit, the Engine increments `rework_count`, transitions back to `implementation`, and carries forward `priorEvidence` (the evaluated commit SHA and review findings). The Orchestrator receives this prior evidence via `WorkflowEngine.getSchedulingContext`, composes focused repair instructions, and dispatches a fresh worker task with unchanged public requirements.
If the rework limit is exhausted, the Engine transitions the Run to `paused` with preserved records and artifacts, preventing endless rework loops.

For a PR approved on `pass`, the Engine transitions to `merge` and retains the evaluated revision. Dispatch managed quality and PR-Land work through [current-head PR merge](managed-lifecycle.md#current-head-pr-merge).
Resolve defects and obtain current quality evidence plus any required parent professional confirmation before requesting merge.
When the head changes, reassess the changed revision through that protocol.

**Done:** GitHub merge and its evaluated revision are verified, or an evidence-backed no-PR disposition is retained.

### 4. Record, preserve and release

For merged work, follow [post-merge delivery](managed-lifecycle.md#post-merge-delivery) for Worker final records, preservation, and PR-Land cleanup.
For work without a PR, retain the accepted outcome and follow the managed release contract for every reserved execution and checkout.

**Done:** Accepted scope, validation, final records, and follow-up attribution are retained; required archive/bundle evidence and actual resource release are verified.
A merged PR alone does not complete delivery.
Standalone delivery ends here; a decomposed child returns its evidence to [integrated acceptance](planning-workflow.md#integrated-acceptance-and-closure).

## Failure and resume

Read the persisted Run and inspect status before scheduling after a reconnect. Follow the [shared output and Evidence rules](managed-lifecycle.md) when querying or expanding status.
Use [managed recovery](managed-lifecycle.md) for receipt reconciliation, bounded rework, termination verification, and ownership release.

```bash
pc workflow orchestrator recover <run-id> --config /absolute/path/.epic-config.json
pc workflow orchestrator stop <run-id> --config /absolute/path/.epic-config.json
pc workflow orchestrator release <run-id> --config /absolute/path/.epic-config.json
```

Use `stop` to revoke further scheduling authority, cancel owned executions and helpers, and verify termination without altering completed business deliverables.
Use `release` on a completed Run to terminate remaining executions/helpers and release resources through verified preservation and cleanup prerequisites.

**Done:** Every reported result has an acceptance/rework disposition, and unresolved execution or ownership uncertainty remains a recorded blocker to dependent work.

## Task roles

Dispatch tasks through the owning Orchestrator's [managed lifecycle](managed-lifecycle.md).
Assign one of the workflow roles according to its responsibility; task specialization belongs in the brief.
