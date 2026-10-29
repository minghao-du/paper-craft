# Resource values are illustrative; size memory for the workload and site limits.
# --- Pattern A: Binary / C-tool isolated via Conda directive ---
rule align_reads:
    input:
        reads=f"{config.get('data_dir', 'data')}/{{sample}}.fastq.gz",
        reference=config["reference_genome"],
    output:
        bam=temp("processed/alignment/{sample}.bam"),
    log:
        "logs/align_reads/{sample}.log",
    threads: 1
    resources:
        mem_mb=4096,
    conda:
        "../envs/samtools.yaml"
    shell:
        """
        samtools sort -@ {threads} -o {output.bam} {input.reads} > {log} 2>&1
        """


# --- Pattern B: Python script executed via uv run (PEP 723 isolated metadata) ---
rule process_matrix:
    input:
        counts="processed/alignment/{sample}.bam",
    output:
        metrics=temp("processed/quantification/counts/{sample}.parquet"),
    log:
        "logs/process_matrix/{sample}.log",
    threads: 1
    resources:
        mem_mb=4096,
    params:
        script="workflow/scripts/process_matrix.py",
    shell:
        """
        export OMP_NUM_THREADS={threads} OPENBLAS_NUM_THREADS={threads} MKL_NUM_THREADS={threads}
        export NUMEXPR_NUM_THREADS={threads} POLARS_MAX_THREADS={threads}
        uv run {params.script} --input {input.counts} --output {output.metrics} > {log} 2>&1
        """


# Terminal output path examples for the quantification stage:
# results/quantification/figures/{sample}.counts.pdf
# results/quantification/tables/{sample}.counts.tsv
# results/quantification/reports/overview.html
# Hand validated findings and evidence to /pc-research-state outside the DAG.
