---
name: pc-pipeline-snakemake
description: Review, scaffold, and optimize Snakemake workflows adhering to modular rule design, fail-fast schema validation, and tiered data hygiene (processed/, results/, logs/, summary/).
---

# /pc-pipeline-snakemake

Guidance, scaffolding, and auditing for Snakemake workflows adhering to official best practices and reproducible execution standards.

## Standard Directory Layout

A production Snakemake workflow strictly separates version-controlled orchestration and configuration from ephemeral, generated data assets:

```text
.
├── config/
│   ├── config.yaml              # Production execution parameters and path variables
│   ├── schema.yaml              # JSONSchema parameter validation specification
│   └── test.yaml                # Minimal test dataset parameters for CI
├── workflow/
│   ├── Snakefile                # Workflow entry point and target rule (rule all)
│   ├── rules/                   # Modular rule definitions (*.smk)
│   │   ├── align.smk
│   │   └── qc.smk
│   ├── envs/                    # Isolated conda / container definitions (*.yaml)
│   │   └── samtools.yaml
│   ├── scripts/                 # Standalone execution scripts (Python / R / Bash)
│   │   └── parse_output.py
│   └── report/                  # HTML report captions and markdown descriptions
├── data/                        # Raw, immutable input data (read-only; never written to by rules)
├── processed/                   # Intermediate staged artifacts (cleaned, aligned, intermediate tables; gitignored)
├── results/                     # Final deliverables (publication figures, summary tables, reports; gitignored)
├── logs/                        # Standard output & error logs partitioned per rule (gitignored)
├── summary/                     # Stage-level text receipts & interface contracts for human & agent (tracked in Git)
└── resources/                   # (Optional) Shared reference files, genomic indexes, or databases
```

## Quality Standards

### 1. Tiered Data Hygiene & Directive Contracts
- **Log Directive Contract**: Every non-trivial rule must specify a `log:` directive partitioned by rule name and wildcard (e.g., `log: "logs/{rule}/{sample}.log"`). In `shell:`, capture standard streams explicitly: `> {log} 2>&1`.
- **Intermediate Artifacts (`processed/`)**: Route all intermediate and staged transformations to `processed/`. Mark temporary artifacts with `temp()` so Snakemake removes them immediately after downstream consumers finish.
- **Deliverables (`results/`)**: Route final analytical summaries, plots, and reports to `results/`. Apply `protected()` on high-cost terminal deliverables to guard against accidental deletion.
- **Stage Summary Receipts (`summary/`)**: Each analytical stage or module must produce a lightweight, machine-generated markdown receipt in `summary/{stage}.md` via its stage aggregation rule. Unlike `processed/` and `results/`, `summary/` is explicitly tracked in Git, decoupling compute-heavy environments from local inspection. It captures 4 standard sections (Executive Summary, Attrition & Data Shape, Downstream Interface Contract with Schema & Head Preview, and Deliverables & Figures; see [summary.md](templates/summary.md)). All paths inside summaries must use project-root-relative paths.
- **Immutability of `data/` and `workflow/`**: Treat `data/` as read-only. Confine all output definitions strictly within `processed/`, `results/`, `logs/`, or `summary/`. Never write outputs to `workflow/`.

### 2. Fail-fast Parameter Validation
- **Schema-Enforced Configuration**: Validate parameters at startup in `workflow/Snakefile` using `snakemake.utils.validate(config, schema="../config/schema.yaml")`.
- **Fail-Fast Error Reporting**: Enforce required configuration keys, expected types, and value constraints through JSONSchema in `config/schema.yaml`.
- **Parametrized Directory Roots**: Define data roots in `config/config.yaml` rather than hardcoding filesystem paths inside rule definitions.

### 3. Modular Architecture & Rule Design
- **Single-Responsibility Rules**: Split workflows by analytical stage into `workflow/rules/*.smk` and include them in `workflow/Snakefile` via `include:`.
- **Isolated Script Logic**: Extract multi-line data manipulation, parsing, or transformation routines into `workflow/scripts/` and invoke via `script: "scripts/foo.py"`.
- **Strict Wildcards**: Constrain wildcard scope with `wildcard_constraints:` globally or per rule to ensure deterministic DAG resolution.
- **Resource Scaling**: Declare `threads:` and dynamic `resources:` (e.g., `mem_mb=lambda wildcards, attempt: attempt * 4096`) per rule to support dynamic scaling across local or cluster execution.

### 4. Environments & Reproducibility
- **Rule-Level Isolation**: Declare isolated environment definitions per rule via `conda: "envs/foo.yaml"` or `container:`. Pin explicit software versions inside environment files.
- **Automated Linting & Formatting**: Format files using `snakefmt` and run `snakemake --lint` to verify adherence to syntax standards.

## Workflows

### Branch 1: Workflow Scaffolding (Authoring)

When generating a new Snakemake workflow or expanding an existing one:

1. **Scaffold Directory Tree**: Create standard directories (`config/`, `workflow/rules/`, `workflow/envs/`, `workflow/scripts/`, `data/`, `processed/`, `results/`, `logs/`, `summary/`).
2. **Establish Git Hygiene**: Read [gitignore.template](templates/gitignore.template) to create the project `.gitignore`. Ensure `processed/`, `results/`, and `logs/` are gitignored while `summary/` is tracked.
3. **Configure & Schema**:
   - Read [schema.yaml](templates/schema.yaml) as a reference to write `config/schema.yaml`.
   - Write `config/config.yaml` with required paths and execution parameters matching the schema.
   - Write `config/test.yaml` paired with synthetic test fixtures in `test/`.
4. **Author Modular Rules**:
   - Read [rule.smk](templates/rule.smk) as a syntax reference for directive formatting (`temp()`, `log:`, stream redirection).
   - Read [summary.md](templates/summary.md) for the stage summary receipt card schema.
   - Construct `workflow/Snakefile` with `snakemake.utils.validate` and `rule all`.
   - Author domain logic in `workflow/rules/*.smk` using tiered paths (`processed/`, `results/`, `logs/`, `summary/`). Ensure each analytical stage has a terminal aggregation rule that generates its receipt in `summary/{stage}.md`.
5. **Verification**: Run `snakemake -n --configfile config/test.yaml` followed by `snakemake --lint`.

**Completion Criterion**: Directory tree conforms to standard layout; `snakemake -n` completes with a valid DAG; `snakemake --lint` produces 0 warnings or errors.

### Branch 2: Workflow Audit & Refactoring (Auditing)

When reviewing or optimizing an existing Snakemake pipeline:

1. **Check Tiered Paths**: Audit every rule for outputs targeting root or `workflow/`. Ensure intermediates use `processed/` (with `temp()` where applicable), terminal files use `results/` (with `protected()` where appropriate), logs use `logs/{rule}/{wildcard}.log`, and analytical stages produce tracked receipts in `summary/`.
2. **Check Parameter Validation**: Verify presence of `schema.yaml` and startup schema validation. Identify unvalidated config accesses.
3. **Check DAG & Resources**: Detect ambiguous wildcards without constraints, missing log redirections (`> {log} 2>&1`), inline complex scripts, and missing `threads` or `resources`.
4. **Check Environment Pinning**: Verify per-rule `conda` or container specifications and check for unpinned dependencies.
   *(Guardrail: Do NOT read any template files in `templates/` during Steps 1–4).*
5. **Output Structured Audit**:
   - Read [rule.smk](templates/rule.smk) only when generating code replacement blocks to align syntax and directive formatting.
   - Categorize findings into: Critical Violations, Architectural Improvements, and Drop-in Refactorings (concrete before/after code blocks).

**Completion Criterion**: All 4 audit categories evaluated against the codebase; all identified defects accompanied by drop-in replacement code blocks.
