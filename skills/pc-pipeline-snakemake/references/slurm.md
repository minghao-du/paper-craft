# Slurm executor profiles

Use the [Slurm executor plugin](https://snakemake.github.io/snakemake-plugin-catalog/plugins/executor/slurm.html) with a compatible Snakemake version. Add `snakemake-executor-plugin-slurm` to the project's uv dependencies and lockfile. All compute steps must be submitted directly to Slurm by Snakemake; compute nodes need the rule environments and workflow inputs.

## Native Orchestration vs. sbatch Anti-Patterns

Always drive cluster computation through Snakemake's native executor plugin via profile. Do not author standalone `.sbatch` scripts for pipeline execution:

- **Step-level sbatch scripts**: Never write individual `.sbatch` scripts for workflow steps or chain them with `--dependency=afterok`.  
  *Instead:* Express each step as a modular Snakemake rule declaring `threads:` and `resources:`, and let Snakemake build and dispatch the job DAG.
- **Monolithic fat-node allocations**: Never request a large multi-core node (`#SBATCH -c 32 --mem 128G`) to run Snakemake with its local executor (`-j 32`). This serializes scheduling, monopolizes unneeded resources during light steps, and violates independent unit dispatch.  
  *Instead:* Run the controller with `--profile config/profiles/slurm` so Snakemake submits each unit as an independent, right-sized Slurm job.

## Profile Configuration

Adapt this example into `config/profiles/slurm/config.yaml`. Replace `SITE_PARTITION` and `SITE_ACCOUNT` from project/site configuration; omit the account entry if the site does not use accounts. The numeric values illustrate syntax: size memory and runtime for the workload, and concurrency for site limits.

```yaml
executor: slurm
jobs: 40
default-threads: 1
default-resources:
  slurm_partition: "SITE_PARTITION"
  slurm_account: "SITE_ACCOUNT"
  tasks: 1
  mem_mb: 4096
  runtime: 30
```

Launch from the project root:

```bash
uv run snakemake --profile config/profiles/slurm <target>
```

Add `--software-deployment-method conda` when Conda rules are present. `jobs` limits concurrent jobs; each job's CPU allocation comes from its thread/resource settings. Rule declarations override defaults, so `default-threads: 1` alone does not establish compliance.

## Controlled Exception: Controller Daemon

When site policy strictly forbids running long-lived processes on the login/head node, the Snakemake controller itself may be launched as a minimal background Slurm batch job. Store this launcher exclusively at `config/profiles/slurm/controller.sbatch`:

```bash
#!/usr/bin/env bash
#SBATCH --job-name=snakemake-controller
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --mem=4096M
#SBATCH --time=7-00:00:00
#SBATCH --output=logs/slurm_controller_%j.log

# Minimal controller daemon: orchestrates DAG and submits compute rules to Slurm via profile.
uv run snakemake --profile config/profiles/slurm "$@"
```

Guardrails for `controller.sbatch`:
- Strict single-CPU allocation (`--cpus-per-task=1`) and minimal memory (`<= 4096M`) for DAG management only.
- Analytical rules must never be executed locally within this allocation; the controller must dispatch all rule jobs to Slurm via `--profile config/profiles/slurm`.
- Do not place arbitrary `submit.sh` or `run.sbatch` scripts in the repository root or `workflow/`.

## Resource inspection

Review effective rule values together with profile and command-line overrides:

| Setting | Slurm meaning |
| --- | --- |
| `threads` | CPUs per task for ordinary threaded jobs |
| `tasks` | Tasks / MPI ranks (`--ntasks`) |
| `mem_mb` | Total memory per node (`--mem`), in MB |
| `runtime` | Walltime (`--time`), in minutes |

Check `set-threads`, `set-resources`, `cpus_per_task`, and `slurm_extra` for overrides that change these requests. If using `mem_mb_per_cpu` instead of total memory, remove `mem_mb`; the two memory modes are mutually exclusive. Apply the site's memory-to-CPU limits to the resulting allocation.

Inspect rule bodies and job grouping for hidden loops or groups that combine independent units into one allocation. Controller launch scripts must select this executor/profile as well. Explain any `localrules` in terms of controller work, keeping analytical computation on compute nodes.

Complete [smoke validation](smoke.md) through the production launch route and the **Independent Cluster Jobs** configuration gate from `SKILL.md` against the production configuration. Smoke execution and resource inspection establish separate claims.
