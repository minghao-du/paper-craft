# Research-state convention

## Home and discovery

Resolve one designated research home from project agent/startup guidance. The home may be a project's `research-state/` directory or an explicitly designated external workspace. Related repositories, clones, and worktrees use the same fixed entry rather than creating parallel research states.

When establishing the home, add a discovery sentence to relevant agent/startup guidance, substituting the actual absolute entry path:

> Read the shared research state at `/absolute/project/research-state/RESEARCH-STATE.local.md` before research work; use `/pc-research-state` for all updates.

Keep the entire research-state workspace Git-ignored in its owning repository and ensure no files inside it remain tracked. If removing existing tracked records, preserve local files and useful content while removing only their index entries. An external workspace outside Git needs no repository ignore rule; check related repositories for tracked copies. Preserve unrelated instructions and local material during migration.

## Directory reports and navigation

The entry explains the project's research questions, current findings, route, and open issues, linking to detailed reports where needed. Apply the [report requirements](report-template.md) at each analytical level.

For research-to-code mapping, identify each repository and code root explicitly. Mirror its meaningful directory hierarchy in report navigation, mapping analytical steps to report locations. Each mapped directory's role, scripts or workflow rules, inputs, outputs, and callers or consumers must be recoverable from its report or a linked report. Small directories may share a report; shared helpers link to the analyses they affect. Directory inventories support the scientific account rather than replacing it.

During initialization or migration, inspect the full recursive code hierarchy and establish the mapping, marking unresolved areas. During routine updates, inspect affected steps, upstream conditions needed to interpret them, downstream consumers, and parent summaries. Preserve one authoritative detailed account of each analysis; parent reports synthesize findings, their relationships, and common limits with links to the detail.

Use relative links within the research home and unambiguous repository/code identities for external mappings. Repair inbound links when moving records. Keep raw data, logs, tables, figures, and models in their canonical artifact locations; reports explain their research meaning and link to the evidence.

## Evidence and integration

Distinguish plans, hypotheses, observations, interpretations, and conclusions. The calling session or human owns scientific judgments; recording a plan does not authorize execution. Keep live task status in its task system.

Tie consequential claims to identifiable evidence: dataset or input identity, code revision where relevant, run/configuration identity, artifact path, and specific table, figure, or metric. Remote evidence includes host and path. Record whether evidence was inspected now, previously verified, reconstructed, unverified, or inaccessible, with gaps affecting the conclusion. Execution success alone establishes no scientific result.

Compare conditions before combining findings across runs. Keep conflicting conclusions unresolved until the caller interprets the evidence; supported independent updates may proceed. When findings change, update affected interpretations and parent syntheses or mark them pending reassessment. During migration, integrate useful existing findings before retiring parallel entries.
