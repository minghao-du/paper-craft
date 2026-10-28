# paper-craft

**Manuscript-driven agent development platform — TypeScript rewrite.**

> The core ideas, workflow design, skill architecture, and agent orchestration patterns in this project originate from Erick Matsen's [bipartite](https://github.com/matsen/bipartite) (MIT License). paper-craft rewrites the entire system in TypeScript for better type safety, richer ecosystem integration, and a more accessible contribution experience for frontend/full-stack developers.

## Background: What is bipartite?

[bipartite](https://github.com/matsen/bipartite) is an open-source project created by Professor Erick Matsen at the Fred Hutchinson Cancer Research Center. Its tagline is *"Agentic hacking like a PI"* — it provides a `bip` CLI and a library of Claude Code skills that coordinate teams of agents across GitHub issues, code repositories, manuscripts, and the literature. paper-craft renames the CLI to `pc`.

For motivation and a walkthrough of the workflow, see the blog post: [Bipartite: manuscript-driven development with a team of agents](https://matsen.group/general/2026/06/06/bipartite.html).

The core architecture consists of two coupled loops:

- **Ideas loop** (manuscript side): Manuscript sessions surface new results, situate them in the literature, and turn them into well-scoped issues across multiple repositories.
- **Experiments loop** (code side): Autonomous workers pick up those issues in dedicated clones, implement, test, create PRs, and surface fresh results back to the ideas side.

Two human touchpoints anchor the otherwise-autonomous flow: high-level discussion of new findings on the ideas side, and pre-merge review on the experiments side.

## Why Rewrite in TypeScript?

The original bipartite uses Go for the CLI, shell scripts for glue, and Markdown + Bash for skills. paper-craft chooses TypeScript for the rewrite for the following reasons:

| Dimension | bipartite (Go + Shell) | paper-craft (TypeScript) |
|-----------|----------------------|--------------------------|
| Type system | Static but limited generic expressiveness | Full generics + union types + template literals |
| Skill authoring | Markdown + embedded Bash | TypeScript modules — testable, debuggable |
| Frontend integration | None | Shared types, direct Web UI integration |
| Package ecosystem | Go modules | npm, vast library ecosystem |
| Agent framework compatibility | Claude Code only | Adaptable to multiple agent frameworks |
| Config format | JSONL + SQLite | JSONL preserved (git-friendly), TypeScript config |

## Core Design Inherited from bipartite

### Design Principles (from bipartite CONSTITUTION)

1. **Agents Execute, Humans Steer** — Automate execution up to the point of judgment. Workers run autonomously through implementation, testing, and quality gates. Humans choose what to work on and resolve genuine ambiguity.
2. **File-Based State, No Hidden Memory** — All state that matters MUST survive context compaction and session boundaries. Use files (`.epic-status.json`, `.epic-worklog.md`, JSONL stores), not conversation history. A fresh agent reading the files MUST be able to pick up where the last one left off.
3. **Skills Are the Product** — Skills are the primary interface between humans, agents, and the CLI. Skill docs are canonical — when behavior changes, skill docs MUST update in the same PR.
4. **Scope Discipline** — Every piece of work is tied to a GitHub issue. Workers stay within issue scope. Adjacent discoveries become follow-up issues, not scope creep.

### Architectural Decisions (from bipartite DESIGN)

- **JSONL as Source of Truth** — All persistent data lives in JSONL files, chosen for git-mergeability. Indexes are ephemeral artifacts, rebuilt from JSONL on demand.
- **Local-First, Cloud-Optional** — Core functionality works offline. External APIs (Semantic Scholar, GitHub, Slack, etc.) are optional enrichment.

## Skill System

paper-craft reimplements all bipartite skills in TypeScript, renaming the `bip-` prefix to `pc-`:

### Ideas Coordination (Manuscript Side)

| Skill (origin) | Purpose |
|---------------|---------|
| `pc-ms` (`bip-ms`) | Manuscript sessions: track cross-repo EPIC issues, react to new results |
| `pc-ms-poll` (`bip-ms-poll`) | Poll manuscript session state |
| `pc-lit` (`bip-lit`) | Literature retrieval and discussion |
| `pc-research-ideas` | Manual research discussion grounded in selected project papers |
| `pc-research-plan` | Manually creates or updates a project-root research overview and phased plan |
| `pc-lit-import` (`bip-lit-import`) | Paperpile literature import |
| `pc-issue-file` (`bip-issue-file`) | Issue creation and filing |
| `pc-issue-check` (`bip-issue-check`) | Issue compliance checking |
| `pc-issue-next` (`bip-issue-next`) | Next issue recommendation |
| `pc-issue-iterate` (`bip-issue-iterate`) | Issue iterative refinement |
| `pc-ms-sweep` (`bip-ms-sweep`) | Pre-submission full-text polish |
| `pc-ms-audit` (`bip-ms-audit`) | Manuscript audit |

### Agent Orchestration (Experiments Side, EPIC Workflow)

| Skill (origin) | Purpose |
|---------------|---------|
| `pc-epic` (`bip-epic`) | EPIC sessions: track program strategy, triage issues/PRs |
| `pc-conductor` (`bip-conductor`) | Conductor: manage clone pool, spawn workers |
| `pc-conductor-spawn` (`bip-conductor-spawn`) | Spawn new workers in tmux windows |
| `pc-conductor-handoff` (`bip-conductor-handoff`) | Task handoff between workers |
| `pc-pr-review` (`bip-pr-review`) | Automated PR review |
| `pc-pr-land` (`bip-pr-land`) | PR merge and landing |
| `pc-epic-check` (`bip-epic-check`) | EPIC status check |
| `pc-conductor-prepare-reboot` (`bip-conductor-prepare-reboot`) | State preservation before host reboot |
| `pc-dashboard` | Read-only local Fleet overview and JSON evidence |
| `pc-conductor-recover` (`bip-conductor-recover`) | Recovery after reboot |

### Specialized Review & Support Skills

#### Code Review

| Skill | Purpose |
|-------|---------|
| `pc-review-clean-code` | Reviews code for clean-code principles: single responsibility, clear naming, fail-fast, type safety, DRY |
| `pc-review-code-reuse` | Audits diffs for adherence to existing repo patterns; catches redefined constants, reimplemented helpers, missed abstractions |
| `pc-review-zig` | Reviews Zig code for memory safety, data-oriented design, allocator discipline, and idiomatic error handling |

#### Manuscript / TeX

| Skill | Purpose |
|-------|---------|
| `pc-tex-editor` | Edits LaTeX manuscripts for prose clarity, structure, and academic flow |
| `pc-tex-grammar` | Line-by-line grammar checking on LaTeX documents, preserving commands and math syntax |
| `pc-tex-verb-tense` | Audits LaTeX manuscripts for verb tense accuracy and consistency across sections |
| `pc-tex-topic-sentence` | Audits LaTeX manuscripts to ensure every paragraph opens with a strong topic sentence |
| `pc-submission-checker` | Pre-submission manuscript audits: repository accessibility, preprint updates, bibliographic completeness |
| `pc-pdf-proofreader` | Sentence-by-sentence proofreading on journal PDF page proofs |
| `pc-pdf-qa` | Answers scientific questions and extracts methodology, data, and figures from PDF documents |

#### Visualization & Math

| Skill | Purpose |
|-------|---------|
| `pc-review-plot` | Reviews Python visualization code for publication quality and proportional ink principles |
| `pc-math-summarizer` | Analyzes statistical/computational PRs and drafts companion Markdown with LaTeX equations |

#### Workflow / Orchestration

| Skill | Purpose |
|-------|---------|
| `pc-issue-lead` | Evaluates worker progress from file-based state alone; escalates only when human judgment is needed |
| `pc-skeptic` | Interrogates strong or negative claims before they propagate |

#### Pipeline

| Skill | Purpose |
|-------|---------|
| `pc-pipeline-nextflow` | Reviews and optimizes Nextflow DSL2 workflows according to nf-core best practices |
| `pc-pipeline-snakemake` | Reviews and optimizes Snakemake pipelines for modularity, validation, and reproducibility |

### Workflow Coordination (Cross-Cutting)

| Skill (origin) | Purpose |
|---------------|---------|
| `pc-checkin` (`bip-checkin`) | Cross-repo check-ins |
| `pc-digest` (`bip-digest`) | Themed narrative digests |
| `pc-narrative` (`bip-narrative`) | Narrative generation |
| `pc-scout` (`bip-scout`) | SSH server resource scouting |
| `pc-compute-config` | Configures project CPU/GPU backends and platform skills in `.paper-craft/` |

For local DeepSeek Harness integration, see the [MCP setup guide](docs/guides/mcp.md).

## Project Status

> [!IMPORTANT]
> paper-craft is in its early stages — architecture design and core module TypeScript rewriting are in progress.

## Acknowledgements

- [Erick Matsen](https://github.com/matsen) and the [bipartite](https://github.com/matsen/bipartite) project — the ideas, architecture, skill design, and agent orchestration patterns in paper-craft all originate from bipartite.
- Blog post: [Bipartite: manuscript-driven development with a team of agents](https://matsen.group/general/2026/06/06/bipartite.html)

## License

MIT — consistent with upstream bipartite.
