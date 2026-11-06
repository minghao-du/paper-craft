---
name: pc-issue-plan
description: Issue planning and triage specialist — assess whether an Issue requires decomposition, draft and file sub-issues, judge dependencies, and evaluate integrated acceptance
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-issue-plan

Authoritative instructions for evaluating GitHub issues: assessing whether an issue requires decomposition into sub-issues, drafting child issues with falsifiable acceptance gates, or evaluating integrated acceptance against parent objectives.
This skill can be invoked directly by a human or agent with a task prompt or issue reference, or dispatched automatically by the workflow orchestrator.

## Task Inputs

Before starting work, ensure the following inputs are available:
1. **Issue context:** Issue number, title, description, comments, and any existing sub-issues (`gh issue view <issue> --comments`).
2. **Task scope & objectives:** Planning scope specified in the prompt — either decomposition evaluation (triaging and splitting root issues) or integrated acceptance evaluation (verifying combined deliverables against parent objective).
3. **Repository context:** Current repository working tree, documentation (`CONSTITUTION.md`, `DESIGN.md`), related issues or pull requests.

## Planning & Evaluation Procedure

### Step 1: Establish objective & depth check

Read the assigned issue, original objective, constraints, existing child issues, and metadata.
Verify repository and issue identity from the provided brief or environment.

#### Depth-1 strict boundary check
Check if the issue has a parent or was created as a sub-issue (via GitHub native sub-issue metadata or parent issue references in description).
- **If already a sub-issue:** strictly bypass decomposition. Return:
  ```json
  {
    "needsSplit": false,
    "strategy": "direct",
    "reason": "Depth limit reached: Issue is already a sub-issue and must be executed as an atomic unit."
  }
  ```
  Halt planning and yield execution to the direct worker flow. Never nest sub-issues within sub-issues.

### Step 2: Evaluate split decision (Triage Criteria)

When the issue is a root issue, evaluate whether it can be solved directly in a single iteration or must be decomposed:

#### Split criteria
An issue **must be decomposed** (`needsSplit: true`) if ANY of the following hold:
1. **Delivery budget:** Code modifications span multiple independent modules/packages, or the expected implementation exceeds a single cohesive PR / test run budget.
2. **Verification independence:** The work contains separable stages with distinct, falsifiable acceptance gates (e.g., scaffolding and contracts can be verified independently before core algorithms).
3. **Exploratory / blocking dependencies:** The solution requires a preliminary benchmark, spikes, or experimental confirmation before subsequent implementation choices can be settled.

If NONE of the above hold, the issue is atomic:
```json
{
  "needsSplit": false,
  "strategy": "direct",
  "reason": "<Specific justification why single-turn/single-PR delivery is feasible>"
}
```

### Step 3: Plan children (Decomposition)

When `needsSplit: true`, propose bounded child issues and actionable worker briefs:

#### Planning standards & rigor
Incorporate strategic review discipline before finalizing children:
- **Scope discipline:** Define explicit "What this is NOT" boundaries to prevent scope creep.
- **Falsifiable gates:** Every child task must have an observable, automated acceptance gate (tests, CLI assertions, or benchmarks).
- **Cost & complexity check:** Verify any algorithmic complexity or resource claims with back-of-the-envelope calculations. Flag scaling cliffs or unrealistic performance assumptions.
- **Dependency & collision graph:** Distinguish strict prerequisites (`blockedBy`) from resource/file collision constraints.

#### Sub-issue drafting and filing
1. For each planned child, draft an issue specification following project conventions:
   - Concise imperative title.
   - Problem statement and falsifiable success criteria.
   - Scope boundaries (in scope / out of scope).
   - Test plan with execution commands.
2. Write local drafts as `ISSUE-<slug>.md`.
3. Submit each draft to GitHub via `/pc-issue-file` (`gh issue create --title "<title>" --body-file ISSUE-<slug>.md`).
4. Update the parent issue body with the child tasklist (`- [ ] #<number> <title>`), preserving all existing progress.
5. Return the assignment plan structure:
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

### Step 4: Integrated acceptance evaluation

When evaluating integrated acceptance of a parent issue after child deliveries are complete:
1. Compare child delivery results and integrated Git HEAD against the original parent objective.
2. Verify that all required child deliveries are merged and validated with verified evidence.
3. Assess whether combined deliverables satisfy parent falsifiable gates. Child closure alone does not establish parent completion.
4. Return evidence-backed acceptance or scoped rework recommendations:
   - Identify evaluated head SHA and specific verified evidence.
   - If acceptance passes, confirm readiness for parent issue closure.
   - If gaps exist, route specific rework instructions with concrete missing evidence or requirements.

## Quality Requirements & Completion Criteria

A planning or evaluation task is complete only when all criteria are met:
1. **Depth boundary strictly observed:** No sub-issues nested beneath existing sub-issues.
2. **Explicit falsifiable criteria:** Every planned child issue includes concrete, automated acceptance gates.
3. **Accurate dependency tracking:** `blockedBy` arrays reflect actual technical prerequisites.
4. **Issue tracker synchronization:** Parent issue tasklist matches filed child issues.
5. **Evidence-based acceptance:** Integrated acceptance evaluates verified test and benchmark evidence against parent goals, not nominal task closures.

## Task Outputs

1. **Triage decision or assignment plan:** Structured JSON or markdown outlining split decision, goals, constraints, and tasks.
2. **Filed GitHub issues:** Created child issues on GitHub and updated parent tasklist.
3. **Integrated acceptance report:** Head SHA, verified evidence, acceptance confirmation, or specific rework instructions.
4. **Receipt / submission:**
   - When dispatched via workflow engine: the execution receipt is submitted via the `pc workflow submit-result` command supplied in the dispatch prompt.
   - When invoked manually or standalone: report the decision, plan, or acceptance report directly to the caller.
