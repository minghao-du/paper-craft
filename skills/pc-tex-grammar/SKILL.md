---
name: pc-tex-grammar
description: Check grammar line by line in LaTeX files. Use when editing or reviewing LaTeX manuscripts, papers, or thesis chapters for grammatical accuracy and syntactic correctness.
---

# /pc-tex-grammar

Perform line-by-line grammar review of LaTeX documents, preserving formatting and mathematical expressions.

## Methodology

1. **Text vs. Markup Separation**:
   - Parse prose while treating LaTeX macros, math delimiters (`$...$`, `\[...\]`, equation environments), citations (`\cite{...}`), and cross-references (`\ref{...}`) as immutable tokens.
   - Do not modify or alter TeX macros, math formulas, or reference keys.

2. **Grammar Checks**:
   - Subject-verb agreement.
   - Pronoun-antecedent agreement and ambiguous pronoun references ("this shows...", "which means...").
   - Dangling and misplaced modifiers.
   - Comma splices, run-on sentences, and sentence fragments.
   - Parallel construction in lists and coordinated clauses.
   - Proper prepositional usage and academic collocation patterns.

3. **Output Format**:
   For each line with grammatical defects, report:
   - **Line `<N>`**: `<original line>`
     - **Issue**: Precise grammatical defect.
     - **Correction**: Exact replacement text.
     - **Explanation**: Reason for change.

   If a checked section contains no grammatical errors, state: `No grammatical issues detected.`
