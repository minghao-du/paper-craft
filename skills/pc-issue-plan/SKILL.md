---
name: pc-issue-plan
description: Issue planning and triage specialist — assess whether an Issue requires decomposition, draft and file sub-issues, judge dependencies, and evaluate integrated acceptance
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-issue-plan

Authoritative instructions for evaluating GitHub issues: assessing whether an issue requires decomposition into sub-issues, drafting child issues with falsifiable acceptance gates, or evaluating integrated acceptance against parent objectives.
This skill can be invoked directly by a human or agent with a task prompt or issue reference. It supports two distinct task modes:
1. **Planning & Breakdown (`pc-issue-plan`)**: Analyzes the objective, judges depth boundaries and triage criteria, and decides whether sub-issues are needed. Produces a sub-issue plan or atomic execution rationale.
2. **Final Verification (`pc-issue-verify`)**: Verifies combined delivery evidence and integrated Git HEAD against the original parent objective and acceptance criteria. Reports gaps and verified evidence; does NOT schedule repairs or dispatch tasks itself.

## Task Inputs

Before starting work, ensure the relevant inputs are available:

### For Planning & Breakdown (`pc-issue-plan`)
1. **Issue context:** Issue number, title, description, comments, and any existing sub-issues (`gh issue view <issue> --comments`).
2. **Goal & constraints:** Primary objective string, delivery budget, and any explicit architectural or operational constraints.
3. **Repository context:** Current repository working tree, documentation (`CONSTITUTION.md`, `DESIGN.md`), related issues or pull requests.

### For Final Verification (`pc-issue-verify`)
1. **Original objective:** Parent issue objective and problem statement.
2. **Acceptance criteria:** Explicit list of required criteria and falsifiable gates.
3. **Delivery evidence:** List of child delivery records, including issue numbers, merged commit SHAs, PR URLs, and delivery summaries.

## Planning & Evaluation Procedure

### Task Mode A: Planning & Breakdown

#### Step 1: Establish objective & depth check
Read the assigned issue, original objective, constraints, existing child issues, and metadata.
Verify repository and issue identity from the provided brief or environment.

##### Depth-1 strict boundary check
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

#### Step 2: Evaluate split decision (Triage Criteria)
When the issue is a root issue, evaluate whether it can be solved directly in a single iteration or must be decomposed:

##### Split criteria
An issue **must be decomposed** (`outcome: "decomposed"`) if ANY of the following hold:
1. **Delivery budget:** Code modifications span multiple independent modules/packages, or the expected implementation exceeds a single cohesive PR / test run budget.
2. **Verification independence:** The work contains separable stages with distinct, falsifiable acceptance gates (e.g., scaffolding and contracts can be verified independently before core algorithms).
3. **Exploratory / blocking dependencies:** The solution requires a preliminary benchmark, spikes, or experimental confirmation before subsequent implementation choices can be settled.

If NONE of the above hold, the issue is atomic:
```json
{
  "outcome": "direct",
  "summary": "Atomic issue delivery",
  "reason": "<Specific justification why single-turn/single-PR delivery is feasible>"
}
```

#### Step 3: Plan children (Decomposition)
When decomposition is required, propose bounded child issues and actionable worker briefs:

##### Planning standards & rigor
Incorporate strategic review discipline before finalizing children:
- **Scope discipline:** Define explicit "What this is NOT" boundaries to prevent scope creep.
- **Falsifiable gates:** Every child task must have an observable, automated acceptance gate (tests, CLI assertions, or benchmarks).
- **Cost & complexity check:** Verify any algorithmic complexity or resource claims with back-of-the-envelope calculations. Flag scaling cliffs or unrealistic performance assumptions.
- **Dependency & collision graph:** Distinguish strict prerequisites (`blockedBy`) from resource/file collision constraints.

##### Sub-issue drafting and filing
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

---

### Task Mode B: Final Verification (`pc-issue-verify`)

When evaluating integrated acceptance of a parent issue after child deliveries are complete:
1. Compare child delivery records and integrated Git HEAD against the original parent objective and acceptance criteria.
2. Verify that all required child deliveries are merged and validated with concrete evidence (tests, builds, benchmarks). Child issue closure alone does not establish parent completion.
3. Assess whether combined deliverables satisfy parent falsifiable gates.
4. Report evidence-backed verification outcome:
   - If acceptance criteria pass fully:
     ```json
     {
       "outcome": "verified",
       "summary": "All parent criteria satisfied by merged deliverables",
       "evaluatedHead": "<commit SHA evaluated>",
       "evidence": "<Concrete verification commands and test suite results>"
     }
     ```
   - If gaps or regressions remain:
     ```json
     {
       "outcome": "rework_needed",
       "summary": "Integrated verification revealed unmet criteria or regressions",
       "evaluatedHead": "<commit SHA evaluated>",
       "evidence": "<Failure logs, missing test assertions, or unexpected behavior>",
       "gaps": ["<Specific gap 1>", "<Specific gap 2>"]
     }
     ```
   - **Crucial Boundary**: The verifier does NOT schedule repairs or dispatch rework tasks itself; it reports findings directly to the caller.

## Quality Requirements & Completion Criteria

A planning or evaluation task is complete only when all criteria are met:
1. **Depth boundary strictly observed:** No sub-issues nested beneath existing sub-issues.
2. **Explicit falsifiable criteria:** Every planned child issue includes concrete, automated acceptance gates.
3. **Accurate dependency tracking:** `blockedBy` arrays reflect actual technical prerequisites.
4. **Issue tracker synchronization:** Parent issue tasklist matches filed child issues.
5. **Evidence-based acceptance:** Integrated acceptance evaluates verified test and benchmark evidence against parent goals, not nominal task closures.

## Task Outputs

1. **For Planning (`pc-issue-plan`):**
   - Direct: `{ outcome: "direct", summary: "...", reason: "..." }`
   - Decomposed: `{ outcome: "decomposed", summary: "...", plan: { tasks: [...] } }`
   - Filed GitHub child issues and updated parent tasklist.
2. **For Final Verification (`pc-issue-verify`):**
   - Verified: `{ outcome: "verified", summary: "...", evaluatedHead: "...", evidence: "..." }`
   - Rework needed: `{ outcome: "rework_needed", summary: "...", evidence: "...", gaps: [...] }`
3. **Report to caller:** Return the decision, plan, or acceptance report directly to the calling agent or user.
