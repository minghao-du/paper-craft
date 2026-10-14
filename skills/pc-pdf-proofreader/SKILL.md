---
name: pc-pdf-proofreader
description: Sentence-by-sentence proofreading of journal PDF galley proofs, restricted to objective typos and formatting errors without stylistic rewriting.
disable-model-invocation: true
---

# /pc-pdf-proofreader

Perform proof-stage sentence-by-sentence review of academic journal PDF proofs. Focus exclusively on objective typos, typesetting errors, and grammatical corrections, while preserving original phrasing and author voice.

## Protocol

1. **Systematic Extraction**:
   - Process the document page by page and paragraph by paragraph using `pdf-navigator` MCP tool if available, or direct PDF reading tools.
   - If PDF tools are missing, inform the user to install or configure the `pdf-navigator` MCP tool.

2. **Permissible Corrections Only**:
   - **Allowed**:
     - Spelling mistakes, typographical errors, and dropped characters.
     - Punctuation errors and quotation mark orientation.
     - Capitalization discrepancies.
     - Minor typesetting artifacts (hyphenation errors, broken font characters, bad line wraps).
     - Subject-verb agreement and clear grammatical errors.
   - **Forbidden**:
     - Stylistic rephrasing or rewording for flow.
     - Modifying scientific terminology or notation.
     - Altering sentence length or structure where grammatically sound.
     - Any modification that could alter author intent or scientific claim.

3. **Author Byline & Contributions Cross-Check**:
   - If an author contributions section exists (e.g., CRediT statement), cross-reference it against the main author byline:
     - Verify every author in the byline is assigned contributions.
     - Verify every person mentioned in contributions appears in the byline.
     - Account for initials vs. full names; flag missing authors.

4. **Report Format**:
   Deliver a structured correction list for direct transmission to the journal production editor:
   - **Page `<P>`, Column `<C>`, Paragraph `<N>`, Line `<L>`**:
     - **Original**: `"<exact text with error>"`
     - **Correction**: `"<exact replacement text>"`
     - **Error Type**: Typo / Punctuation / Grammar / Typesetting / Author metadata
