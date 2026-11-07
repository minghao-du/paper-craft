---
name: pc-research-plan
description: Create or update the research route in a Project's shared local research state
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-research-plan

Develop or update the research route for the project's designated research entry.
This skill produces a scientific research overview, independent of code implementation; its scope is the plan and its discovery pointer, not research execution.
This skill can be invoked directly by a human or agent with a research query or topic. Use the user's language for the plan and discussion.

## Task Inputs

Before executing, verify the following inputs:
1. **Target project & research entry:** Designate or resolve the project's research home from agent/startup guidance (`research-state/`).
2. **Research question or intent:** The user's research topic, hypothesis, empirical gap, or investigation goals.
3. **Context & supporting documents:** Pre-existing discussions, literature notes, or experimental data.

## Planning Procedure

### Step 1: Establish the research intent

Resolve the target project from the user's request or the current project when unambiguous; ask when the target is unclear.
Resolve its fixed entry from agent/startup guidance and read the entry, relevant linked records, and materials supplied by the user.
If absent, report available sources and information gaps, then use [/pc-research-state](../pc-research-state/SKILL.md) to establish one designated home and pointer under [the research-state convention](../pc-research-state/references/convention.md); label reconstructed or unverified content explicitly.
Use existing discussions and documents rather than restarting settled decisions. Papers, a manuscript, and implementation code are not prerequisites.

Establish the research question, motivation, intended contribution, scope, and constraints that affect the research route.
Resolve facts available in the materials yourself and cite the source for substantive scientific claims.
Distinguish established findings from proposed hypotheses and expected outcomes.

When intent or key research choices are missing, ask focused questions with recommendations and wait for the user's answers.
Ask about choices that change the research direction before refining stages that depend on them.
An empirical unknown may remain open with a proposed way to investigate it; a missing user decision about what research to pursue requires an answer.

**Done:** The research objective and scope are shared with the user, and unresolved scientific questions are explicit enough to describe a proposed route.

### Step 2: Shape the overview

Organize the plan around these elements, adapting headings to the project:
- **Research question and motivation:** What the project will investigate, why it matters, and the evidence motivating it.
- **Intended contribution and scope:** What the research aims to establish, what would count as success, and the boundaries of this project.
- **Proposed stages:** For each stage, state the question it addresses, proposed method, expected output, and evidence or decision needed to proceed. Show dependencies and conditional branches where the research requires them.
- **Open questions and constraints:** Identify undecided methods, missing inputs, and assumptions that could change the route, with a way to resolve them where known.
- **Sources:** Link the research materials supporting the overview rather than reproducing them.

Keep methods at the level needed to understand the scientific approach, such as comparisons, controls, or evaluation criteria.
Keep code changes, commands, implementation task lists, and live execution status outside this overview.
Label the route as proposed and all expected outputs as prospective; preserve uncertainty rather than inventing methods, thresholds, results, or novelty claims.
Use as many stages as the research needs, without imposing a fixed sequence or requiring every question to be settled before the overview can exist.

**Done:** Each stage has all four elements, its place in the route is clear, and every scientific assertion is either source-grounded or explicitly prospective or unresolved.

### Step 3: Update the shared research state

Give the agreed route and sources to [/pc-research-state](../pc-research-state/SKILL.md) for writing into the same entry, with detail linked only when complexity warrants it.
Preserve relevant findings, interpretations, and useful unfinished discussion; keep each full analysis in one place.
Stop maintaining a parallel `RESEARCH-PLAN.md`; existing materials are inputs, not a second authority.
Keep task progress in the original task system.
Add or update the discovery sentence from the convention in related repository/startup guidance, resolving to the same absolute entry from every checkout and preserving unrelated instructions.
A recorded plan does not authorize research execution.

**Done:** The shared state expresses the agreed route and related guidance resolves to its unique entry.

### Step 4: Verify and report

Read the updated state and check that the research question, motivation, contribution, scope, stages, and unresolved questions match the discussion.
Verify every stage's question, method, expected output, and progression condition, and check that plans and hypotheses are distinguishable from established findings.
Check that local source links and the discovery pointer resolve, and that unrelated agent guidance is preserved.
Report missing source access or broken references as gaps rather than implying they were verified.

**Done:** Report links to the research entry and discovery pointer, summarize whether this was a creation or update, and identify any remaining research decisions or evidence gaps.

## Quality Requirements & Completion Criteria

1. **Stage completeness:** Every stage articulates its question, method, expected output, and progression condition.
2. **Epistemic honesty:** Hypotheses and prospective outcomes are clearly distinguished from established evidence.
3. **Clean separation:** Code implementation, file modification plans, and execution commands remain outside the scientific research plan.
4. **Pointer resolution:** Discovery pointer in repository guidance resolves to the canonical research entry.

## Task Outputs

1. **Research plan entry:** Written or updated plan in the designated research state via `/pc-research-state`.
2. **Summary:** Research route overview, stage structure, open questions, and discovery pointer.
