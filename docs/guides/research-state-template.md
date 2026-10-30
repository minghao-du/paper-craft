# Research-state report examples

Optional starting points for the [research-state convention](research-state.md).
Choose headings for the actual work; use only what helps report progress.

## Project entry

```markdown
# Research state — <Project>

<Project goal, current progress and important findings.>

- [Simulation](simulation/README.md): summary complete; power evaluation pending rerun.

<Open questions and next steps.>
```

## Directory report

```markdown
# Statistics

Repository: <repository-name> — <absolute-repository-root>
Scripts root: workflow/scripts/
Directory: simulation/statistics/

Summary complete; power evaluation awaits missing replicates.

## Summary calculation

Aggregated 100 simulations; three replicates have missing outputs.
Script: workflow/scripts/simulation/statistics/calculate_summary.py
Rule: workflow/rules/simulation.smk — calculate_summary
Inputs/configuration: <data identifiers and result-relevant settings>
Result: results/simulation/summary.tsv
Run: <run ID, code version, command and evidence location>

## Power evaluation

First pass complete. Results require verification after the three missing
replicates are rerun. Next: complete the replicates and repeat the calculation.
Evidence: <specific run and output locations>

[Generation report](../generation/README.md)
```

## Separate report when needed

A long step or independently preserved experiment may move to a descriptively
named report linked from its directory README. Keep its work, results, current
status and evidence together; replace the README's detailed content with a short
summary and link. Use the same flexible format as a directory report.
