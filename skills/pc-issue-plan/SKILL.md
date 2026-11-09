---
name: pc-issue-plan
description: Plan scientific or engineering issues by verifiable execution stages, draft and file bounded sub-issues, and define acceptance gates and dependencies
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
Read the native parent (`GET /repos/{owner}/{repo}/issues/{number}/parent`) and all pages of native sub-issues (`GET /repos/{owner}/{repo}/issues/{number}/sub_issues`). Reconcile these with explicit parent declarations and child tasklists in issue bodies, including legacy children. Ordinary related-issue links establish context only. Resolve conflicting or unreadable hierarchy evidence before classifying depth.
- **If already a sub-issue:** strictly bypass decomposition. Return:
  ```json
  {
    "outcome": "direct",
    "summary": "Atomic sub-issue execution",
    "reason": "Depth limit reached: Issue is already a sub-issue and must be executed as an atomic unit."
  }
  ```
  Halt planning and yield execution to direct delivery. Never nest sub-issues within sub-issues.

Root status establishes hierarchy depth. For a root, decide delivery granularity separately in Step 2.

### Step 2: Identify verifiable execution stages
For a root issue, produce a stage table before choosing an outcome. Cover every proposed phase and parent acceptance requirement, recording each candidate's deliverable or observable state, automated acceptance gate, and prerequisites. Record retained stages and reasons for merging or rejecting candidates. A clear objective, one module, or a single feasible PR can still contain multiple stages.

Consider cleanup and contract repair, data preparation, feasibility validation, remaining execution, and analysis or synthesis where the work requires them. Each candidate must have a meaningful completion checkpoint that enables downstream work or can be accepted separately. Keep routine commands and small implementation steps inside their owning stage.

For multiple configurations or batch runs, inspect existing evidence for the shared execution path under the current data and workflow. If feasibility remains unverified, separate a representative configuration and make the remaining runs depend on its passing feasibility gate. Group the remaining configurations that share the same procedure and acceptance contract. Existing applicable evidence can justify a combined execution stage.

An issue **must be decomposed** (`outcome: "decomposed"`) when at least two such stages exist. Module boundaries, delivery budgets, and experimental uncertainty can help locate checkpoints.

Return `direct` only when the table leaves one cohesive delivery stage. Explain why each other candidate lacks a meaningful separate acceptance checkpoint. Shared files, sequential execution, and a common final scientific gate alone do not justify merging independently verifiable stages. Include the table and rationale in the planning report for either outcome.

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
A decomposed plan normally contains **2–4 direct sub-issues**, including existing children retained in the plan. Choose the smallest count that preserves bounded responsibilities and meaningful acceptance checkpoints. Reserve **5** for unusually complex tasks, explaining why grouping into four would make a child unbounded or obscure a critical dependency or feasibility gate. Five is a hard maximum.

Several execution stages can belong to one child when they share a coherent acceptance contract. Group repeated runs and adjacent preparation work where appropriate, retaining their individual checks and critical feasibility gates. Explain the grouping. Stage count alone does not justify an equal number of children.

Map every parent requirement to a child, including configuration, scripts, interfaces, and tests. Assign implementation work to the stage that needs it. Reuse existing children where they cover planned work, and resolve an over-limit plan before filing additional children. Apply these constraints to reassessment proposals as well.

#### Planning standards & rigor
Incorporate strategic review discipline before finalizing children:
- **Stage deliverables:** Explicitly list expected artifacts or state evidence and their paths where applicable.
- **Scope discipline:** Define each child's bounded responsibility.
- **Falsifiable gates:** Every child task must have an observable, automated acceptance gate (tests, CLI assertions, pipeline dry-run, or benchmark scripts). Assign local behavioral checks to implementation children and integrated scientific thresholds to the final evaluation child. Preserve every parent threshold in the coverage map.
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
3. A request to execute or deliver the root issue authorizes creating the necessary children: complete filing and relationship verification before returning the execution plan. Explicit assessment-only or draft-only requests stop at the report and local drafts. Reconcile the plan with existing native children and tasklist entries before creating anything. Reuse matching issues. Submit new drafts via `/pc-issue-file` with explicit CREATE intent and target repository, distinguishing the parent reference from an issue to update.
4. Establish each child's native parent using the [GitHub sub-issue API](https://docs.github.com/en/rest/issues/sub-issues). Fetch the child's numeric issue `id` and call `POST /repos/{owner}/{repo}/issues/{parent_number}/sub_issues` with `sub_issue_id` (for example, `gh api --method POST <endpoint> -F sub_issue_id=<id>`). Read back each child's parent and the parent's paginated child list. Reuse matching links and resolve conflicting parents before continuing.
5. Update the parent issue body with the child tasklist (`- [ ] #<number> <title>`), preserving all existing progress. Completion requires the plan, native relationships, and tasklist to agree. On partial failure, report created issue numbers, verified links, and pending synchronization so a retry can resume from existing state.
6. Return the assignment plan structure:
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
4. **Issue tracker synchronization:** For delivery or issue-filing tasks, every child has a real issue number, and read-back native parent/child relationships and the parent tasklist match the plan. Partial filing or synchronization failure is an incomplete plan; report resumable state rather than a dispatch-ready success.
5. **Bounded, complete plan:** The child-count and coverage constraints hold before returning or filing a plan.

## Task Outputs

- Direct execution: `{ outcome: "direct", summary: "...", reason: "..." }`
- Decomposed execution: `{ outcome: "decomposed", summary: "...", plan: { tasks: [...] } }`
- Root planning report with the stage table, candidate disposition reasons, and parent-requirement coverage.
- Scope reassessment: `{ outcome: "revised_plan" | "optional_improvement" | "decision_required", summary: "...", ... }` with the supporting assessment described above.
- Filed GitHub child issues, verified native parent/child relationships, and updated parent tasklist for delivery or issue-filing requests.
- Report the decision or plan directly to the calling agent or user.
