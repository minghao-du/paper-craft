# Pipeline Migration Ledger

**Pipeline Root**: `<repo-root>`  
**Remote Environment**: `<remote-ssh-alias>:<remote-repo-root>` (or `N/A`)  
**Target Architecture Reference**: `pc-pipeline-snakemake`  
**Date**: `<YYYY-MM-DD>`  

## 1. Architectural Debt Summary

List identified discrepancies between the existing pipeline and `pc-pipeline-snakemake` standards:

- [ ] **Sequential Number Prefixes**: Rules, scripts, or outputs prefixed with `01_`, `02_`, etc.
- [ ] **Unpartitioned Script Clutter**: Loose script files exposed directly in parent stage directory instead of submodules.
- [ ] **Asymmetric Output Layout**: Results or processed directories do not mirror the script submodule hierarchy.
- [ ] **Tiered Data Hygiene Violations**: Raw data directory contains outputs, mixed singular/plural naming, or unpartitioned root logs.
- [ ] **Stale Environment Artifacts**: Merged worktrees, dangling scratch directories, or obsolete unpartitioned logs.
- [ ] **Cluster Orchestration Debt**: Standalone `.sbatch` scripts, shell submission loops, or monolithic allocations wrapping local execution instead of native Slurm executor profiles.

---

## 2. Path Migration Matrix

Map every path relocation explicitly before performing any filesystem operations.

| Category | Source Path | Target Path | Action | Local | Remote HPC |
| :--- | :--- | :--- | :--- | :---: | :---: |
| Stage Rule | `workflow/rules/01_stage.smk` | `workflow/rules/stage.smk` | Rename | [ ] | [ ] |
| Script Submodule | `workflow/scripts/stage/flat_script.py` | `workflow/scripts/stage/submodule/script.py` | Move | [ ] | [ ] |
| Output Mirror | `results/stage/flat_output/` | `results/stage/submodule/` | Move | [ ] | [ ] |
| Processed Layer | `processed/plural_name/` | `processed/singular_name/` | Rename | [ ] | [ ] |
| Data Layer | `data/misc/dataset.csv` | `data/domain/dataset.csv` | Move / Symlink | [ ] | [ ] |
| Log Directory | `logs/unpartitioned.log` | `logs/stage/rule.log` | Relocate | [ ] | [ ] |
| Cluster Orchestration | `scripts/run_cluster.sbatch` | `config/profiles/slurm/` (Extract resources to rules, then Delete) | Delete | [ ] | [ ] |

> **Action Types**:
> - `Rename`: Git move / filesystem rename within the same parent folder.
> - `Move`: Relocation to a newly structured submodule folder.
> - `Symlink`: Move target file and establish backward-compatible symlink at old path (use when legacy workflows or hardcoded external scripts require compatibility).
> - `Delete`: Safely purge confirmed dead or temporary files.

---

## 3. Code & Configuration Rewiring Matrix

Record all code, configuration, rule, and test modifications required by the path relocations.

| File Path | Search Target / Hardcoded Path | Rewired Replacement Path | Status |
| :--- | :--- | :--- | :---: |
| `config/config.yaml` | `old/data/path` | `new/data/path` | [ ] |
| `workflow/Snakefile` | `rules/01_stage.smk` | `rules/stage.smk` | [ ] |
| `workflow/rules/stage.smk` | `scripts/stage/flat_script.py` | `scripts/stage/submodule/script.py` | [ ] |
| `workflow/rules/stage.smk` | `#SBATCH -c 8 --mem 32G` in `run.sbatch` | `threads: 8` and `resources: mem_mb=32768` | [ ] |
| `config/profiles/slurm/config.yaml` | `sbatch submit_all.sh` | `executor: slurm` profile configuration | [ ] |
| `workflow/scripts/...` | `results/stage/flat_output/` | `results/stage/submodule/` | [ ] |
| `tests/...` | `old/test/fixture/path` | `new/test/fixture/path` | [ ] |

---

## 4. Environment Sanitization & Purge List

Enumerate dead artifacts to remove on local and remote environments:

- **Merged Git Worktrees**:
  - [ ] Local: `<path>`
  - [ ] Remote: `<path>`
- **Obsolete Root Logs**:
  - [ ] `<path>`
- **Retired Cluster Submission Scripts**:
  - [ ] Local: `<path>` (e.g. `submit.sbatch`, `run_all.sh`)
  - [ ] Remote: `<path>`
- **Non-Data Derivative Scaffolds**:
  - [ ] `<path>`

---

## 5. Verification Sign-Off

All gates must pass before finalizing the refactor:

- [ ] **Small-Data Tests**: Affected-target dry-runs, executions and relevant unit/smoke tests pass with representative fixtures covering the changed paths and dependencies.
- [ ] **Native Cluster Execution**: Verified cluster DAG resolution via `uv run snakemake --profile config/profiles/slurm -n`; zero standalone step `.sbatch` scripts remain.
- [ ] **Production Paths**: Actual local/remote mappings, input locations and compatibility symlinks match the ledger; active references use the intended paths.
- [ ] **Production DAG Checks**: Record any risk requiring expanded checks, their targets and results, or why none are needed. Required checks pass; unfinished checks and uncovered production behavior are explicit.
- [ ] **Compute Boundary Guard**: The actual test execution environment and platform procedure conform to the project's `.paper-craft/compute.md`.
- [ ] **Repository Status**: `git status` clean with no untracked file debris or uncommitted staged fragments.
