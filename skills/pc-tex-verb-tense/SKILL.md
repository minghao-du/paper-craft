---
name: pc-tex-verb-tense
description: Review LaTeX manuscripts for section-specific verb tense consistency and scientific writing standards.
disable-model-invocation: true
---

# /pc-tex-verb-tense

Audit LaTeX manuscripts for verb tense correctness and consistency according to scientific publication standards.

## Section-Specific Tense Rules

| Section | Target Tense | Rationale |
|---|---|---|
| **Abstract** | Past & Present | Past for work performed and findings observed; present for conclusions and overarching significance. |
| **Introduction** | Present & Past | Present for established scientific knowledge and general principles; past for prior published studies ("Smith et al. demonstrated..."). |
| **Methods** | Past | Past tense for all procedures, data generation, simulations, and experimental executions ("We sequenced...", "Samples were incubated..."). |
| **Results** | Past & Present | Past tense for specific measurements, observations, and statistical outcomes ("The model achieved...", "Expression decreased..."); present tense for direct references to figures and tables ("Figure 2 illustrates...", "Table 1 lists..."). |
| **Discussion** | Present & Past | Past when referencing study results; present when discussing interpretation, implications, limitations, and future directions. |

## Audit Procedure

1. **Scan Line by Line**:
   - Inspect main clauses and subordinate clauses for tense shifts within paragraphs.
   - Disregard TeX macros, equations, citations, and figure references while evaluating verbs.
2. **Flag Inconsistencies**:
   - Abrupt shifts between past and present when describing the same experimental procedure or result.
   - Improper use of future tense (reserve future tense strictly for prospective future work).
   - Passive/active verb conflicts that cause temporal ambiguity.
3. **Report Format**:
   For each finding:
   - **Line `<N>` / Section**: `<Context>`
   - **Original**: `<Problematic text>`
   - **Correction**: `<Target correction>`
   - **Rule**: Section-specific tense rule applied.
