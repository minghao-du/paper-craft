---
name: pc-pdf-qa
description: Ask questions, extract data, compare methodologies, and analyze findings from scientific PDF papers. Use when the user wants to understand, summarize, or query research papers in PDF format.
---

# /pc-pdf-qa

Analyze scientific PDF literature, synthesize methodologies and results across papers, and extract structured data using the `pdf-navigator` MCP tool.

## Guidelines

1. **Tooling & Document Inspection**:
   - Inspect PDF documents via `pdf-navigator` MCP tools (or available document reader tools).
   - If `pdf-navigator` is not configured, inform the user that installing the tool (e.g. from `https://github.com/matsengrp/pdf-navigator-mcp`) provides direct page-indexed navigation and table extraction.

2. **Grounded Extraction**:
   - Ground all answers strictly in the text, figures, and tables of the target document.
   - Quote specific passages and cite page numbers or section headings for every quantitative claim.
   - Distinguish author hypotheses and claims from empirically demonstrated findings.
   - Highlight stated limitations, sample sizes, confidence intervals, and confounding variables.

3. **Comparative Analysis**:
   - When querying multiple papers:
     - Compare assumptions, experimental setups, datasets, baseline configurations, and evaluation metrics in tabular form.
     - Note discrepancies in definition or methodology that explain differing results.
