---
name: pc-pipeline-refactor
description: Refactor existing workflow pipeline directory layouts, remove sequential number prefixes, modularize flat scripts into submodules, mirror results structures, and execute atomic dual-environment path migrations across local and remote HPC.
disable-model-invocation: true
---

# /pc-pipeline-refactor

Refactor existing scientific computing workflows from ad-hoc, flat, or sequentially numbered directory layouts into clean, modular, tiered architectures adhering to [pc-pipeline-snakemake](../pc-pipeline-snakemake/SKILL.md).
Synchronize all code, rules, configurations, and data assets across local workstations and remote HPC environments without interrupting reproducible execution or losing data.

## Core Leading Words

- **`ledger`**: The explicit source-to-target path mapping that gates every filesystem operation.
  Never move, rename, or delete files without an approved ledger.
- **`mirror`**: The strict structural symmetry between script submodules and results directories.
  Every analytical subfolder in `workflow/scripts/<stage>/` must be reflected 1:1 in `results/<stage>/`.
- **`atomic`**: Dual-environment execution where local repository changes and remote HPC data assets migrate in lockstep.
  Avoid half-migrated states where code expects new paths while compute clusters host old directories.
- **`dry-run`**: Zero-compute topological verification via `snakemake -n`.
  Every refactor must prove complete DAG closure across default and aggregate targets before committing.
- **`sanitize`**: Safe environment cleanup of merged Git worktrees, unpartitioned root logs, and obsolete intermediate artifacts.

---

## The 5-Phase Refactoring Protocol

```
Phase 1: Audit & Inventory  ──>  Phase 2: Migration Ledger  ──>  Phase 3: Code Rewiring
                                                                        │
Phase 5: Zero-Compute Verification  <──  Phase 4: Atomic Migration & Sanitize  <─┘
```

### Phase 1: Audit & Inventory

Benchmark the target repository against the standard layout defined in [pc-pipeline-snakemake](../pc-pipeline-snakemake/SKILL.md).
Inspect both local repository structure and remote HPC working directories.

Audit for common structural debt:
1. **Sequential Number Prefixes**: Check for `01_`, `02_` stage prefixes in `workflow/rules/`, `workflow/scripts/`, `summary/`, and output roots.
2. **Flat Script Clutter**: Identify loose script files exposed directly in parent stage folders instead of cohesive submodules.
3. **Asymmetric Output Layouts**: Detect mismatches between script submodules and result directories.
4. **Data Hygiene Violations**: Check for unpartitioned datasets in `data/`, plural-versus-singular folder inconsistencies (e.g., `processed/embeddings/` vs `processed/embedding/`), or non-data scratch files in data directories.
5. **Log Smells**: Locate unpartitioned log files lingering in repository roots or parent `logs/` folders without rule-level and wildcard-level partitioning.
6. **Dangling Workspaces**: List merged Git worktrees, stale branches, or abandoned scratch directories on remote hosts.

**Completion Criterion**:
Every structural debt item across all tiers (`data/`, `processed/`, `results/`, `logs/`, `workflow/`) is cataloged with exact file paths.

---

### Phase 2: Migration Ledger Generation

Synthesize audit findings into an explicit migration contract before touching code or filesystem structures.
Populate the migration ledger following the template in [templates/migration-ledger.md](templates/migration-ledger.md).

The ledger must specify:
1. **Source-to-Target Mappings**: Full path pairs for every rule, script, directory, output artifact, and configuration reference.
2. **Action Specifications**: Mark each action as `Rename`, `Move`, `Symlink`, or `Delete`.
   Use `Symlink` whenever external pipelines or historical checkpoints rely on legacy paths.
3. **Dual-Environment Scope**: Indicate whether each path applies to Local, Remote HPC, or both.
4. **Code Rewiring Matrix**: Enumerate every configuration file (`config/*.yaml`), workflow definition (`Snakefile`, `workflow/rules/*.smk`), script import, and test fixture that requires updated paths.
5. **Sanitization Plan**: Specify obsolete worktrees, dead directories, and unpartitioned logs scheduled for removal.

**Completion Criterion**:
The migration ledger is reviewed and confirmed with the user.
No file is moved or deleted until the ledger is settled.

---

### Phase 3: Code and Rule Rewiring

Update code, rules, configurations, and test suites to use the target paths specified in the ledger.
Keep code changes strictly scoped to path updates, preserving business logic and analytical parameters.

Execution steps:
1. **Configuration Anchors**: Update base directory paths and dataset paths in `config/config.yaml` and `config/schema.yaml`.
2. **Workflow Rules**: Update `include:` directives in `workflow/Snakefile` to point to unnumbered semantic rules.
   Update rule `input:`, `output:`, and `log:` directives in `workflow/rules/*.smk` to match the new submodule and mirror output hierarchy.
3. **Script Invocations**: Update script relative paths in rule `script:` directives (e.g., `script: "../scripts/<stage>/<submodule>/<script>.py"`).
4. **Internal Script References**: Update hardcoded directory defaults or relative output paths within standalone execution scripts.
5. **Test Fixtures**: Update mock paths and test assertions in `tests/` to reflect new directory structures.

**Completion Criterion**:
Zero references to legacy paths remain in `workflow/`, `config/`, and `tests/`.
A repository-wide text search confirms no stale paths persist.

---

### Phase 4: Atomic Dual-Environment Migration & Sanitization

Execute filesystem relocations across local and remote environments as specified in the migration ledger.
Ensure changes occur atomically so neither environment is left in a broken intermediate state.

Execution sequence:
1. **Local Filesystem Relocation**:
   - Use `git mv` for all tracked files (rules, scripts, configs, test suites, summary receipts) to preserve Git commit history.
   - Reorganize local intermediate or output test fixtures to match new mirror structures.
2. **Remote HPC Filesystem Relocation**:
   - Connect to remote compute host via SSH.
   - Create required target submodule directories (`mkdir -p`).
   - Move production datasets, intermediate processed features, and result directories into the new mirror hierarchy.
   - Create backward-compatible symbolic links where the ledger explicitly requires external compatibility.
3. **Environment Sanitization**:
   - Safely remove merged Git worktrees (`git worktree remove`) after verifying branch merges.
   - Purge unpartitioned root logs and dead scratch directories identified in the ledger.
   - Consolidate orphan log files into partitioned stage folders under `logs/<stage>/`.

**Completion Criterion**:
Both local and remote filesystems match the migration ledger exactly.
No orphan files, dangling directories, or broken symlinks remain.

---

### Phase 5: Zero-Compute Verification & Commit

Verify pipeline integrity through non-destructive dry-runs and automated tests without launching heavy compute jobs on login nodes.
Strictly enforce cluster compute boundaries defined in `.paper-craft/compute.md`.

Verification steps:
1. **Default Target Topological Dry-Run**:
   - Run `snakemake -n` (or `nextflow run main.nf -preview`) on the remote HPC host.
   - Confirm complete DAG resolution with zero missing input errors and zero cyclic dependencies.
2. **Stage Aggregate Target Dry-Runs**:
   - Run `snakemake -n <stage>_all` for every major analytical stage target.
   - Verify that all newly restructured rules and mirror outputs are scheduled properly in the DAG.
3. **Unit and Smoke Test Suite**:
   - Execute project test suites (`python -m unittest` or `pytest`) in the local virtual environment.
   - Confirm all path assertions and fixture loads pass green.
4. **Git Tree Inspection & Commit**:
   - Inspect `git status` and `git diff --stat` to verify that only expected path migrations and rewiring changes are staged.
   - Commit changes with a descriptive message summarizing structural changes, unnumbered stages, script submodules, and mirror layouts.
   - Push changes to remote repository tracking branch.

**Completion Criterion**:
Remote `snakemake -n` and target dry-runs pass with zero errors.
Unit tests pass completely.
Local Git working tree is clean and synchronized with upstream.
