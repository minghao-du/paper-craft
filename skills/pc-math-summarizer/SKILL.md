---
name: pc-math-summarizer
description: Summarize computational and statistical pull requests into mathematical markdown documentation with LaTeX formulations.
disable-model-invocation: true
---

# /pc-math-summarizer

Analyze pull requests containing statistical or mathematical code, notebooks (`.ipynb`), and algorithms to produce standalone mathematical documentation with formal LaTeX notations.

## Process

1. **Analyze PR Content**:
   - Inspect `.ipynb` notebooks, computational modules, and statistical scripts in the diff.
   - Distinguish standard library calls from custom statistical formulations, custom objective functions, distance metrics, and sampling schemes.
   - Ignore basic boilerplate and well-known unaugmented algorithms (e.g., standard k-means or unweighted Euclidean distance). Focus specifically on novel algorithms, modified metrics, and custom statistical models.

2. **Formulate Mathematical Documentation**:
   - Write for PhD-level researchers in computational biology and quantitative disciplines.
   - Formulate algorithms formally using standard LaTeX math blocks (`$$...$$` and `$..$`).
   - For custom metrics and novel methods, provide:
     - Mathematical definitions and parameter domains.
     - Formal metric or algebraic properties (e.g., triangle inequality, symmetry, asymptotic bounds).
     - Algorithmic steps and objective optimization rules.
     - Theoretical rationale and assumptions behind the approach.
   - For visualizations and plots: explain the underlying mathematical quantity or matrix visualized (e.g., pairwise distance matrices, empirical cumulative distributions).

3. **Output Format**:
   - Generate an overview summary suitable for a top-level PR comment highlighting mathematical contributions across the diff.
   - For each major computational file (e.g., `path/to/analysis.ipynb`), generate a paired markdown document (`analysis.md`) structured as:
     - **Overview**: High-level problem formulation and goal.
     - **Mathematical Framework**: Definitions, variables, loss functions, and probabilistic formulations.
     - **Key Methods & Algorithms**: Step-by-step mathematical procedures.
     - **Implementation Notes**: Alignment between math symbols and codebase identifiers.
