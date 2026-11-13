# paper-craft Design Decisions

[简体中文](DESIGN.zh.md)

Technical architecture decisions for paper-craft. These choices anchor the entire system—changing them carries broad consequences.

## Modular Design

Modules follow these principles:

- **Orthogonality and low coupling**: Minimize inter-module dependencies and keep responsibilities strictly orthogonal, preventing intertwined webs of coupling even when interfaces are small, and strictly containing the blast radius of changes.
- **Deep modules and high leverage**: Expose minimal interface surface area (seams) while encapsulating complex implementation and state internally, providing high leverage for callers, ensuring locality for maintainers, and eliminating pass-through layers.

## Skill and execution boundaries

The architecture separates professional task knowledge from workflow policy.

- **Skill**: teaches how to complete a coherent professional task. Specialist skills know neither workflows nor the orchestrator and require no dispatch CLI. Genuine dependencies on other skills are permitted; dispatch-specific modes and workflow routing logic are not. Specialist skills focus on professional collaboration without introducing a separate skill for every operation.
- **Orchestrator**: owns ordering, executor selection, result associations, failure branches and overall completion. It understands failure reasons to choose subsequent work but does not manually copy findings or assemble input fields.

Every skill dispatch starts a new agent conversation, including repeated roles and repair attempts. Context travels through explicit inputs rather than conversation reuse. Professional agents own domain judgments. The Orchestrator owns routing and acceptance. A successfully executed review can conclude that changes are required, and a successful scope assessment can identify work outside its authorization. Detailed evidence stays in file receipts.

The skills enforce contracts through internal scripts and agent instructions. These scripts are skill implementation details; invoking them remains skill execution. Programmatic verification and state machine enforcement guard every dispatch and receipt. Operational limits, report repair, scope reassessment, and recovery procedures belong in the orchestrator skill.

## Stage and skill decoupling

Every workflow stage is executed by a skill. A stage identifies the professional role to dispatch without embedding its implementation:

```json
{
  "provider": { "type": "skill", "target": "<skill-name>", "args": [] }
}
```

The Orchestrator starts a fresh specialist agent through the platform adapter, loading `skills/<target>/SKILL.md` with the task input envelope. Fixed helper operations remain part of skill execution. Their location under `packages/` does not introduce another execution provider.

## Configuration and structured data

Project-defined configuration, workflow definitions, state snapshots, task inputs, and compact execution reports use JSON. Use JSONL only for append-only event or log records, with one complete JSON value per line. JSONL is not a configuration format. Existing project-defined YAML is migrated to JSON; do not introduce YAML for these files. Formats required by external tools, including package-manager files, platform skill metadata, and downstream Snakemake or Conda files, follow those tools' contracts. Markdown instructions and durable receipts remain Markdown.

## Task input envelope

Context passing is fully structured and file-based. The Orchestrator never concatenates large, unstructured free-text prompts across stages. Before dispatching any provider, the Orchestrator materializes the complete execution context as an immutable JSON file at `<receipt_root>/<step_index>-input.json`.

The Task Input Envelope adheres to a standardized 7-block schema (`schema_version: "1.0"`):

```json
{
  "schema_version": "1.0",
  "task": { "logical_stage": "...", "step_index": 0, "attempt": 1, "root_issue_id": "...", "current_issue_id": "..." },
  "provider": { "type": "skill", "target": "...", "args": [] },
  "environment": { "working_directory": "...", "repository": "...", "base_branch": "...", "branch": "...", "commit": "..." },
  "inputs": { "objective": "...", "scope": "...", "acceptance_criteria": [], "predecessor_receipts": [], "parameters": {} },
  "contract": { "receipt_path": "...", "receipt_template": "..." },
  "budgets": { "delivery_attempts_used": 0, "delivery_attempts_max": 3, "replans_used": 0, "replans_max": 2 }
}
```

This protocol establishes two operational invariants:

- **Standardized slim prompt standard (~15 lines)**: When dispatching LLM subagents, the prompt contains only the assigned stage name, the absolute envelope path, directory binding instructions, and the compact JSON return requirement. Domain context, acceptance criteria, predecessor receipts, and budget limits are read directly from the envelope file, eliminating prompt drift.
- **Atomic write and isolation**: Envelopes and state files are written atomically using temporary files, buffer flush, fsync, and atomic replace within `<receipt_root>`. `<receipt_root>` resides outside disposable git worktrees to prevent accidental deletion during branch switches or worktree pruning.

## Deterministic steps within skills

Skill instructions guide agent judgment, routing, and recovery. Fixed helpers perform mechanical work and validate external JSON at runtime; TypeScript types alone do not validate files or agent output.

- **Orchestrator helpers (`packages/orchestrator/`)**: Structured into three cohesive modules and thin CLI entry points:
  - **Lifecycle**: owns dispatch identity, authorization, report correlation, envelope protocols, idempotency, and operation orchestration across `init`, `dispatch`, `complete`, `resolve`, and `inspect`. `init` is strictly narrowed to run creation and resumption with shortcut plan inputs removed; `resolve` accepts planning results by referencing recorded completions via `plan_dispatch_id`, enforcing request identity, freshness, and idempotent replay.
  - **Workflow**: owns domain delivery sequence construction, stage definition loading and validation, completion policies, retry/replan budgets, and evidence checks. When accepting plans, it internally validates order and constructs direct or decomposed delivery sequences, keeping planning helpers as internal unexported implementations without mutating caller inputs.
  - **RunStore**: owns run directory file layout, atomic commits (state and envelopes), and crash recovery via pending commit records.
  - **CLI (`cli.ts`, `envelope-cli.ts`)**: handles command arguments, input media, and terminal formatting without embedding workflow policies or direct file mutation.
- **Configuration helpers (`packages/workspace-config/`)**: TypeScript modules resolve and validate the project configuration used by the orchestrator.
- **Specialist helpers (`skills/<skill>/scripts/`)**: Existing professional-task helpers can remain alongside their skill, including Python scripts. Moving orchestrator code does not require rewriting every skill.

A new `dispatch` commits the input envelope, attempt accounting, and `handed_off` state together, granting the skill one platform launch. Callers serialize operations on the same run. Each JSON request has a `request_id` unique within the run. `init --force` only replaces an unused run directory (including corrupt initialization state with no dispatch artifacts); once work has been dispatched, a new run must use a new receipt root. Explicit-root `init` restores directly from the saved snapshot and `workflow_locator` without re-reading external workflow files or project configuration. The kernel checks request history before admitting new work. A replay of the original payload returns the existing dispatch or its completion (even while a later dispatch is active) without granting another launch. A different payload under the same ID is rejected. Pausing blocks new grants while existing grants and completions remain valid. `inspect` stays business-observational while still finishing any interrupted storage pending commit.

The skill owns the external stage input and receipt contract. Helper modules implement deterministic operations without choosing the next professional stage; the Orchestrator makes that decision explicitly through `resolve`. `init` strictly creates or resumes runs, rejecting shortcut plan inputs. Plan acceptance is explicitly routed through `resolve` via `plan_dispatch_id`: Lifecycle manages request identity, freshness, and idempotent replay (replays return historic decision records without mutating control states or rolling back stages), while Workflow internally validates dependencies and constructs direct or decomposed sequences without exporting planning helpers. Preserve lifecycle operation semantics, persisted JSON formats, recovery, and receipt checks when changing implementations.

## Unified receipt contract

Every execution provider concludes by fulfilling the Unified Receipt Contract across two mandatory channels:

```json
{
  "execution_status": "succeeded",
  "result": { "outcome": "verified" },
  "receipt_path": "/path/to/receipt.md",
  "summary": "Execution completed successfully"
}
```

The contract enforces dual reporting:

- **Compact execution report**: A machine-parseable JSON object returned by the skill agent. `execution_status` is strictly constrained to `"succeeded"`, `"blocked"`, or `"failed"`. Valid professional conclusions (including rework findings or `out_of_scope`) report `"succeeded"`, reserving `"blocked"` for unmet prerequisites and `"failed"` for unrecoverable crashes. The `result` object contains domain-specific routing outcomes.
- **Durable disk receipt (Markdown)**: A comprehensive Markdown audit record written to `contract.receipt_path` conforming to `subagent-receipt.template.md`. It records complete verification logs, git revisions, modified artifacts, and predecessor receipt links outside disposable checkouts.

The Orchestrator validates all four report fields and verifies physical existence of the receipt file. Any protocol violation, unparseable output, or missing receipt triggers fail-fast halting to the Decision Board without speculative repair.

## Workspace ownership

The orchestrator assigns environments and decides preparation, reuse, and cleanup timing.
`packages/workspace` provides the core TypeScript implementation (`prepare`, `cleanup`) and CLI,
while `packages/workspace-config` provides unified configuration resolution and validation.
The `pc-workspace` specialist skill serves as the cognitive wrapper preparing and validating Git checkouts
before professional tasks start, while domain-specific skills retain their own focused helpers (including Python where appropriate).
Every dispatch, including nested agents, supplies an absolute working directory and relevant repository,
branch, and revision. Platforms bind the launch directory where supported. Prompt-only adapters require
explicit per-command directory binding and entry validation. Professional skills consume prepared
workspaces and own their project dependency, compute, and data checks.

Implementation, review, and pre-merge repairs share their feature worktree. Integrated acceptance uses
an isolated checkout pinned to the integrated commit. Post-merge repairs and pipeline modifications
use fresh feature worktrees. Research state has one fixed shared home, and retained artifacts have
explicit durable locations. After successful completion, the workspace specialist cleans up eligible
workspaces created for that run and records retained paths and reasons. Interrupted or failed work keeps
its environments. Runtime state preserves assignments, preparation receipts, ownership, and cleanup results.

## Workflow decoupling

Specific execution sequences (such as issue delivery, hotfixes, or refactoring) live in JSON workflow files under `skills/pc-orchestrator/workflows/`. The Orchestrator owns workflow policy and routing. TypeScript helpers implement fixed lifecycle operations; workflow definitions and receipt templates remain skill resources. Resolve resources from the installed skill's real checkout so calls work through installation symlinks and from other working directories.

RuntimeState follows schema_version `1.1`. Lifecycle coordinates execution authorization, active dispatch tracking, report correlation, and atomic storage commits, while Workflow centrally evaluates stage semantics, task parameters, per-issue delivery/replan budgets, landing evidence freshness, and completion policy assertions. Legacy 1.0 runs remain read-only under inspect and reject writes or restoration.
