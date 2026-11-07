# Research report requirements and default template

## Reading contract

A reader uninvolved in the analysis must be able to understand its questions, scope, findings, supporting evidence, interpretation, limits, and implications through research-state reports alone. Raw artifacts are the route for audit, reproduction, or further investigation. A file inventory or an instruction to inspect outputs does not fulfill this contract.

Include information whose omission would change the reader's understanding, decisions, or ability to avoid repeating a ruled-out route. This includes consequential negative findings, failed approaches, counterexamples, subgroup differences, and evidence that changed a conclusion. Leave routine debugging, repeated output rows, and incidental execution detail at their sources. Detail is governed by research meaning rather than a word limit.

## Default report structure

Cover the following content wherever applicable. Adapt, merge, or split headings to suit the analysis; state shared conditions once. Omit inapplicable content, but identify missing consequential information explicitly. Use the project's language.

### 1. Core conclusions

Answer the research questions directly, with the principal findings, decisive quantitative or qualitative evidence, and the most consequential limitation. State whether the analysis is complete, partial, or planned. A summary or parent report must convey substantive findings even when details live in linked child reports.

### 2. Questions and scope

Explain the motivation and specific questions. Identify the data and research objects, inclusion/exclusion boundaries, relevant sample or group sizes, comparisons, and conditions covered. Make clear which questions or populations remain outside the analysis.

### 3. Methods and basis for judgment

Explain how the findings were obtained at the depth needed to assess their meaning: influential filtering and transformations, comparison design, baselines or controls, relevant parameters, assumptions, and criteria used to evaluate outcomes. Explain choices where they affect interpretation. Keep operational setup and command details in the reproduction entry.

### 4. Detailed results

Organize by research question or finding. Each principal finding must connect:

- **Observation:** What was actually found, including consequential negative or inconsistent outcomes.
- **Evidence:** The actual values or qualitative observations supporting it. For quantitative comparisons, supply comparison values, units, relevant sample sizes or denominators, and baseline/reference definitions; report magnitude and uncertainty when needed to interpret the claim and available in the evidence. A significance label alone is insufficient.
- **Conditions:** The data, groups, methods, parameters, or run differences under which it holds. Refer to shared conditions instead of repeating them.
- **Meaning:** The caller's interpretation, what the evidence supports, and what remains an inference or cannot be concluded.
- **Exceptions and uncertainty:** Important subgroup differences, counterexamples, competing explanations, or evidence gaps.
- **Source:** The specific table, figure, artifact, and run supporting the finding, with an identifiable location within large artifacts.

These are content requirements, not six mandatory subheadings per finding. Use tables, figures, or prose as appropriate, and explain the patterns that matter so the reader need not interpret raw outputs unaided. Derive statements only from available evidence; identify missing measurements rather than inventing values or requiring unapproved new analyses.

### 5. Integrated interpretation

Explain how the findings relate to each other and answer the overall questions. Separate observations from interpretations and conclusions. Describe convergence, contradictions, alternative explanations, and consequential revisions to prior conclusions. A linked child report can hold full detail; the parent supplies the synthesis.

### 6. Limits and unresolved questions

State uncertainty, applicability boundaries, conflicting evidence, missing inputs, and unanswered questions, including their effect on confidence or decisions. Distinguish an observed lack of effect from an analysis unable to establish an effect. Make evidence access and verification gaps visible.

### 7. Implications and agreed next steps

Explain what the results imply for research choices, including routes ruled out and why. Record agreed next steps with their rationale, dependencies, and progression conditions. Where no next step is agreed, leave the choice open; reporting does not authorize experiments.

### 8. Evidence and reproduction entry

Provide canonical artifact locations, specific run/configuration and input identities, relevant repository/code revisions, and concrete commands, scripts, or workflow targets sufficient to locate and reproduce the reported analysis. Include the working directory and environment where needed to disambiguate execution; remote references include host and path. Mark verification status and inaccessible sources. Link findings to their evidence rather than relying only on a detached source list.

## Plans and partial analyses

For plans or discussions without results, cover the questions, existing evidence, hypotheses, proposed methods, expected outputs, dependencies, progression conditions, and unresolved decisions. For staged routes, give each stage its question, method, expected output, dependencies, and progression conditions. Preserve the rationale for agreed choices and rejected routes. Expected outcomes remain prospective; result sections may be omitted until findings exist.

For partially completed analyses, distinguish observed findings from pending work and identify which questions are unanswered. As results arrive, integrate them into the relevant sections so the report expresses current understanding. When a conclusion changes, preserve the consequential earlier evidence, why the judgment changed, and any conditions where the earlier result remains valid. Retain unresolved conflicts explicitly.

## Coverage and readability check

Before declaring the update complete, compare the report with the analysis questions, scope, and major tables, figures, and other evidence artifacts, rather than checking headings alone:

- Every research question has an answer or an explicit unanswered status.
- Every finding that affects interpretation or research choices appears in the report or a linked research-state child report, including negative findings, failed approaches, exceptions, and inconsistencies.
- Key comparisons contain enough actual evidence and conditions to assess their meaning without opening raw artifacts.
- The methods, interpretations, limits, and implications form a coherent account; an uninvolved reader can understand what was learned and what remains unknown.
- Unread, inaccessible, or unverified evidence and any resulting coverage gaps are explicit. Match claims of completeness to the inspected scope.

Full detail may be distributed across research-state reports, with one authoritative location per analysis and meaningful parent syntheses. Following those links is normal reading; opening raw tables, logs, or code to discover the key findings is a missing explanation.
