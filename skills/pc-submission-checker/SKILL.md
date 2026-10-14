---
name: pc-submission-checker
description: Pre-submission quality checks for manuscripts — verify repository accessibility, preprint publication status, and bibliographic completeness.
disable-model-invocation: true
---

# /pc-submission-checker

Perform pre-submission quality checks for scientific manuscripts across repositories, preprint status, and bibliographic completeness.

## Audit Checklist

### 1. Repository Accessibility
- Identify all repository URLs (GitHub, GitLab, Zenodo, Figshare, OSF, etc.) cited in the manuscript.
- Verify each repository is publicly accessible (not private, 404, or authentication-gated).
- Check that links route to the intended repository and branch/release.
- Verify repositories contain necessary documentation (README, installation instructions, license).
- Confirm code and data assets match descriptions and claims in the paper text.
- Flag missing, incomplete, or unpopulated repositories.

### 2. Preprint Publication Status
- Identify all preprint citations (arXiv, bioRxiv, medRxiv, ChemRxiv, etc.).
- Search bibliographic databases (Crossref, PubMed, Google Scholar) to determine if cited preprints have appeared in peer-reviewed journals.
- For published papers: provide the formal journal citation details (journal name, volume, pages, year, DOI) to replace preprint citations.
- Flag preprints that remain unpublished.

### 3. Bibliographic Completeness
- Review all bibliography entries for mandatory fields: authors, title, journal/venue, volume, issue, page numbers, year, and DOI/URL.
- Check that all DOIs resolve properly (`https://doi.org/<DOI>`).
- Flag abbreviated or inconsistent journal naming conventions.
- Ensure 1:1 correspondence: every in-text citation must appear in the bibliography, and every bibliography entry must be cited in the text.

### 4. Language and Style Checks
- Flag "our work" and replace with "our study" or specific project nouns where journal conventions require formal terminology.
- Flag informal idioms or subjective expressions in methods and results sections.

## Report Structure

Format the evaluation report with explicit statuses:
- `[PASS]` Check satisfied
- `[WARN]` Potential issue or missing optional item
- `[FAIL]` Blocker requiring correction before journal submission

For every `[WARN]` or `[FAIL]`, provide:
1. **Location**: Section, page, or citation key.
2. **Finding**: Exact discrepancy or inaccessible link.
3. **Required Action**: Concrete correction (e.g., exact BibTeX replacement or link update).

Conclude with a bulleted punch list of critical items that must be resolved prior to submission.
