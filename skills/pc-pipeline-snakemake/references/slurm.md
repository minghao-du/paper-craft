# Slurm executor profiles

Use the [Slurm executor plugin](https://snakemake.github.io/snakemake-plugin-catalog/plugins/executor/slurm.html) with a compatible Snakemake version. Add `snakemake-executor-plugin-slurm` to the project's uv dependencies and lockfile. The controller needs access to Slurm submission commands; compute nodes need the rule environments and workflow inputs.

## Profile

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
