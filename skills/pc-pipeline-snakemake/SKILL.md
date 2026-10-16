---
name: pc-pipeline-snakemake
description: Review, scaffold, and optimize Snakemake workflows adhering to modular rule design, fail-fast schema validation, dual environment isolation (uv & conda), and tiered data hygiene (processed/, results/, logs/, summary/).
---

# /pc-pipeline-snakemake

Guidance, scaffolding, and auditing for Snakemake workflows adhering to official best practices and reproducible execution standards.

## Standard Directory Layout

A production Snakemake workflow strictly separates version-controlled orchestration and configuration from ephemeral, generated data assets:

```text
.
├── pyproject.toml               # uv project dependencies & Snakemake runner specification
├── uv.lock                      # uv lockfile for deterministic Python environment
├── config/
│   ├── config.yaml              # Production execution parameters and path variables
│   ├── schema.yaml              # JSONSchema parameter validation specification
│   └── test.yaml                # Minimal test dataset parameters for CI
├── workflow/
│   ├── Snakefile                # Workflow entry point and target rule (rule all)
│   ├── rules/                   # Modular rule definitions (*.smk)
│   │   ├── align.smk
│   │   └── qc.smk
│   ├── envs/                    # Isolated conda / container definitions (*.yaml only)
│   │   └── samtools.yaml
│   ├── scripts/                 # Standalone execution scripts (Python / R / Bash; PEP 723 metadata for uv)
│   │   └── parse_output.py
│   └── report/                  # HTML report captions and markdown descriptions
├── tests/                       # Minimal synthetic fixtures & unit tests for local smoke testing & CI (tracked in Git)
│   └── data/                    # Toy input datasets (subsampled fastq/tables; few KB to MB)
├── data/                        # Raw, immutable input data (production; read-only; never written to by rules)
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
- **Stage Summary Receipts (`summary/`)**: Each analytical stage must produce a brief completion receipt in `summary/{stage}.md` via its aggregation rule. Tracked in Git, decoupling compute-heavy environments from local inspection. A receipt proves completion and summarizes conclusions — it points to where data lives, never reproduces it. Follow the 3-section skeleton in [summary.md](templates/summary.md): **Summary** (pass/fail + 1–2 sentence key finding + runtime), **Shape** (key counts in one line), **Outputs** (file paths with format). Raw diagnostic dicts, seed arrays, and full schema dumps belong in data files, not receipts. All paths use project-root-relative form.
- **Immutability of `data/` and `workflow/`**: Treat `data/` as read-only. Confine all output definitions strictly within `processed/`, `results/`, `logs/`, or `summary/`. Never write outputs to `workflow/`.

### 2. Fail-fast Parameter Validation
- **Schema-Enforced Configuration**: Validate parameters at startup in `workflow/Snakefile` using `snakemake.utils.validate(config, schema="../config/schema.yaml")`.
- **Fail-Fast Error Reporting**: Enforce required configuration keys, expected types, and value constraints through JSONSchema in `config/schema.yaml`.
- **Parametrized Directory Roots**: Define data roots in `config/config.yaml` rather than hardcoding filesystem paths inside rule definitions.

### 3. Modular Architecture & Rule Design
- **Single-Responsibility Rules**: Split workflows by analytical stage into `workflow/rules/*.smk` and include them in `workflow/Snakefile` via `include:`.
- **Isolated Script Logic**: Extract multi-line data manipulation, parsing, or transformation routines into `workflow/scripts/` and invoke via `uv run` or `script:`.
- **Strict Wildcards**: Constrain wildcard scope with `wildcard_constraints:` globally or per rule to ensure deterministic DAG resolution.
- **Resource Scaling**: Declare `threads:` and dynamic `resources:` (e.g., `mem_mb=lambda wildcards, attempt: attempt * 4096`) per rule to support dynamic scaling across local or cluster execution.

### 4. Environments & Reproducibility (uv & Conda Dual-Track)
- **Dual-Track Environment Isolation**:
  - **Conda for Binary Dependencies**: Isolate rules requiring non-Python, C/C++, or bioinformatics compiled tools (e.g., `samtools`, `bwa`) via `conda: "envs/foo.yaml"` or `container:`. Pin explicit software versions inside every YAML file. Confine all Conda definitions strictly within `workflow/envs/*.yaml`.
  - **uv for Python Runtime & Rules**: Manage pipeline orchestration (`snakemake`, `snakefmt`) via root `pyproject.toml` and `uv.lock`. Execute all pipeline commands via `uv run`. For Python transformation scripts in `workflow/scripts/`, declare isolated dependencies using PEP 723 inline script metadata (`# /// script ...`) and invoke via `shell: "uv run workflow/scripts/{script} ..."` (see [script.py](templates/script.py)), or execute against the project virtual environment. Never scatter `requirements.txt` files inside `workflow/envs/`.
- **Automated Linting & Formatting**: Format files using `uv run snakefmt` and run `uv run snakemake --lint` to verify adherence to syntax standards.
- **Local Smoke Testing & Execution Contract**:
  - Pure `uv` workflows: execute `uv run snakemake -n --configfile config/test.yaml`.
  - Hybrid workflows with Conda rules: execute `uv run snakemake --software-deployment-method conda -n --configfile config/test.yaml`.
  - Provide synthetic or subsampled input datasets in `tests/data/` paired with `config/test.yaml`. Local execution must resolve DAG and environment configurations without requiring production datasets or cluster scheduling.

## Workflows

### Branch 1: Workflow Scaffolding (Authoring)

When generating a new Snakemake workflow or expanding an existing one:

1. **Scaffold Directory Tree & uv Project**: Create standard directories (`config/`, `workflow/rules/`, `workflow/envs/`, `workflow/scripts/`, `tests/data/`, `data/`, `processed/`, `results/`, `logs/`, `summary/`). Initialize root `pyproject.toml` declaring `snakemake` and `snakefmt`.
2. **Establish Git Hygiene**: Read [gitignore.template](templates/gitignore.template) to create the project `.gitignore`. Ensure `.venv/`, `processed/`, `results/`, and `logs/` are gitignored while `pyproject.toml`, `uv.lock`, `tests/`, and `summary/` are tracked.
3. **Configure & Schema**:
   - Read [schema.yaml](templates/schema.yaml) as a reference to write `config/schema.yaml`.
   - Write `config/config.yaml` with required paths and execution parameters matching the schema.
   - Write `config/test.yaml` pointing to synthetic test fixtures in `tests/data/`.
4. **Author Modular Rules & Scripts**:
   - Read [rule.smk](templates/rule.smk) as a syntax reference for both `conda:` binary rules and `uv run` Python rules.
   - Read [script.py](templates/script.py) as a syntax reference for isolated Python scripts with PEP 723 inline dependency metadata.
   - Read [summary.md](templates/summary.md) for the receipt skeleton.
   - Construct `workflow/Snakefile` with `snakemake.utils.validate` and `rule all`.
   - Author domain logic in `workflow/rules/*.smk` using tiered paths (`processed/`, `results/`, `logs/`, `summary/`). Each analytical stage has a terminal aggregation rule that writes a brief receipt to `summary/{stage}.md` — conclusions and pointers only.
5. **Verification**: Run `uv run snakemake [-n --configfile config/test.yaml]` (adding `--software-deployment-method conda` if Conda rules are present) followed by `uv run snakemake --lint`.

**Completion Criterion**: Directory tree conforms to standard layout with root `pyproject.toml`; `tests/data/` contains minimal test fixtures; `uv run snakemake -n --configfile config/test.yaml` (with `--software-deployment-method conda` when Conda rules exist) completes with a valid DAG; `uv run snakemake --lint` produces 0 warnings or errors.

### Branch 2: Workflow Audit & Refactoring (Auditing)

When reviewing or optimizing an existing Snakemake pipeline:

1. **Check Tiered Paths**: Audit every rule for outputs targeting root or `workflow/`. Ensure intermediates use `processed/` (with `temp()` where applicable), terminal files use `results/` (with `protected()` where appropriate), logs use `logs/{rule}/{wildcard}.log`, and analytical stages produce tracked receipts in `summary/`.
2. **Check Parameter Validation & Smoke Testing**: Verify presence of `schema.yaml` with startup validation, and confirm presence of `config/test.yaml` paired with `tests/data/` fixtures for zero-compute local validation.
3. **Check DAG & Resources**: Detect ambiguous wildcards without constraints, missing log redirections (`> {log} 2>&1`), inline complex scripts, and missing `threads` or `resources`.
4. **Check Environment Pinning (Conda & uv)**:
   - For Conda: verify per-rule `conda:` specifications target `workflow/envs/*.yaml` with pinned package versions. Flag any unpinned packages or floating tags. Ensure no loose `requirements.txt` pollute `workflow/envs/`.
   - For uv: verify root `pyproject.toml` (and `uv.lock`) manages Snakemake execution. For standalone Python scripts in `workflow/scripts/`, verify that rules needing isolated dependencies declare pinned versions via PEP 723 inline script metadata rather than unpinned ad-hoc `pip install` in shell directives.
   *(Guardrail: Do NOT read any template files in `templates/` during Steps 1–4).*
5. **Output Structured Audit**:
   - Read [rule.smk](templates/rule.smk) and [script.py](templates/script.py) only when generating code replacement blocks to align syntax, directive formatting, and PEP 723 metadata.
   - Categorize findings into: Critical Violations, Architectural Improvements, and Drop-in Refactorings (concrete before/after code blocks).

**Completion Criterion**: All 4 audit categories evaluated against the codebase; all identified defects accompanied by drop-in replacement code blocks.
