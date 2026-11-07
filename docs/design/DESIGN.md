# paper-craft Design Decisions

[简体中文](DESIGN.zh.md)

Technical architecture decisions for paper-craft. These choices anchor the entire system—changing them carries broad consequences.

## Modular Design

Modules follow these principles:

- **Orthogonality and low coupling**: Minimize inter-module dependencies and keep responsibilities strictly orthogonal, preventing intertwined webs of coupling even when interfaces are small, and strictly containing the blast radius of changes.
- **Deep modules and high leverage**: Expose minimal interface surface area (seams) while encapsulating complex implementation and state internally, providing high leverage for callers, ensuring locality for maintainers, and eliminating pass-through layers.

## Skill and execution boundaries

The agreed target architecture separates professional task knowledge from workflow policy. This section describes the refactoring target, not the current implementation.

- **Skill**: teaches how to complete a coherent professional task. Specialist skills know neither workflows nor the orchestrator and do not require the paper-craft CLI. Genuine dependencies on other skills are permitted; dispatch-specific modes and receipt commands are not. Audit all specialist skills for workflow awareness and mixed responsibilities; retain useful professional collaboration without introducing a separate skill for every operation.
- **Orchestrator**: owns ordering, executor selection, result associations, failure branches and overall completion. It understands failure reasons to choose subsequent work but does not manually copy findings or assemble input fields.

Every dispatch starts a new agent conversation, including repeated roles and repair attempts. Context travels through explicit inputs rather than conversation reuse. Dispatch supplies a common report envelope containing `execution_status` (`succeeded`, `blocked`, or `failed`), task-specific `result`, absolute `receipt_path`, and a short `summary`. Professional agents own domain judgments. The Orchestrator owns routing and acceptance. A successfully executed review can conclude that changes are required, and a successful scope assessment can identify work outside its authorization. Detailed evidence stays in file receipts.

The skills implement report checks through agent instructions. Programmatic enforcement belongs to a future execution adapter. Operational limits, report repair, scope reassessment, and recovery procedures belong in the orchestrator skill.

## Workflow decoupling

Workflows are decoupled from both technical architecture and the core orchestrator engine. Specific execution sequences (such as issue delivery, hotfixes, or refactoring) live in dedicated workflow files under `skills/pc-orchestrator/workflows/`. The orchestrator core provides pure dispatch, receipt validation, and error recovery primitives without hardcoding any specific domain delivery stages.
