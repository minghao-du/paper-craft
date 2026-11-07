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

Every dispatch starts a new agent conversation, including repeated roles and repair attempts. Context travels through explicit inputs rather than conversation reuse. Professional agents own domain judgments. The Orchestrator owns routing and acceptance. A successfully executed review can conclude that changes are required, and a successful scope assessment can identify work outside its authorization. Detailed evidence stays in file receipts.

The skills enforce contracts through kernel scripts and agent instructions. Programmatic verification and state machine enforcement guard every dispatch and receipt. Operational limits, report repair, scope reassessment, and recovery procedures belong in the orchestrator skill.

## Stage-provider decoupling

Workflow stages decouple abstract logical tasks from concrete execution providers. The workflow state machine tracks task progress, state transitions, and receipt validation without hardcoding how a stage is executed. Each stage declares a polymorphic provider specification:

```yaml
provider:
  type: "skill" | "script"
  target: "<skill-name> | <script-path>"
  args: []
```

Two provider types fulfill the contract:

- **`skill` provider**: The Orchestrator dispatches an autonomous LLM Specialist Subagent via the platform adapter, loading `skills/<target>/SKILL.md` with a standardized slim prompt referencing the task input envelope.
- **`script` provider**: The Orchestrator or headless runner executes a deterministic CLI kernel script (`target`) with `--input-envelope <path>`, capturing the compact execution report from standard output.

Because both provider pathways consume the identical task input envelope and produce the identical receipt contract, substituting a `skill` provider with a `script` provider requires zero modifications to workflow stage logic, routing tables, or state persistence.

## Task input envelope

Context passing is fully structured and file-based. The Orchestrator never concatenates large, unstructured free-text prompts across stages. Before dispatching any provider, the Orchestrator materializes the complete execution context as an immutable JSON file at `<receipt_root>/<step_index>-input.json`.

The Task Input Envelope adheres to a standardized 7-block schema (`schema_version: "1.0"`):

```json
{
  "schema_version": "1.0",
  "task": { "logical_stage": "...", "step_index": 0, "attempt": 1, "root_issue_id": "...", "current_issue_id": "..." },
  "provider": { "type": "skill | script", "target": "...", "args": [] },
  "environment": { "working_directory": "...", "repository": "...", "base_branch": "...", "branch": "...", "commit": "..." },
  "inputs": { "objective": "...", "scope": "...", "acceptance_criteria": [], "predecessor_receipts": [], "parameters": {} },
  "contract": { "receipt_path": "...", "receipt_template": "..." },
  "budgets": { "delivery_attempts_used": 0, "delivery_attempts_max": 3, "replans_used": 0, "replans_max": 2 }
}
```

This protocol establishes two operational invariants:

- **Standardized slim prompt standard (~15 lines)**: When dispatching LLM subagents, the prompt contains only the assigned stage name, the absolute envelope path, directory binding instructions, and the compact JSON return requirement. Domain context, acceptance criteria, predecessor receipts, and budget limits are read directly from the envelope file, eliminating prompt drift.
- **Atomic write and isolation**: Envelopes and state files are written atomically using temporary files, buffer flush, fsync, and atomic replace within `<receipt_root>`. `<receipt_root>` resides outside disposable git worktrees to prevent accidental deletion during branch switches or worktree pruning.

## Skill kernel-wrapper pattern

Skills bifurcate deterministic mechanical operations from cognitive heuristic reasoning through the Kernel-Wrapper Pattern:

- **Deterministic kernel (`scripts/`)**: Repetitive, invariant, and programmatic logic—such as Git worktree preparation, repository cleanliness checks, receipt generation, and envelope serialization—is encapsulated as self-contained CLI scripts under `skills/<skill>/scripts/`. The kernel consumes `--input-envelope <path>`, executes deterministically, writes the Markdown receipt, and emits the compact JSON report to standard output.
- **Cognitive wrapper (`SKILL.md`)**: The skill document serves as a lean cognitive interface for LLM subagents. It instructs the subagent to run the internal kernel script with `--input-envelope`, inspect stdout, and apply domain heuristics or fallback recovery procedures only when non-deterministic judgments or environmental obstacles arise.

This pattern provides a single underlying implementation for both execution modes. LLM subagents achieve high leverage by delegating mechanical execution to internal scripts, while future automated runners can invoke the kernel scripts directly without rewriting core logic.

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

- **Compact execution report (stdout)**: A machine-parseable JSON object emitted to standard output. `execution_status` is strictly constrained to `"succeeded"`, `"blocked"`, or `"failed"`. Valid professional conclusions (including rework findings or `out_of_scope`) report `"succeeded"`, reserving `"blocked"` for unmet prerequisites and `"failed"` for unrecoverable crashes. The `result` object contains domain-specific routing outcomes.
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

Workflows are decoupled from both technical architecture and the core orchestrator engine. Specific execution sequences (such as issue delivery, hotfixes, or refactoring) live in dedicated workflow files under `skills/pc-orchestrator/workflows/`. The orchestrator core provides pure dispatch, receipt validation, and error recovery primitives without hardcoding any specific domain delivery stages.
