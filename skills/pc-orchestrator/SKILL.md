---
name: pc-orchestrator
description: Schedule Issue delivery through configured role contracts and workflow steps, reconcile interrupted work, and report verified completion.
---

# /pc-orchestrator

The Orchestrator supplies scoped assignments and coordinates execution. The Engine
owns state transitions, result validation, execution ownership and resource release.
Specialists own their implementation and professional judgments.

## Role contracts

Use the Run's captured `role_definitions` and `workflow_definition` as authority.
They define each step's responsibility (`guidance`), assigned role, skill, permitted
outcomes, required artifacts and input artifacts. Resolve these from the supplied
Run context; for intake, read the authoritative config and its referenced definitions.
Keep the captured definitions for an existing Run rather than substituting later config edits.

Dispatch the current step through one interface:

```bash
pc workflow dispatch <run-id> --instructions-file <assignment-file>
```

The assignment states the objective, scope, acceptance criteria and relevant prior
findings. Preserve immutable shared requirements. The Engine selects the current
role, binds its skill and inputs, supplies its workspace, and assembles the full task prompt—injecting
the runtime identity (run/task ID), permitted outcomes, required artifacts, and the exact
`pc workflow submit-result` command. The top-level dispatch agent executes the skill procedure
and returns the receipt upon task completion or blockage. The Orchestrator need not load specialist
procedures or prescribe how to perform their work.

The returned task identity identifies the execution to observe. Specialists return
`outcome`, `summary` and required `artifacts` through `pc workflow submit-result` as directed
by the injected prompt contract. Only Engine-acknowledged results and recorded transitions authorize
subsequent work; chat replies and process exit alone do not establish completion.

Use the current scheduling context when supplied by the Engine. From the CLI,
inspect `pc workflow status <run-id>` for the recorded step, Run status and latest
task result. Refresh this view after dispatch, a result, or recovery.

**Done:** Every assignment targets the Engine's current step and configured role,
with its scope and required evidence identified.

## Workflow

### 1. Resolve or start the Run

Resolve the issue, repository, config and authorized scope. Read the issue's
acceptance criteria, parent context and open dependencies. A child request covers
only that child; unresolved prerequisites block dispatch.

For an assigned Run, verify its identity and use its supplied context. Follow any
assignment-specific initialization instructions before scheduling; invalid context
is an error, not permission to start a replacement Run.

For a new Run, initialize configuration only when absent, then start:

```bash
pc workflow init --repo <owner/repo>
pc workflow start <issue> --provider agy --config <config>
```

Pass additional constraints with either `--requirements <text>` or
`--requirements-file <file>`. Retain the returned Run identity and definitions.
If an unfinished Run already owns this issue, inspect and resume that Run.

**Done:** One identified Run owns the authorized scope and its requirements.

### 2. Shared Issue Delivery

Follow the Run's workflow definition, beginning at its recorded current step.
The default sequence is implementation → review → merge → finalization; configured
transitions determine the actual sequence, including rework and blocked outcomes.

1. Inspect status and resolve prerequisites before allocation. Existing in-flight
   or uncertain execution must be reconciled before another dispatch.
2. Compose and dispatch the current role's assignment through the common interface.
3. Observe its structured result and refresh status. For a recorded rework
   transition, carry the review findings and evaluated revision into the repair
   assignment while preserving the original scope.
4. Dispatch the next step only after the Engine records that transition. A failed
   gate, paused Run or exhausted rework budget requires resolving the reported
   blocker rather than choosing a substitute step or resetting the budget.

Planning, decomposition and integrated acceptance may be scheduled only when the
Run's definitions and available interfaces support them. Missing roles or steps
are a workflow limitation to report, not permission to invent a dispatch API or
start sibling deliveries outside the authorized scope.

**Done:** The Engine records completion with required delivery and release evidence.
A merged PR alone does not complete delivery.

### 3. Recover, stop or release

```bash
pc workflow status <run-id>
pc workflow resume <run-id>
pc workflow stop <run-id> --reason <reason>
pc workflow release <run-id>
```

Use `resume` to reconcile interrupted execution and results before continuing from
the recorded step. Unknown execution remains occupied; elapsed time does not
justify a replacement or repeating an external action.

Use `stop` when halting work. Use `release` to finish or retry eligible resource
release after finalization. Follow returned blockers through these interfaces;
leave ownership checks, preservation and cleanup to the Engine and assigned role.

Report the actual Run status, accepted outcome, remaining blockers and resource
release status. Retain the Run identity for inspection and recovery.

**Done:** Completion and release are verified, or outstanding work is explicitly
reported with its recorded blocker and next recovery action.
