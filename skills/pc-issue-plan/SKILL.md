---
name: pc-issue-plan
description: Issue planning and triage specialist — assess whether an Issue requires decomposition, draft and file sub-issues, judge dependencies, and evaluate integrated acceptance.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-issue-plan

Perform planning and integrated acceptance assignments supplied by the owning Run's Orchestrator (`role: 'planner'`).
Read [shared constraints](../lib/workflow.md).
Return structured findings through the correlated task result; the Orchestrator owns invocation, scheduling, receipt acceptance, and recovery.

## 1. Establish objective & depth check

Read the assigned Issue, original objective, constraints, existing child Issues, and metadata.
Verify the assigned repository and Issue identity from the immutable brief.

### Depth-1 strict boundary check
Check if the Issue has a parent or was created as a sub-issue (via GitHub native sub-issue metadata or parent issue references in description).
- **If already a sub-issue:** strictly bypass decomposition. Return:
  ```json
  {
    "needsSplit": false,
    "strategy": "direct",
    "reason": "Depth limit reached: Issue is already a sub-issue and must be executed as an atomic unit."
  }
  ```
  Halt planning and yield execution to the direct Worker flow. Never nest sub-issues within sub-issues.

**Done:** Issue identity, scope boundaries, constraints, and hierarchy level are verified.

## 2. Evaluate split decision (Triage Criteria)

When the Issue is a root Issue, evaluate whether it can be solved directly in a single iteration or must be decomposed:

### Split criteria
An Issue **must be decomposed** (`needsSplit: true`) if ANY of the following hold:
1. **Delivery budget**: Code modifications span multiple independent modules/packages, or the expected implementation exceeds a single cohesive PR / test run budget.
2. **Verification independence**: The work contains separable stages with distinct, falsifiable acceptance gates (e.g., scaffolding and contracts can be verified independently before core algorithms).
3. **Exploratory / blocking dependencies**: The solution requires a preliminary benchmark, spikes, or experimental confirmation before subsequent implementation choices can be settled.

If NONE of the above hold, the Issue is atomic:
```json
{
  "needsSplit": false,
  "strategy": "direct",
  "reason": "<Specific justification why single-turn/single-PR delivery is feasible>"
}
```

## 3. Plan children (Decomposition)

When `needsSplit: true`, propose bounded child Issues and semantic Worker briefs:

### Planning standards & rigor
Incorporate strategic review discipline before finalizing children:
- **Scope discipline**: Define explicit "What this is NOT" boundaries to prevent scope creep.
- **Falsifiable gates**: Every child task must have an observable, automated acceptance gate (tests, CLI assertions, or benchmarks).
- **Cost & complexity check**: Verify any algorithmic complexity or resource claims with back-of-the-envelope calculations. Flag scaling cliffs or unrealistic performance assumptions.
- **Dependency & collision graph**: Distinguish strict prerequisites (`blockedBy`) from resource/file collision constraints.

### Sub-issue drafting and filing
1. For each planned child, draft an issue specification following project conventions:
   - Concise imperative title.
   - Problem statement and falsifiable success criteria.
   - Scope boundaries (in scope / out of scope).
   - Test plan with execution commands.
2. Write local drafts as `ISSUE-<slug>.md`.
3. Submit each draft to GitHub via `/pc-issue-file` (`gh issue create --title "<title>" --body-file ISSUE-<slug>.md`).
4. Update the parent Issue body with the child tasklist (`- [ ] #<number> <title>`), preserving all existing progress.
5. Return the assignment plan contract:
   ```json
   {
     "needsSplit": true,
     "strategy": "decompose",
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
   ```

**Done:** All sub-issues are filed, parent tasklist is updated, and the dependency graph is established.

## 4. Integrated acceptance (`stage: 'integrated-acceptance'`)

When all child deliveries of a decomposed Issue have finished verified delivery, the Orchestrator dispatches `pc-issue-plan` with `stage: 'integrated-acceptance'`, `role: 'planner'`.

1. Compare attributed child delivery results and integrated Git HEAD against the original parent objective.
2. Verify that all required child deliveries are complete in `registry.deliveries` with recorded final records and released resources.
3. Assess whether combined deliverables satisfy parent falsifiable gates. Child closure alone does not establish parent completion.
4. Return evidence-backed acceptance or scoped rework recommendations:
   - Identify evaluated head SHA and specific verified evidence.
   - If acceptance passes, confirm readiness for parent Issue closure.
   - If gaps exist, route specific rework instructions back to the Orchestrator.

**Done:** Integrated evidence is verified against the original parent objective, and delivery version is authenticated.
