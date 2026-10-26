---
name: pc-pipeline-snakemake
description: Review, scaffold, and optimize Snakemake workflows with modular rules, fail-fast validation, uv & conda isolation, tiered data hygiene, and independent cluster scheduling.
---

# /pc-pipeline-snakemake

Guidance, scaffolding, and auditing for Snakemake workflows adhering to official best practices and reproducible execution standards.

## Standard Directory Layout

A production Snakemake workflow strictly separates version-controlled orchestration and configuration from ephemeral, generated data assets:

```text
.
├── RESEARCH-PLAN.md             # (Optional) Research intent & proposed stages (tracked in Git)
├── pyproject.toml               # uv project dependencies & Snakemake runner specification
├── uv.lock                      # uv lockfile for deterministic Python environment
├── config/
│   ├── config.yaml              # Production execution parameters and path variables
│   ├── schema.yaml              # JSONSchema parameter validation specification
│   └── test.yaml                # Smoke inputs, reduced workload, and isolated output roots
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
├── tests/                       # Unit tests and fixtures (tracked in Git)
│   └── data/
│       └── smoke/               # Small raw inputs for the production workflow
├── data/                        # Raw, immutable input data (production; read-only; never written to by rules)
├── processed/                   # Intermediate staged artifacts (cleaned, aligned, intermediate tables; gitignored)
│   └── quantification/
│       ├── counts/
│       └── normalized/
├── results/                     # Final deliverables (publication figures, summary tables, reports; gitignored)
│   └── quantification/
│       ├── figures/
│       ├── tables/
│       └── reports/
├── logs/                        # Standard output & error logs partitioned per rule (gitignored)
├── summary/                     # Stage-level text receipts & interface contracts for human & agent (tracked in Git)
│   └── quantification.md
└── resources/                   # (Optional) Shared reference files, genomic indexes, or databases
```

### Stage Output Organization

- Group both roots by analytical stage: `processed/<stage>/` and `results/<stage>/`.
  Use the same stage name in both roots and `summary/<stage>.md` wherever that stage produces artifacts.
- Within a stage, group intermediates by domain meaning (e.g., `counts/`, `normalized/`) and deliverables by kind (e.g., `figures/`, `tables/`, `reports/`).
  Create only directories with actual outputs; a few files of one kind may live directly under the stage.
- Give each artifact one canonical location.
  Distinguish samples, comparisons, and parameter variants in paths; use the same filename stem for different formats of the same artifact (e.g., `treatment_vs_control.volcano.pdf` and `.png`).
  Choose descriptive names rather than `misc/`, `temp/`, or `final_v2/`; adapt filename syntax to the project.
- **Unnumbered Semantic Stage Architecture**: Name stages, rules (`*.smk`), scripts, receipts (`summary/*.md`), and output subdirectories strictly with semantic domain nouns (e.g., `metadata`, `embedding`, `msa`, `g2p`) rather than sequential numeric prefixes (`01_`, `02_`).
  Sequential prefixes introduce brittle order-coupling, requiring cascading filesystem renames whenever intermediate steps are inserted or bifurcated.
  Let the workflow DAG orchestrate execution order, not filesystem naming.

## Quality Standards

### 1. Tiered Data Hygiene & Directive Contracts
- **Log Directive Contract**: Every non-trivial rule must specify a `log:` directive partitioned by rule name and wildcard (e.g., `log: "logs/{rule}/{sample}.log"`). In `shell:`, capture standard streams explicitly: `> {log} 2>&1`.
- **Intermediate Artifacts (`processed/`)**: Route all intermediate and staged transformations to `processed/`. Mark temporary artifacts with `temp()` so Snakemake removes them immediately after downstream consumers finish.
- **Deliverables (`results/`)**: Route final analytical summaries, plots, and reports to `results/`. Apply `protected()` on high-cost terminal deliverables to guard against accidental deletion.
- **Stage Summary Receipts (`summary/`)**: Each analytical stage must produce a brief completion receipt via its aggregation rule. Production receipts live in `summary/{stage}.md`, tracked in Git, decoupling compute-heavy environments from local inspection; smoke receipts follow the **Smoke Execution Contract**. A receipt proves completion and summarizes conclusions — it points to where data lives, never reproduces it. Follow the 3-section skeleton in [summary.md](templates/summary.md): **Summary** (pass/fail + 1–2 sentence key finding + runtime), **Shape** (key counts in one line), **Outputs** (file paths, format, and one sentence describing content or purpose). Raw diagnostic dicts, seed arrays, and full schema dumps belong in data files, not receipts. All paths use project-root-relative form.
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
- **Smoke Execution Contract**: When authoring, changing, or auditing an execution chain, follow [smoke validation](references/smoke.md) for fixtures, execution, and output checks. A dry-run establishes DAG resolution; smoke success requires an actual run through the production entry point.

### 5. Independent Cluster Jobs (HPC)

For cluster execution:

- **Independent Units**: Represent independent samples, replicates, and parameter combinations as separate wildcard jobs with distinct outputs and logs. Submit each through a Snakemake cluster executor/profile; keep dependencies and aggregation in the DAG. Never pack these units into one multi-core allocation running Snakemake's local executor.
- **Single-CPU Default**: Use `threads: 1` for units that fit one CPU and the site's memory limits. Match program workers and numerical-library thread pools to the allocation. Multi-core exceptions require tightly coupled parallel work or a unit's memory needs; record the reason beside the rule or profile override and request the minimum required CPUs.
- **Site Configuration**: Take partition, account, concurrency, and memory limits from project/site configuration. Run the controller where site policy permits, with resources for orchestration only.
- **Slurm**: When authoring or auditing Slurm execution, read [Slurm profiles](references/slurm.md).
- **Configuration Gate**: Check every independent unit's job/output mapping, effective executor/profile and resource overrides, CPU/thread agreement, and each multi-core exception. Report findings and unresolved configuration separately from smoke execution results.

## Workflows

### Branch 1: Workflow Scaffolding (Authoring)

When generating a new Snakemake workflow or expanding an existing one:

1. **Scaffold Directory Tree & uv Project**: Create the Standard Directory Layout as outputs are introduced. Initialize root `pyproject.toml` declaring `snakemake` and `snakefmt`.
2. **Establish Git Hygiene**: Read [gitignore.template](templates/gitignore.template) to create the project `.gitignore`. Ensure `.venv/`, `processed/`, `results/`, and `logs/` are gitignored while `pyproject.toml`, `uv.lock`, `tests/`, and `summary/` are tracked.
3. **Configure & Schema**:
   - Read [schema.yaml](templates/schema.yaml) as a reference to write `config/schema.yaml`.
   - Write `config/config.yaml` with required paths and execution parameters matching the schema.
   - Configure smoke inputs and output roots following the **Smoke Execution Contract**.
4. **Author Modular Rules & Scripts**:
   - Read [rule.smk](templates/rule.smk) as a syntax reference for both `conda:` binary rules and `uv run` Python rules.
   - Read [script.py](templates/script.py) as a syntax reference for isolated Python scripts with PEP 723 inline dependency metadata.
   - Read [summary.md](templates/summary.md) for the receipt skeleton.
   - Construct `workflow/Snakefile` with `snakemake.utils.validate` and `rule all`.
   - Author domain logic in `workflow/rules/*.smk` using the **Stage Output Organization** and **Stage Summary Receipts** conventions above.
   - For cluster execution, apply **Independent Cluster Jobs** when choosing job boundaries, rule resources, and the execution profile.
5. **Verification**: Complete the **Smoke Execution Contract** and run `uv run snakemake --lint` through the project's configured execution route.

**Completion Criterion**: Directory tree conforms to the standard layout; smoke execution and its artifact checks pass; `uv run snakemake --lint` produces 0 warnings or errors. For cluster execution, the **Independent Cluster Jobs** configuration gate also passes. Report any unexecuted checks as pending.

### Branch 2: Workflow Audit & Refactoring (Auditing)

When reviewing or optimizing an existing Snakemake pipeline:

1. **Check Tiered Paths**: Audit every rule for outputs targeting root or `workflow/`. Ensure intermediates use `processed/` (with `temp()` where applicable), terminal files use `results/` (with `protected()` where appropriate), logs use `logs/{rule}/{wildcard}.log`, and analytical stages produce tracked receipts in `summary/`. Check Stage Output Organization conventions and that receipt output entries explain content or purpose.
2. **Check Parameter Validation & Smoke Testing**: Verify startup schema validation and evaluate the **Smoke Execution Contract**, including actual execution and artifact evidence for the affected chain.
3. **Check DAG & Resources**: Detect ambiguous wildcards without constraints, missing log redirections (`> {log} 2>&1`), inline complex scripts, and missing `threads` or `resources`. For cluster execution, evaluate the **Independent Cluster Jobs** configuration gate.
   - When fixing a failed stage run, inspect the existing target, logs, and rerun reasons to distinguish parsing failures, dependency rebuilds, and job execution failures. Trace the failure to its input or environment contract and repair it within the existing Snakefile and stage target, preserving required dependencies.
   - Introduce a separate entry point or stage-selection switch only after identifying execution requirements the existing DAG cannot express.
   - Complete the diagnosis when the reported failure and any triggered upstream rebuild are explained, and the proposed repair addresses their cause.
4. **Check Environment Pinning (Conda & uv)**:
   - For Conda: verify per-rule `conda:` specifications target `workflow/envs/*.yaml` with pinned package versions. Flag any unpinned packages or floating tags. Ensure no loose `requirements.txt` pollute `workflow/envs/`.
   - For uv: verify root `pyproject.toml` (and `uv.lock`) manages Snakemake execution. For standalone Python scripts in `workflow/scripts/`, verify that rules needing isolated dependencies declare pinned versions via PEP 723 inline script metadata rather than unpinned ad-hoc `pip install` in shell directives.
   *(Guardrail: Do NOT read any template files in `templates/` during Steps 1–4).*
5. **Output Structured Audit**:
   - Read [rule.smk](templates/rule.smk) and [script.py](templates/script.py) only when generating code replacement blocks to align syntax, directive formatting, and PEP 723 metadata.
   - Categorize findings into: Critical Violations, Architectural Improvements, and Drop-in Refactorings (concrete before/after code blocks).

**Completion Criterion**: All 4 audit categories evaluated against the codebase; all identified defects accompanied by drop-in replacement code blocks. For cluster execution, include configuration-gate findings and unresolved configuration in the audit.
