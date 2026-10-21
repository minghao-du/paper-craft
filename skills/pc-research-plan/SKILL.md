---
name: pc-research-plan
description: Create or update a project's research overview and phased research plan.
disable-model-invocation: true
---

# /pc-research-plan

Create or update `RESEARCH-PLAN.md` in the target project root so a new agent can understand the research intent and proposed route before work begins.
This skill produces a research overview, independent of code implementation; its scope is the plan and its discovery pointer, not research execution.
Use the user's language for the plan and discussion.

## 1. Establish the research intent

Resolve the target project from the user's request or the current project when unambiguous; ask when the target is unclear.
Read its agent guidance, existing research plan, and relevant research materials available in the project or supplied by the user.
Use existing discussions and documents rather than restarting settled decisions.
Papers, a manuscript, and implementation code are not prerequisites.

Establish the research question, motivation, intended contribution, scope, and constraints that affect the research route.
Resolve facts available in the materials yourself and cite the source for substantive scientific claims.
Distinguish established findings from proposed hypotheses and expected outcomes.

When intent or key research choices are missing, ask focused questions with recommendations and wait for the user's answers.
Ask about choices that change the research direction before refining stages that depend on them.
An empirical unknown may remain open with a proposed way to investigate it; a missing user decision about what research to pursue requires an answer.

**Done:** The research objective and scope are shared with the user, and unresolved scientific questions are explicit enough to describe a proposed route.

## 2. Shape the overview

Organize the plan around these elements, adapting headings to the project:

- **Research question and motivation:** What the project will investigate, why it matters, and the evidence motivating it.
- **Intended contribution and scope:** What the research aims to establish, what would count as success, and the boundaries of this project.
- **Proposed stages:** For each stage, state the question it addresses, proposed method, expected output, and evidence or decision needed to proceed.
  Show dependencies and conditional branches where the research requires them.
- **Open questions and constraints:** Identify undecided methods, missing inputs, and assumptions that could change the route, with a way to resolve them where known.
- **Sources:** Link the research materials supporting the overview rather than reproducing them.

Keep methods at the level needed to understand the scientific approach, such as comparisons, controls, or evaluation criteria.
Keep code changes, commands, implementation task lists, and live execution status outside this overview.
Label the route as proposed and all expected outputs as prospective; preserve uncertainty rather than inventing methods, thresholds, results, or novelty claims.
Use as many stages as the research needs, without imposing a fixed sequence or requiring every question to be settled before the overview can exist.

**Done:** Each stage has all four elements, its place in the route is clear, and every scientific assertion is either source-grounded or explicitly prospective or unresolved.

## 3. Write the plan and discovery pointer

Write `RESEARCH-PLAN.md` at the target project root.
On subsequent manual invocations, update the same file to express the current research intent and route, preserving relevant user-authored material and resolving conflicting proposals with the user.
Keep actual findings in their existing manuscript or research records and reference them where they affect the plan.
Keep task progress in the project's issue tracker rather than creating a second execution ledger.

Add or update one sentence in the target project's root `AGENTS.md`, in the project's language, equivalent to:

> Before interpreting the project's research goals or planning research work, read [RESEARCH-PLAN.md](RESEARCH-PLAN.md) for the current research intent and proposed stages; the plan itself does not authorize execution.

Create `AGENTS.md` with this pointer if absent; otherwise preserve unrelated guidance and maintain a single pointer.
Reading the plan does not trigger this skill or an automatic plan update; updates require another manual invocation.

**Done:** The root plan expresses the current agreed direction and `AGENTS.md` contains one resolving discovery pointer.

## 4. Verify and report

Read the written files and check that the research question, motivation, contribution, scope, stages, and unresolved questions match the discussion.
Verify every stage's question, method, expected output, and progression condition, and check that plans and hypotheses are distinguishable from established findings.
Check that local source links and the discovery pointer resolve, and that unrelated agent guidance is preserved.
Report missing source access or broken references as gaps rather than implying they were verified.

**Done:** Report links to the plan and agent pointer, summarize whether this was a creation or update, and identify any remaining research decisions or evidence gaps.
