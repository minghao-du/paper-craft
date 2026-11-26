---
name: pc-group-meeting-slides
description: Create or update slides for a weekly research group meeting (组会汇报) from project results, processed data, and research-state records.
---

# Weekly group meeting slides

Work from the project root. Use `_ignore/slides/` as the working deck directory. Look there even if Git ignores it. Update the existing deck in its native format and language, preserving useful slides, annotations, and figures. If the user supplies a previous deck elsewhere, use it as the starting point for the working copy. For a first report, create a locally runnable Chinese Slidev deck with preview/build scripts. Use theme-minghao when available to the project, including its layouts and live drawing tools as useful. Otherwise use a portable Slidev theme.

## Select the evidence

Start with the questions left open at the last meeting. Read the project's designated research-state entry and follow relevant records into `results/` and `processed/`. Identify the runs, cohorts, filters, metrics, and baselines behind each proposed comparison. Verify numerical claims against the underlying outputs. When records disagree, check whether versions or populations explain the difference. Show a material unresolved discrepancy as a question with the evidence for each reading.

Review the old deck against this evidence. Keep enough context for colleagues to interpret the update. Replace or remove superseded results and revise any later slides that depend on them. If a previously presented error changes the group's understanding, put a short correction beside the new evidence. Correct the presentation within the deck directory.

Include a result when it answers a live question, changes confidence in a conclusion, explains a failure, or affects the next experiment. Omit repetitive runs and incidental diagnostics. A null result or failed experiment can deserve several slides when it changes the decision.

When the same method is applied to several datasets, cohorts, or conditions, choose one representative case and show its figures and tables in enough detail for colleagues to understand how to read the analysis. Summarize the other cases in text, naming each case and giving its actual outcome. Group cases with similar findings and include key values when they clarify the comparison. State any exception explicitly. Add a targeted figure for an exception only when the group needs to discuss the difference.

## Plan and write the weekly deck

For a new deck or a weekly update, follow the outline and authoring steps below even if the resulting changes fit on one or two slides. For an explicitly targeted edit (such as correcting a unit or enabling table scrolling), edit the working deck directly and verify the change.

1. The main agent independently drafts one outline around the group's scientific questions, changes in conclusions, quantitative comparisons, and material exceptions. Identify the representative case, evidence, and discussion point for each topic. Present the outline to the user and wait for explicit approval. If the user requests changes, revise the outline and resubmit it for approval.
2. Once the user explicitly approves the current outline, the main agent alone writes or updates the deck in `_ignore/slides/`, prepares its figures, tables, and scripts, and verifies the finished presentation.

## Build for discussion

Organize each topic around the group's question, the evidence, and what remains open. Use a precise finding or unresolved question as the slide title. Prefer plots for distributions and trends, compact tables for exact comparisons, and representative images for qualitative differences. Put units, sample sizes, and comparison conditions beside the visual wherever they affect interpretation.

Use as few words as the evidence allows, with no character or slide limit. Give an important result enough room for an overview, a subgroup comparison, or a diagnostic example as warranted. Omit speaker notes and narration. Put any qualification needed to interpret a finding beside the evidence. Use familiar research terminology and explain ambiguous metrics in place. End at the concrete question or decision the evidence supports.

Make the comparison and its main finding or question apparent at a glance on the first screen. Let the discussion question determine the layout and page break. In an interactive deck, keep related evidence together at a legible size even when it extends below the first screen. For example, place the overall trend above its subgroup table on the same page. Reuse the template's vertical scrolling or enable it on the content area. Give wide tables a horizontal scroll area and oversized images a pannable viewport when fine detail matters. For fixed-page formats, continue the figure or table on another page at readable scale.

Reuse trustworthy project figures and extraction code. When generating figures or extracting tables, save reusable scripts in `_ignore/slides/scripts/`; keep the resulting figures and tables with the deck. Resolve inputs relative to the project and outputs relative to the deck. Keep source paths, run selections, and the reproduction command with each extraction or plotting script. Credit reused project outputs in a short caption when needed for identification. Generate measured values and scientific plots from the data.

## Verify and deliver

Run changed extraction and plotting scripts, check displayed values against their sources, then build Slidev or render the existing format. Open the changed pages in presentation view and check images and labels at viewing size. On interactive pages, scroll to the bottom, move wide tables to the last column, and pan large figures to their edges. Confirm the last row, axis labels, and legends are reachable and legible. Deliver the deck path and how to open or preview it. Deliver the interactive deck by default. When a PDF is requested, paginate scrollable content and inspect the exported pages for complete rows, columns, and figures. Mention material corrections and unresolved evidence that the group should discuss.
