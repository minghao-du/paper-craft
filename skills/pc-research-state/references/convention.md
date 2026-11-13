# Research-state convention

## Home and discovery

Resolve one designated research home from project agent/startup guidance. The home may be a project's `research-state/` directory or an explicitly designated external workspace. Related repositories, clones, and worktrees use the same fixed entry rather than creating parallel research states.

When establishing the home, add a discovery sentence to relevant agent/startup guidance, substituting the actual absolute entry path:

> Read the shared research state at `/absolute/project/research-state/RESEARCH-STATE.local.md` before research work; use `/pc-research-state` for all updates.

Keep the entire research-state workspace Git-ignored in its owning repository and ensure no files inside it remain tracked. If removing existing tracked records, preserve local files and useful content while removing only their index entries. An external workspace outside Git needs no repository ignore rule; check related repositories for tracked copies. Preserve unrelated instructions and local material during migration.

## Scientific report organization and navigation

The research state reads as one detailed scientific report, optionally split into linked chapters. The entry introduces the research questions, principal current findings, research route, and open issues, with a coherent reading order. Organize chapters by scientific questions and analytical relationships rather than code directories. Use the [report requirements](report-template.md) to cover the scientific account across the report, without repeating the full template at every level.

Maintain one authoritative detailed account of each analysis. Explain shared data and methods once, with links from the chapters that use them. Overviews synthesize substantive findings, relationships, and common limits; detailed chapters supply the evidence and interpretation. Give enough context for the reading sequence to remain coherent without duplicating whole passages or tables.

During initialization or migration, inspect existing scientific materials and establish chapter coverage, marking gaps. During routine updates, inspect affected questions, the data and methods needed to interpret them, dependent findings, and overview summaries. Code inspection may establish facts for the writer; code inventories and recursive directory mapping are not report requirements.

Use relative links within the research home and repair inbound links when moving records. Keep raw data, logs, tables, figures, and models in their canonical artifact locations. Present key figures, comparison values, and explanations in the report; cite their sources without copying raw output collections. Execution commands, scripts, environments, and scheduling belong in the project's pipeline and execution documentation.

## Evidence and integration

Distinguish plans, hypotheses, observations, interpretations, and conclusions. The calling session or human owns scientific judgments; recording a plan does not authorize execution. Keep live task status in its task system.

Tie consequential claims to identifiable evidence using concise citations, figure/table notes, or source links. Include dataset versions or analysis batches only as needed to distinguish the actual results; remote locations must be unambiguous. Shared citations may cover a related group of findings. Record whether evidence was inspected now, previously verified, reconstructed, unverified, or inaccessible, with gaps affecting the conclusion. Citations support verification; the scientific explanation must stand on its own. Execution success alone establishes no scientific result.

Compare conditions before combining findings across runs. Keep conflicting conclusions unresolved until the caller interprets the evidence; supported independent updates may proceed. When findings change, update affected interpretations and parent syntheses or mark them pending reassessment. During migration, integrate useful existing findings before retiring parallel entries.

## Replacement and retention

Maintain current understanding by rewriting relevant sections in place. A newer result replaces an older result only when the research question and conditions are comparable, the evidence is adequate, and the replacement is established. Recency alone is insufficient; keep an unverified update provisional. Synthesize valid findings from different conditions as comparisons, and keep unresolved contradictions visible.

Remove superseded claims, obsolete numerical results, duplicate explanations, and abandoned plans with no continuing relevance. Retain earlier evidence or a revision reason only when omitting it would change the reader's understanding of current findings, lead to a poor methodological choice, or cause repetition of a non-obvious mistake. Apply the same rule to rejected routes and failed approaches:

- Keep scientifically valid negative findings, counterexamples, and method limitations with the evidence and conditions needed to interpret them.
- Remove numerical results invalidated by faulty code or data. If the failure still matters, retain a concise explanation of the cause, its scientific consequence, and how to avoid it; clearly distinguish this lesson from valid scientific evidence.
- Remove routine debugging, resolved setup failures, repeated failed runs, and obsolete result inventories. Keep a lesson only as long as it meets the retention criterion.

No change log or historical archive is required. Pruning report content does not authorize deleting underlying datasets, artifacts, or execution logs. A missing or deleted artifact alone neither invalidates nor supersedes a finding; preserve any still-relevant finding with an explicit evidence-access gap. Update affected citations and summaries as part of the same edit so outdated results do not survive elsewhere as current conclusions.
