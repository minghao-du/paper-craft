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
Distinguish established findings from proposed hypotheses.

When intent or key research choices are missing, ask focused questions with recommendations and wait for the user's answers.
Ask about choices that change which research question to pursue. Empirical questions can remain open.

**Done:** The research objective and scope are shared with the user, and unresolved scientific questions are explicit enough to describe a proposed route.

### Step 2: Shape the overview

Organize the plan around these elements, adapting headings to the project:
- **Research question and motivation:** What the project will investigate, why it matters, and the evidence motivating it.
- **Intended contribution and scope:** What the research aims to clarify and which questions it covers.
- **Existing findings:** Where results are available, summarize what was observed and the actual method and evidence needed to interpret it.
- **Proposed work:** For each idea that has yet to be carried out and has no results, write only one or two sentences stating what to investigate and why it matters. A scientific comparison can express the idea. Do not turn it into an implementation plan with procedures, parameter settings, deliverables, or conditions for moving to another stage.
- **Open questions and constraints:** Include uncertainties or constraints that affect the scientific direction.
- **Sources:** Link the research materials supporting the overview rather than reproducing them.

Apply this distinction within each research question, including when a finding motivates further work. For example, “We propose comparing divergence-time estimates with and without a mass-extinction event to assess how sensitive the inferred dates are to that assumption.”

**Done:** A reader can identify the evidence behind existing findings and the scientific idea behind each proposed direction.

### Step 3: Update the shared research state

Give the agreed route and sources to [/pc-research-state](../pc-research-state/SKILL.md) for writing into the same entry, with detail linked only when complexity warrants it.
Preserve relevant findings, interpretations, and useful unfinished discussion; keep each full analysis in one place.
Stop maintaining a parallel `RESEARCH-PLAN.md`; existing materials are inputs, not a second authority.
Keep task progress in the original task system.
Add or update the discovery sentence from the convention in related repository/startup guidance, resolving to the same absolute entry from every checkout and preserving unrelated instructions.
A recorded plan does not authorize research execution.

**Done:** The shared state expresses the agreed route and related guidance resolves to its unique entry.

### Step 4: Verify and report

Read the updated state against the agreed question, motivation, contribution, scope, and open questions. Check each proposed passage against Step 2, including follow-ups embedded in sections with results. Condense any implementation detail introduced during writing.
Check that local source links and the discovery pointer resolve, and that unrelated agent guidance is preserved.
Report missing source access or broken references as gaps rather than implying they were verified.

**Done:** Report links to the research entry and discovery pointer, summarize whether this was a creation or update, and identify any remaining research decisions or evidence gaps.

## Quality Requirements & Completion Criteria

1. **Epistemic honesty:** Hypotheses are clearly distinguished from established evidence.
2. **Pointer resolution:** Discovery pointer in repository guidance resolves to the canonical research entry.

## Task Outputs

1. **Research plan entry:** Written or updated plan in the designated research state via `/pc-research-state`.
2. **Summary:** Research direction, open questions, and discovery pointer.
