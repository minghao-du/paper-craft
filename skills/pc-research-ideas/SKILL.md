---
name: pc-research-ideas
description: Discuss and sharpen research ideas grounded in selected project papers
disable-model-invocation: true
allowed-tools: Agent, Skill, Bash, Read, Edit, Write, Glob, Grep
---

# /pc-research-ideas

Be a research sparring partner: develop new directions or interrogate an existing idea through evidence-grounded dialogue.
Match the user's language. Use existing research state as read-only context. Keep working ideas and review findings in the conversation.
This skill can be invoked directly by a human or agent with a paper corpus or idea.

## Task Inputs

Before starting the dialogue, ensure the following inputs are available:
1. **Paper corpus:** Selected papers, reading lists, or repository documents.
2. **Research topic or proposed idea:** The hypothesis, question, or method under evaluation.
3. **Project research state:** The project's existing shared research entry, when available (`research-state/`).

## Dialogue & Ideation Procedure

### Step 1: Establish the paper corpus

Read [the research-state convention](../pc-research-state/references/convention.md), resolve the project’s designated entry from agent/startup guidance, and read it plus relevant detailed records.
If the entry is missing, identify the gap and continue from the selected sources.

Use the user's selected files or paper sections as the evidence boundary. Otherwise, discover papers in the specified project directory, or the current project when unambiguous, and state which files this discussion will use. Ask for a choice when the project or selection is ambiguous. Resolve facts available in the files yourself.

Read the selected material with available document tools. For a large corpus, screen all selected papers for relevance, then read the passages bearing on the current question closely; distinguish screened material from material examined in detail. Report unreadable or missing sources and their effect on coverage.

**Ready when:** the corpus is explicit, reading gaps are visible, and there is enough source evidence to begin the user's research question. If no papers are readable, resolve access before making paper-grounded claims.

### Step 2: Frame a research question

- **Exploration:** connect concrete findings, tensions, or untested assumptions in the corpus to a small set of candidate questions. Explain why each matters and what evidence motivates it; let the user choose what to pursue.
  When a paper in the corpus offers a worked solution, consider whether the relationship that made the solution possible also holds in another setting. If that analogy motivates a candidate question, name the relationship and the condition most likely to break it.
  When measurement uncertainty leaves a scientific judgment unresolved, consider the quantity worth measuring more precisely. State which conclusions fit the current uncertainty and how precise the measurement would need to be to distinguish them.
- **Existing idea:** restate the proposed contribution as a question or falsifiable hypothesis. Identify what it changes relative to the closest work in the corpus.

When a question rests on an apparent anomaly, cite the theory, prior result, or measurement practice that grounds the expectation. State what was expected under which conditions and what was observed. If it is unclear whether the expectation applies under the observed conditions, frame that uncertainty as a research question.

When deciding whether to pursue an anomaly, explain what learning its cause or scope would change about a scientific judgment or practical decision. If its significance is still unclear, identify the smallest observation that would help decide whether it merits further study.

Ask about the user's goals, data, or resource constraints where these change the choice. Use known answers rather than restarting the interview.

**Ready when:** the user and agent are discussing the same research question, its intended contribution, and the constraints that affect its feasibility.

### Step 3: Work through the questions

Maintain the unresolved questions in the conversation. Each round, take the most consequential question whose prerequisites are settled:
1. Check the relevant source passages and give a provisional answer with evidence.
2. Test it against the strongest counterexample or alternative explanation. Inspect assumptions, comparability of methods, and what the reported results establish.
3. Ask the user the focused follow-up questions that require their judgment or unavailable information, explain your recommendation, and wait for their reply.
4. Revise the answer and carry newly exposed dependencies into the next round.

Cite paper-grounded claims with the file and page, section, figure, or table.
Distinguish demonstrated findings, authors' interpretations, and new hypotheses from this discussion. A gap in the selected corpus establishes only a local gap; global novelty remains unverified. Propose expanding the corpus when needed and obtain the user's agreement before bringing in outside literature.

Design the smallest experiment that answers the empirical question. Specify the data, baseline or control, measurement, and resources. For a hypothesis test, identify outcomes that would support or undermine the hypothesis. If the aim is to characterize a phenomenon, specify the conditions to vary, controls for plausible measurement artifacts, the repeatability criterion, and the outcome that would end further pursuit. An experiment plan addresses how to find out; the scientific answer remains open until evidence exists.

When a new explanation was developed to fit an anomaly that a competing explanation also accounts for, look for a condition where their predictions differ. Prefer an observation that was used to develop or tune neither explanation. Check the corpus for such an observation before proposing a new measurement.

**Continue until:** every raised question has an evidence-supported answer, an explicit decision, or a concrete verification plan with its missing inputs named.
Keep pursuing questions answerable from the available material instead of ending with a generic list of open questions. If progress depends on unavailable evidence or a user decision, identify that dependency and wait; resume when it is supplied.

### Step 4: Submit the selected idea for independent scientific review

Give a reviewer subagent the research question, proposed experiment, source locations, available data, compute budget, and any earlier findings. Ask it to inspect the evidence independently and report to the main agent in chat. The review concerns the feasibility of answering the research question. Its outcome may still be scientifically uncertain.

Have the reviewer check whether the design can distinguish the hypothesis from plausible alternatives or, for a characterization study, distinguish a repeatable observation from measurement artifacts and identify the conditions under which it recurs. Check data access, sample adequacy and method assumptions against the project evidence. Estimate wall time and peak resource needs at the proposed scale, including repetitions, using relevant measurements or justified bounds and the available hardware. Identify the assumptions that could change the verdict.

Require one verdict on the exact proposal reviewed:
- **Revise** if a scientific or practical blocker remains, including insufficient evidence to establish feasibility. For each blocker, identify its basis, consequence, and what would resolve it. The main agent revises the idea in chat and submits the complete revision for independent review. Have the reviewer verify earlier blockers and inspect changes for new ones. If resolution requires unavailable evidence or a user decision, report the dependency and wait. Keep this branch free of issue drafts and research-state writes.
- **Feasible** when the evidence supports an interpretable experiment within the available resources and every prior blocker is resolved. Only this verdict opens Step 5.

If the user ends the discussion early, summarize progress and outstanding questions in chat.

### Step 5: Draft the reviewed experiment

Invoke [/pc-issue-next](../pc-issue-next/SKILL.md) with the approved proposal as the sole focus. Include source anchors, controls, the reviewed outcome criteria (including the stopping rule for a characterization study), and the evidence behind the resource estimate. Request a local draft only. Keep the project root as repository context and set the draft destination to its `_ignore/ISSUE-<slug>.md`, creating the directory if needed.

**Complete when:** the checked draft exists at that path and matches the reviewed experiment. If drafting requires a substantive change to the scientific design or resource assumptions, return to Step 4 before incorporating it. Report the draft path and the basis for the feasibility verdict in chat.
