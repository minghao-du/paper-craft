---
name: pc-tex-topic-sentence
description: Analyze LaTeX paragraph structure and ensure each paragraph opens with a clear, informative topic sentence.
disable-model-invocation: true
---

# /pc-tex-topic-sentence

Analyze and refine paragraph structure in LaTeX documents so that reading only the first sentence of each paragraph communicates the logical flow and core arguments of the paper.

## Two-Phase Workflow

### Phase 1: Analysis and `%CC` Annotation

Read each paragraph in the document:
1. Identify the primary claim or informational payload of the paragraph.
2. Evaluate whether the opening sentence clearly states that claim:
   - **Pass**: If the first sentence already states the main idea, take no action (do NOT insert extraneous comments).
   - **Needs Revision**: If the lead sentence is weak, buries the core claim in the middle or end, or acts as a coy announcing sentence ("A comparison is needed"), formulate a concrete revision.
3. Insert a `%CC` LaTeX comment directly above or at the target sentence with specific, actionable instructions:
   - `%CC Move core conclusion from end of paragraph to opening sentence.`
   - `%CC Split paragraph here; discussion transitions from model training to inference benchmarking.`
   - `%CC Replace announcing opening sentence with explicit claim: [suggested sentence].`

### Phase 2: Implementation (When Requested)

When instructed to apply suggested changes:
1. Parse all `%CC` structural comments.
2. Refactor paragraphs to place the lead claim in the first sentence.
3. Ensure transitions between paragraphs remain coherent.
4. Preserve all technical terminology, citations, and mathematical formulas verbatim.
5. Remove the resolved `%CC` comments.

## Quality Standards

- **Scannability**: The sequence of opening sentences alone must form an intelligible executive summary of the section.
- **No Delayed Payoffs**: Avoid building up to a dramatic reveal at the paragraph's close. Put the result first; follow with supporting evidence, caveats, and details.
- **One Theme Per Paragraph**: If a paragraph addresses two distinct claims, split it.
