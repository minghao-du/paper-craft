# Research report requirements and default template

## Reading contract

A reader uninvolved in the analysis must be able to understand why the research was done, what data were used, how the scientific analysis worked, what was found, and what it means through research-state reports alone. Write a detailed scientific paper or report without a fixed length limit. Linked chapters form one continuous scientific account; reading code or interpreting raw outputs must not be necessary to discover the key findings.

Include information whose omission would change the reader's understanding, decisions, or ability to avoid repeating a ruled-out route. Apply the convention's replacement and retention rules to earlier findings and failed approaches. Detail is governed by scientific meaning: explain important negative findings, counterexamples, subgroup differences, and uncertainty, while pruning obsolete history and repeated explanations.

## Default report structure

Cover the following content across the report wherever applicable. Adapt, merge, or split headings to suit the analysis; state shared data, methods, and conditions once and link to them. Chapters need not each repeat the whole structure. Omit inapplicable content, but identify missing consequential information explicitly. Use the project's language.

### 1. Core conclusions

Answer the research questions directly, with the principal findings, decisive quantitative or qualitative evidence, and the most consequential limitation. State whether the analysis is complete, partial, or planned. A summary or parent report must convey substantive findings even when details live in linked child reports.

### 2. Questions and scope

Explain the motivation and specific questions. Describe the actual data sources and research objects, data versions where relevant, inclusion/exclusion criteria, relevant sample or group sizes, comparisons, and conditions covered. Distinguish required data for planned work from data already analyzed. Make clear which questions or populations remain outside the analysis; a technical input-file inventory is unnecessary.

### 3. Methods and basis for judgment

Explain how the findings were obtained at the depth needed to assess their meaning: influential filtering and transformations, variable definitions, model or statistical formulation, comparison design, baselines or controls, relevant parameters and thresholds, replication, assumptions, and criteria used to evaluate outcomes. Explain choices where they affect interpretation. Describe scientific procedures in prose, equations, or diagrams as appropriate; keep commands, script relationships, environment setup, and scheduling in pipeline documentation.

### 4. Detailed results

Organize by research question or finding. Each principal finding must connect:

- **Observation:** What was actually found, including consequential negative or inconsistent outcomes.
- **Evidence:** The actual values or qualitative observations supporting it. For quantitative comparisons, supply comparison values, units, relevant sample sizes or denominators, and baseline/reference definitions; report magnitude and uncertainty when needed to interpret the claim and available in the evidence. A significance label alone is insufficient.
- **Conditions:** The data, groups, methods, parameters, or run differences under which it holds. Refer to shared conditions instead of repeating them.
- **Meaning:** The caller's interpretation, what the evidence supports, and what remains an inference or cannot be concluded.
- **Exceptions and uncertainty:** Important subgroup differences, counterexamples, competing explanations, or evidence gaps.
- **Source:** A concise citation to the supporting table, figure, or artifact, with a specific location within large sources and a version or analysis batch when needed to disambiguate results. Related findings may share a source note.

These are content requirements, not six mandatory subheadings per finding. Use tables, figures, or prose as appropriate, and explain the patterns that matter so the reader need not interpret raw outputs unaided. Derive statements only from available evidence; identify missing measurements rather than inventing values or requiring unapproved new analyses.

### 5. Integrated interpretation

Explain how the findings relate to each other and answer the overall questions. Separate observations from interpretations and conclusions. Describe convergence, contradictions, and alternative explanations. Include a revision to a prior conclusion only when it still matters under the retention rules. Detailed chapters supply the evidence; the integrated discussion supplies the synthesis without repeating the results section.

### 6. Limits and unresolved questions

State uncertainty, applicability boundaries, conflicting evidence, missing inputs, and unanswered questions, including their effect on confidence or decisions. Distinguish an observed lack of effect from an analysis unable to establish an effect. Make evidence access and verification gaps visible.

### 7. Implications and agreed next steps

Explain what the results imply for research choices, including routes ruled out and why. Record agreed next steps with their rationale, dependencies, and progression conditions. Where no next step is agreed, leave the choice open; reporting does not authorize experiments.

### 8. Evidence citations

Place lightweight source links or citations beside findings or in figure/table notes. Identify the actual evidence, adding data versions or analysis batches when needed; make remote references unambiguous. Mark verification status and access gaps without repeating identical notes for every result. A separate source list is optional, and an engineering reproduction section is not required. The report itself explains the key observations and scientific meaning; sources support checking them rather than supplying omitted explanations.

## Plans and partial analyses

For plans or discussions without results, cover the questions, existing evidence, hypotheses, proposed methods, expected scientific outcomes, dependencies, progression conditions, and unresolved decisions. For staged routes, give each stage its question, method, expected outcome, dependencies, and progression conditions. Explain the rationale for current agreed choices; retain rejected routes only under the convention's retention rules. Expected outcomes remain prospective; result sections may be omitted until findings exist.

For partially completed analyses, distinguish observed findings from pending work and identify which questions are unanswered. As results arrive, integrate them into the relevant sections and replace fulfilled prospective descriptions with the actual methods and findings. Apply the convention's replacement and retention rules to changed conclusions; preserve valid condition-specific findings and unresolved conflicts.

## Coverage and readability check

Before declaring the update complete, compare the report with the analysis questions, scope, and major tables, figures, and other evidence artifacts, rather than checking headings alone:

- Every research question has an answer or an explicit unanswered status.
- Every current finding that affects interpretation or research choices appears in the report or a linked chapter, including negative findings, exceptions, inconsistencies, and still-relevant lessons from failed approaches.
- Key comparisons contain enough actual evidence and conditions to assess their meaning without opening raw artifacts.
- The methods, interpretations, limits, and implications form a coherent account; an uninvolved reader can understand what was learned and what remains unknown.
- Unread, inaccessible, or unverified evidence and any resulting coverage gaps are explicit. Match claims of completeness to the inspected scope.
- Superseded values, obsolete plans, and duplicated detail have been removed from affected chapters, tables, captions, and summaries; retained earlier material has a current purpose under the retention rules.

Full detail may be distributed across research-state reports, with one authoritative location per analysis and meaningful parent syntheses. Following those links is normal reading; opening raw tables, logs, or code to discover the key findings is a missing explanation.
