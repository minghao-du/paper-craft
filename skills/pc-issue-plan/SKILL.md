---
name: pc-issue-plan
description: Plan scientific or engineering issues by verifiable execution stages, draft and file up to five sub-issues, and define acceptance gates and dependencies
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-issue-plan

Plan GitHub issues around verifiable execution stages, preserving the scientific objective and defining bounded child issues with concrete acceptance gates and dependencies.

This skill is invoked directly by a human or agent with a task prompt or issue reference.

## Working directory

Follow [the environment contract](../pc-workspace/references/environment.md) in the prepared
working directory supplied by the caller. For manual use, select an existing checkout or prepare
one with [pc-workspace](../pc-workspace/SKILL.md) before starting.

## Scientific Problem Context

In paper-craft, the root issue is typically a concrete scientific question or computational research problem (e.g., hypothesis validation, algorithmic implementation, baseline reproduction, scientific pipeline construction, or benchmark evaluation).

Preserve the scientific objective throughout decomposition.

- Every child must specify stage-appropriate artifacts or observable state evidence. Cleanup can establish removal of obsolete outputs and consistent configuration references, data preparation can produce validated splits, and experiments can produce checkpoints, metrics, and figures.
- Acceptance gates must be automated and falsifiable for that stage. Distinguish execution feasibility from scientific findings, and derive scientific thresholds from the parent requirements.

## Task Inputs

Before starting work, ensure the relevant inputs are available:
1. **Issue context:** Issue number, title, description, comments, and any existing sub-issues (`gh issue view <issue> --comments`).
2. **Goal & constraints:** Primary scientific objective, delivery budget, and explicit architectural or operational constraints.
3. **Repository context:** Current repository working tree, documentation (`CONSTITUTION.md`, `DESIGN.md`), related issues or pull requests.

## Scope Reassessment

When the brief asks to reassess an existing plan, inspect the original objective, unchanged
acceptance criteria, authorized scope, prior attempts, and current artifacts. Preserve existing
issue-tracker state for an assessment-only request. Return the assessment before the normal
issue-filing procedure. Keep the depth-1 boundary for any proposed children.

Report an evidence-backed professional conclusion with rationale and affected objectives.

- `revised_plan` — A concrete alternative within the current authorization can meet all required
  criteria. Include bounded tasks, dependencies, completion evidence, and gates invalidated by
  the change. Identify consistency or recovery work needed for partial modifications.
- `optional_improvement` — The outstanding work is optional under existing acceptance criteria.
  Cite evidence that required criteria remain satisfied and that the handoff state is consistent.
- `decision_required` — Progress requires a scope, acceptance, or prerequisite decision. State
  the specific decision, alternatives, and consequences.

Reassessment is complete when its conclusion is supported, partial-state risks are accounted
for, and the caller can identify the next action or decision from the report.

## Planning & Decomposition Procedure

### Step 1: Establish objective & depth check
Read the assigned issue, original scientific objective, constraints, existing child issues, and metadata.
Verify repository and issue identity from the provided brief or environment.

#### Depth-1 strict boundary check
Check if the issue has a parent or was created as a sub-issue (via GitHub native sub-issue metadata or parent issue references in description).
- **If already a sub-issue:** strictly bypass decomposition. Return:
  ```json
  {
    "outcome": "direct",
    "summary": "Atomic sub-issue execution",
    "reason": "Depth limit reached: Issue is already a sub-issue and must be executed as an atomic unit."
  }
  ```
  Halt planning and yield execution to direct delivery. Never nest sub-issues within sub-issues.

### Step 2: Identify verifiable execution stages
For a root issue, map the work needed to satisfy its acceptance criteria into stages with distinct artifacts or state evidence and completion gates. A clear objective, one module, or a single feasible PR can still contain multiple stages.

Consider cleanup and contract repair, data preparation, feasibility validation, remaining execution, and analysis or synthesis where the work requires them. Each candidate must have a meaningful completion checkpoint that enables downstream work or can be accepted separately. Keep routine commands and small implementation steps inside their owning stage.

For multiple configurations or batch runs, inspect existing evidence for the shared execution path under the current data and workflow. If feasibility remains unverified, separate a representative configuration and make the remaining runs depend on its passing feasibility gate. Group the remaining configurations that share the same procedure and acceptance contract. Existing applicable evidence can justify a combined execution stage.

An issue **must be decomposed** (`outcome: "decomposed"`) when at least two such stages exist. Module boundaries, delivery budgets, and experimental uncertainty can help locate checkpoints.

Return `direct` only when the root issue has one cohesive delivery stage. Justify the absence of further meaningful acceptance checkpoints.

```json
{
  "outcome": "direct",
  "summary": "Atomic issue delivery",
  "reason": "<Why the work has one cohesive delivery stage and no further meaningful acceptance checkpoints>"
}
```

### Step 3: Plan children (Decomposition)
When decomposition is required, propose bounded child issues and actionable worker briefs:

#### Child count and coverage
A decomposed plan must contain **2–5 direct sub-issues**, including existing children retained in the plan. Five is a hard maximum. When more stages are identified, combine repeated runs and smaller adjacent preparation stages while preserving critical feasibility gates. Use fewer children when that covers the work coherently.

Map every parent requirement to a child, including configuration, scripts, interfaces, and tests. Assign implementation work to the stage that needs it. Reuse existing children where they cover planned work, and resolve an over-limit plan before filing additional children. Apply these constraints to reassessment proposals as well.

#### Planning standards & rigor
Incorporate strategic review discipline before finalizing children:
- **Stage deliverables:** Explicitly list expected artifacts or state evidence and their paths where applicable.
- **Scope discipline:** Define each child's bounded responsibility.
- **Falsifiable gates:** Every child task must have an observable, automated acceptance gate (tests, CLI assertions, pipeline dry-run, or benchmark scripts).
- **Cost & complexity check:** Verify any algorithmic complexity or resource claims with back-of-the-envelope calculations. Flag scaling cliffs or unrealistic performance assumptions.
- **Dependency & collision graph:** Distinguish strict prerequisites (`blockedBy`) from resource/file collision constraints.

#### Sub-issue drafting and filing
1. For each planned child, draft an issue specification following project conventions:
   - Concise imperative title.
   - Stage-specific problem statement and falsifiable success criteria.
   - Expected output artifacts or state evidence and relevant paths.
   - Scope boundaries (in scope / out of scope).
   - Test plan with concrete execution commands.
2. Write local drafts as `ISSUE-<slug>.md`.
3. Submit each draft to GitHub via `/pc-issue-file` (`gh issue create --title "<title>" --body-file ISSUE-<slug>.md`).
4. Update the parent issue body with the child tasklist (`- [ ] #<number> <title>`), preserving all existing progress.
5. Return the assignment plan structure:
   ```json
   {
     "outcome": "decomposed",
     "summary": "Decomposed into bounded child issues",
     "plan": {
       "goal": "<parent goal>",
       "constraints": ["<constraint 1>", "..."],
       "tasks": [
         {
           "number": 101,
           "title": "<child title>",
           "brief": "<actionable worker instructions>",
           "blockedBy": [],
           "ready": true
         },
         {
           "number": 102,
           "title": "<child title 2>",
           "brief": "<actionable worker instructions>",
           "blockedBy": [101],
           "ready": false
         }
       ]
     }
   }
   ```

## Quality Requirements & Completion Criteria

A planning task is complete only when all criteria are met:
1. **Depth boundary strictly observed:** No sub-issues nested beneath existing sub-issues.
2. **Explicit falsifiable criteria:** Every planned child issue includes concrete, automated acceptance gates and stage-appropriate artifacts or state evidence.
3. **Accurate dependency tracking:** `blockedBy` arrays reflect actual technical prerequisites.
4. **Issue tracker synchronization:** For issue-filing tasks, parent issue tasklist matches filed child issues.
5. **Bounded, complete plan:** The child-count and coverage constraints hold before returning or filing a plan.

## Task Outputs

- Direct execution: `{ outcome: "direct", summary: "...", reason: "..." }`
- Decomposed execution: `{ outcome: "decomposed", summary: "...", plan: { tasks: [...] } }`
- Scope reassessment: `{ outcome: "revised_plan" | "optional_improvement" | "decision_required", summary: "...", ... }` with the supporting assessment described above.
- Filed GitHub child issues and updated parent tasklist when issue filing was requested.
- Report the decision or plan directly to the calling agent or user.
