# Workflow Agent Guidance

## Cluster Execution (SLURM)

When running on SLURM, always use Snakemake's native scheduler and executor plugin (`snakemake-executor-plugin-slurm`) configured via profile (`config/profiles/slurm/config.yaml`). Unless strictly necessary (specifically, a minimal 1-CPU controller daemon script at `config/profiles/slurm/controller.sbatch` when site policy strictly forbids long-lived processes on login nodes), do not use or author standalone `sbatch` scripts or submission wrappers for workflow steps.
