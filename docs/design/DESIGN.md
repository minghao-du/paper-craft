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

## Stage-provider decoupling

Workflow stages decouple abstract logical tasks from concrete execution providers. The workflow state machine tracks task progress, state transitions, and receipt validation without hardcoding how a stage is executed. Each stage declares a polymorphic provider specification:

```yaml
provider:
  type: "skill" | "engine"
  target: "<skill-name> | <engine-operation>"
  args: []
```

The target architecture includes two provider types. The independent paper-craft engine is not yet implemented; the engine pathway and configuration below describe the design, not an existing capability:

- **`skill` provider**: The Orchestrator dispatches an autonomous LLM Specialist Subagent via the platform adapter, loading `skills/<target>/SKILL.md` with a standardized slim prompt referencing the task input envelope.
- **`engine` provider**: The Orchestrator invokes deterministic operations through an independent paper-craft engine without starting a specialist agent. `target` identifies an engine operation, not a script path. Engine code lives outside `skills/`; this pathway does not directly invoke skill-internal scripts.

A workflow can mix skill and engine calls. Both providers follow the same task input envelope and receipt contract while owning separate implementations. Switching providers requires matching operation semantics, preconditions, and results for the stage; a shared contract alone does not guarantee interchangeability.

## Task input envelope

Context passing is fully structured and file-based. The Orchestrator never concatenates large, unstructured free-text prompts across stages. Before dispatching any provider, the Orchestrator materializes the complete execution context as an immutable JSON file at `<receipt_root>/<step_index>-input.json`.

The Task Input Envelope adheres to a standardized 7-block schema (`schema_version: "1.0"`):

```json
{
  "schema_version": "1.0",
  "task": { "logical_stage": "...", "step_index": 0, "attempt": 1, "root_issue_id": "...", "current_issue_id": "..." },
  "provider": { "type": "skill | engine", "target": "...", "args": [] },
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

Deterministic steps within a skill should use scripts in `skills/<skill>/scripts/` wherever practical, separating mechanical operations from work that requires agent judgment:

- **Internal scripts (`scripts/`)**: Encapsulate repetitive, deterministic operations within the skill task, such as preparing Git worktrees or checking repository cleanliness. The skill defines their interfaces; not every helper must implement the complete workflow input and receipt contract.
- **Skill instructions (`SKILL.md`)**: Guide the specialist agent to invoke internal scripts, interpret results, and perform domain judgment and recovery. The skill owns the external stage input and receipt contract.

Regardless of how many internal steps use scripts, the workflow still sees a skill call. Deterministic operations owned by the independent engine form a separate execution pathway; their code lives outside skills, and skill-internal scripts are not directly exposed as engine operations.

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

- **Compact execution report**: A machine-parseable JSON object returned by the skill agent or, in the future, by the engine operation. `execution_status` is strictly constrained to `"succeeded"`, `"blocked"`, or `"failed"`. Valid professional conclusions (including rework findings or `out_of_scope`) report `"succeeded"`, reserving `"blocked"` for unmet prerequisites and `"failed"` for unrecoverable crashes. The `result` object contains domain-specific routing outcomes.
- **Durable disk receipt (Markdown)**: A comprehensive Markdown audit record written to `contract.receipt_path` conforming to `subagent-receipt.template.md`. It records complete verification logs, git revisions, modified artifacts, and predecessor receipt links outside disposable checkouts.

The Orchestrator validates all four report fields and verifies physical existence of the receipt file. Any protocol violation, unparseable output, or missing receipt triggers fail-fast halting to the Decision Board without speculative repair.

## Workspace ownership

The orchestrator assigns environments and decides preparation, reuse, and cleanup timing. A
`pc-workspace` specialist prepares and validates Git checkouts before professional tasks start.
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

Workflow definitions are decoupled from technical architecture and execution providers. Specific execution sequences (such as issue delivery, hotfixes, or refactoring) live in dedicated workflow files under `skills/pc-orchestrator/workflows/`. The Orchestrator owns workflow policy and routing; the future independent engine encapsulates deterministic operations without hardcoding specific domain delivery stages. Keeping workflow files within a skill does not place the engine implementation within that skill.
