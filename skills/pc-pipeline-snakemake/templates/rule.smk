rule align_reads:
    input:
        reads=f"{config.get('data_dir', 'data')}/{{sample}}.fastq.gz",
        reference=config["reference_genome"],
    output:
        bam=temp("processed/aligned/{sample}.bam"),
    log:
        "logs/align_reads/{sample}.log",
    threads: 8
    resources:
        mem_mb=16384,
    conda:
        "../envs/samtools.yaml"
    shell:
        """
        samtools sort -@ {threads} -o {output.bam} {input.reads} > {log} 2>&1
        """
