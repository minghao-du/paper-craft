---
name: pc-pipeline-nextflow
description: Review, create, and optimize Nextflow DSL2 pipelines according to nf-core best practices, modular structures, and reproducibility standards.
---

# /pc-pipeline-nextflow

Guidance and review for Nextflow DSL2 pipelines conforming to nf-core community standards.

## Structure & Architecture

Target directory organization:
```
pipeline/
├── main.nf                  # Minimal entry point
├── nextflow.config          # Central configuration
├── nextflow_schema.json     # Parameter validation schema (nf-schema)
├── modules.json             # nf-core module tracking
├── conf/
│   ├── base.config          # Resource label definitions
│   ├── modules.config       # Per-module ext.args and publishDir
│   └── test.config          # Minimal CI test datasets
├── modules/
│   ├── local/               # Pipeline-specific modules
│   └── nf-core/             # Community modules
├── subworkflows/
│   ├── local/
│   └── nf-core/
├── workflows/
│   └── pipeline.nf          # Core workflow logic
└── assets/                  # Config templates, MultiQC configs
```

## Quality Standards

### 1. Modules & Processes
- **One process per file**: Module name must match the process name in `SCREAMING_SNAKE_CASE`.
- **Arguments**: Pass tool options through `task.ext.args` configured in `conf/modules.config`, never hardcoded in module scripts.
- **Stub execution**: Every module must contain a `stub:` block defining lightweight touch outputs for dry-run testing.
- **Versions**: Every process must emit a `versions.yml` channel capturing exact runtime tool versions.
- **Meta maps**: Restrict metadata maps to canonical keys (`meta.id`, `meta.single_end`). Never mutate meta maps in-place in closures; use `meta + [new_key: value]`.

### 2. Channels & Concurrency
- Do not assume channel item order across processes. Combine channels using `.join()` keyed on `meta.id` or appropriate tuples.
- Use `.first()` to transform queue channels into value channels when broadcasting reference data.
- Avoid indexing channels as lists (`ch[0]`).

### 3. Configuration & Resource Profiles
- Define resource tiers in `conf/base.config` using process labels: `process_single`, `process_low`, `process_medium`, `process_high`.
- Use dynamic retry blocks (`errorStrategy = { task.exitStatus in [140, 143, 137] ? 'retry' : 'finish' }`, scaling `task.memory * task.attempt`).
- Separate environment config (Docker, Singularity, Conda, Slurm) into clean profiles (`-profile docker,slurm`).
- Validate CLI arguments strictly using `nextflow_schema.json`.

### 4. Containers & Reproducibility
- Pin exact container image tags (e.g., `quay.io/biocontainers/samtools:1.19.2--h00cbaee_1`).
- Avoid monolithic multi-tool images; specify container directives per module.
- On shared filesystems (NFS/Lustre), set `cache = 'lenient'` and specify `scratch` for I/O heavy jobs.

### 5. Testing
- Use `nf-test` for snapshot regression testing at process, subworkflow, and end-to-end levels.
- Provide a `test` profile with minimal test data to validate pipelines in CI.

## Audit Output Format

When evaluating a Nextflow pipeline, report:
1. **Reproducibility Risks**: Unpinned versions, hardcoded paths, unconfigured publish directories.
2. **Channel Anti-patterns**: Race conditions, in-place meta map mutation, missing joins.
3. **nf-core Violations**: Missing stub blocks, hardcoded process args, misplaced configuration.
4. **Concrete Fixes**: Code diffs for `nextflow.config`, `conf/modules.config`, or process scripts.
