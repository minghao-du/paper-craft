---
name: pc-pipeline-snakemake
description: Review, construct, and optimize Snakemake workflows adhering to official best practices, modular rules, and reproducible environment management.
---

# /pc-pipeline-snakemake

Guidance and review for Snakemake pipelines adhering to official best practices and reproducible workflows.

## Directory Layout

Standardized layout:
```
workflow/
├── Snakefile                # Main workflow entry point
├── rules/                   # Modular rule definitions (*.smk)
│   ├── align.smk
│   └── qc.smk
├── envs/                    # Conda/container environment definitions (*.yaml)
│   └── samtools.yaml
├── scripts/                 # Custom Python/R/Bash scripts
│   └── parse_output.py
└── report/                  # Interactive HTML report descriptions
config/
├── config.yaml              # Production parameters
└── test.yaml                # Minimal test config for CI
```

## Quality Standards

### 1. Separation of Concerns
- Separate pure pipeline orchestration (`workflow/`) from domain package logic (`src/` or `package/`).
- Factor non-trivial data manipulation out of rule scripts into reusable Python packages or discrete scripts in `workflow/scripts/`.
- Avoid embedding complex multi-line inline Python code or complex lambda functions inside rule definitions.

### 2. Configuration & Parameter Validation
- Use YAML format for configuration files.
- Never rely on silent defaults for mandatory pipeline parameters via `config.get("key", default)`. Explicitly validate required parameters at top-level execution and raise explicit errors with helpful configuration instructions when absent.
- Avoid hardcoding absolute file paths; parametrize data directories in `config.yaml`.

### 3. Rules & DAG Construction
- **Strict Wildcards**: Define wildcard constraints (`wildcard_constraints:`) to prevent ambiguous DAG resolution.
- **Output Hygiene**: Direct outputs to structured paths (`results/`, `processed/`, `logs/`). Never use root or uncontrolled output paths.
- **Log Files**: Every non-trivial rule must specify a `log:` directive capturing stdout and stderr.
- **Resource Constraints**: Define `threads:` and `resources: mem_mb=...` per rule, allowing dynamic scaling across execution profiles.

### 4. Environments & Testing
- Use isolated conda environment files (`conda: "envs/foo.yaml"`) or container directives per rule.
- Provide a `config/test.yaml` paired with small synthetic test datasets in a `test/` directory to enable fast continuous integration in GitHub Actions.
- Format workflow files using `snakefmt` and lint with `snakemake --lint`.

## Audit Output Format

When reviewing a Snakemake workflow:
1. **Critical Deficiencies**: Ambiguous wildcards, missing log directives, silent config failures, hardcoded paths.
2. **Architecture & Modularity**: Rule file organization, script separation, parameter externalization.
3. **Specific Refactorings**: Concrete code snippets with before/after blocks.
