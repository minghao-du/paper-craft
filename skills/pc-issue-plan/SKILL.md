---
name: pc-issue-plan
description: Issue planning and triage specialist — assess whether a scientific or engineering issue requires decomposition, draft and file sub-issues, establish falsifiable scientific gates, and judge dependencies
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-issue-plan

Authoritative instructions for evaluating GitHub issues: assessing whether an issue requires decomposition into sub-issues, judging execution depth boundaries, and drafting child issues with concrete, falsifiable scientific and engineering acceptance gates.

This skill is invoked directly by a human or agent with a task prompt or issue reference.

## Scientific Problem Context

In paper-craft, the root issue is typically a concrete scientific question or computational research problem (e.g., hypothesis validation, algorithmic implementation, baseline reproduction, scientific pipeline construction, or benchmark evaluation).

Planning and decomposition must treat the scientific objective as an absolute first-class citizen:
- **Scientific Deliverables & Artifacts:** Every decomposed sub-issue must specify observable scientific artifacts (e.g., metric tables, figures, statistical summaries, workflow rules, model checkpoints) rather than empty scaffolding.
- **Falsifiable Scientific Gates:** Child tasks must carry automated, verifiable acceptance gates (e.g., target performance thresholds, statistical significance, invariance tests, small-data smoke checks, or execution scripts) that prove the scientific capability was achieved.

## Task Inputs

Before starting work, ensure the relevant inputs are available:
1. **Issue context:** Issue number, title, description, comments, and any existing sub-issues (`gh issue view <issue> --comments`).
2. **Goal & constraints:** Primary scientific objective, delivery budget, and explicit architectural or operational constraints.
3. **Repository context:** Current repository working tree, documentation (`CONSTITUTION.md`, `DESIGN.md`), related issues or pull requests.

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

### Step 2: Evaluate split decision (Triage Criteria)
When the issue is a root issue, evaluate whether it can be solved directly in a single iteration or must be decomposed:

#### Split criteria
An issue **must be decomposed** (`outcome: "decomposed"`) if ANY of the following hold:
1. **Delivery budget:** Code modifications span multiple independent modules/packages, or the expected implementation exceeds a single cohesive PR / test run budget.
2. **Verification independence:** The work contains separable stages with distinct, falsifiable acceptance gates (e.g., data ingestion/preprocessing and contract scaffolding can be verified independently before core modeling or analysis).
3. **Exploratory / blocking dependencies:** The solution requires preliminary benchmarks, spikes, or experimental confirmation before subsequent implementation choices can be settled.

If NONE of the above hold, the issue is atomic:
```json
{
  "outcome": "direct",
  "summary": "Atomic issue delivery",
  "reason": "<Specific justification why single-turn/single-PR delivery is feasible>"
}
```

### Step 3: Plan children (Decomposition)
When decomposition is required, propose bounded child issues and actionable worker briefs:

#### Planning standards & rigor
Incorporate strategic review discipline before finalizing children:
- **Scientific deliverables:** Explicitly list expected research artifacts (e.g., `results/<stage>/...`, metric JSON, figures).
- **Scope discipline:** Define explicit "What this is NOT" boundaries to prevent scope creep.
- **Falsifiable gates:** Every child task must have an observable, automated acceptance gate (tests, CLI assertions, pipeline dry-run, or benchmark scripts).
- **Cost & complexity check:** Verify any algorithmic complexity or resource claims with back-of-the-envelope calculations. Flag scaling cliffs or unrealistic performance assumptions.
- **Dependency & collision graph:** Distinguish strict prerequisites (`blockedBy`) from resource/file collision constraints.

#### Sub-issue drafting and filing
1. For each planned child, draft an issue specification following project conventions:
   - Concise imperative title.
   - Problem statement and falsifiable scientific and engineering success criteria.
   - Expected output artifacts and data paths.
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
2. **Explicit falsifiable criteria:** Every planned child issue includes concrete, automated acceptance gates and expected artifacts.
3. **Accurate dependency tracking:** `blockedBy` arrays reflect actual technical prerequisites.
4. **Issue tracker synchronization:** Parent issue tasklist matches filed child issues.

## Task Outputs

- Direct execution: `{ outcome: "direct", summary: "...", reason: "..." }`
- Decomposed execution: `{ outcome: "decomposed", summary: "...", plan: { tasks: [...] } }`
- Filed GitHub child issues and updated parent tasklist.
- Report the decision or plan directly to the calling agent or user.
