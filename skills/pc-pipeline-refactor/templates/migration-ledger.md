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
- **Non-Data Derivative Scaffolds**:
  - [ ] `<path>`

---

## 5. Verification Sign-Off

All gates must pass before finalizing the refactor:

- [ ] **Zero-Compute Topological Dry-Run (`default`)**: `snakemake -n` completes with 0 errors.
- [ ] **Zero-Compute Topological Dry-Run (`all targets`)**: `snakemake -n <stage>_all` completes with 0 errors.
- [ ] **Unit & Fixture Tests**: Test suites pass completely (`pytest` or `python -m unittest`).
- [ ] **Compute Boundary Guard**: The actual test execution environment and platform procedure conform to the project's `.paper-craft/compute.md`.
- [ ] **Repository Status**: `git status` clean with no untracked file debris or uncommitted staged fragments.
