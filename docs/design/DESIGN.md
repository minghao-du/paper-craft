# paper-craft Design Decisions

[简体中文](DESIGN.zh.md)

Technical architecture decisions for paper-craft. These choices anchor the entire system—changing them carries broad consequences.

## Modular Design

Modules follow these principles:

- **Orthogonality and low coupling**: Minimize inter-module dependencies and keep responsibilities strictly orthogonal, preventing intertwined webs of coupling even when interfaces are small, and strictly containing the blast radius of changes.
- **Deep modules and high leverage**: Expose minimal interface surface area (seams) while encapsulating complex implementation and state internally, providing high leverage for callers, ensuring locality for maintainers, and eliminating pass-through layers.

## Skill and execution boundaries

The agreed target architecture separates professional task knowledge from workflow policy. This section describes the refactoring target, not the current implementation.

- **Skill**: teaches how to complete a coherent professional task. Specialist skills know neither workflows nor the orchestrator and do not require the paper-craft CLI. Genuine dependencies on other skills are permitted; dispatch-specific modes and receipt commands are not.
- **Task contract**: declares a task type's inputs, outputs and validation, independently of its position in a workflow or its executor. Contracts live in the execution module, outside specialist skill directories. Initially, only tasks used by the default orchestrator workflow need contracts.
- **Execution support**: resolves contract inputs, assembles prompts, starts agents, validates and records results, and manages execution identity and resources. It does not select subsequent tasks or interpret a workflow transition graph.
- **Orchestrator**: owns ordering, executor selection, result associations, failure branches and overall completion. It understands failure reasons to choose subsequent work but does not manually copy findings or assemble input fields. Scripts resolve the selected predecessor results into the next task's inputs.

Every dispatch starts a new agent conversation, including repeated roles and repair attempts. Context travels through explicit inputs rather than conversation reuse. Execution status is distinct from the business outcome: a successfully executed review can conclude that changes are required. Scripts validate contracts; professional agents supply domain judgments.

Persist the orchestrator's plan separately from execution records. The plan captures goals, steps, executors and amendments; execution records capture task identities, input associations, status, results and resources. Recovery reads both. Scripts never advance the plan automatically. Keep module interfaces small and responsibilities orthogonal.

## Default orchestration reference

The default sequence belongs in the orchestrator skill as an editable reference, not in executable transition rules. Users can change the sequence through instructions. This design records the intended default; the skill owns its operational procedure.

1. Invoke `pc-issue-plan` to determine whether subissues are needed and establish the plan.
2. For each issue in dependency order, invoke `pc-issue-work` to implement and verify it, then `pc-pr-land` to create or update its PR, invoke `pc-pr-review`, and merge only after verification passes. Findings return to the orchestrator for a fresh repair dispatch.
3. Invoke `pc-issue-plan` to verify the original objective against the combined delivery evidence. It reports gaps without scheduling repairs itself.
4. Invoke `pc-pipeline-refactor` to organize only the pipeline files involved in this work. Preserve scientific methods, results and conclusions; update affected path references and perform necessary structural and operability checks without rerunning unrelated computation. Report changes requiring computational logic changes as out of scope.
5. If file organization produced changes, invoke a fresh `pc-pr-land` agent to deliver them. No additional scientific acceptance pass is required solely for file organization.
6. Invoke `pc-research-state` to record final research state, artifact locations and reproduction entry points.

`pc-pr-land` owns delivery to the target branch, not workspace release. Execution support owns resource lifecycle. Audit all specialist skills for workflow awareness and mixed responsibilities; retain useful professional collaboration without introducing a separate skill for every operation.
