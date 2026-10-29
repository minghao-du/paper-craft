---
name: pc-ms
description: Start manuscript work from the Project's research state, organize supported claims and figures, and return new scientific findings to its coordinator.
---

# /pc-ms

Run from the manuscript repository. Read the fixed Project entry and relevant
linked records under [the research-state convention](../../docs/guides/research-state.md)
before organizing the paper. Report missing pointers, records or inaccessible
evidence and the resulting gaps. For existing projects adopting the convention,
use that guide's migration rules rather than inventing a new summary.

## Establish context

Read project agent guidance and environment/operation documentation, including
any useful parts of `misc/session-onboarding.md`. These describe setup and working
practices; scientific understanding comes from the shared research state. Read
the manuscript to understand its argument, notation and intended audience.

Locate the main TeX file, figure preparation directory and related code repositories
from project docs or `.ms-config.json`. Existing configuration remains usable:

```json
{
  "manuscript": "main.tex",
  "prep_figures_dir": "prep-figures",
  "tracked_repos": [
    {
      "repo": "org/repo",
      "local_path": "/absolute/code/repo",
      "epics": [123],
      "fetch_cmds": ["make remote-fetch DIR=experiments/example/results"],
      "remote_watch": {
        "host": "research-host",
        "paths": ["/remote/results"],
        "patterns": ["*.svg", "*.html", "*.tsv"]
      }
    }
  ]
}
```

Resolve existing information before asking for missing locations. Configuration
is operational metadata, not scientific state. Check local manuscript changes
with `git status` and recent commits before editing.

For cross-repository progress, selective remote result retrieval and optional
monitoring, follow `/pc-ms-poll`. It works before a manuscript exists too.
Check live issues/PRs for task status rather than copying a scheduling dashboard
into the paper or research entry. File issues only when requested, through
`/pc-issue-check` and `/pc-issue-file`.

## Organize and write

Use mature research findings to shape the argument; readiness to write is
reversible. Keep hypotheses and provisional interpretations distinguishable from
supported conclusions. Check important numbers, tables and figures against actual
run evidence with the scope and uncertainty recorded in the research state.
When text and evidence conflict, investigate conditions and comparability rather
than letting the manuscript or a summary prevail automatically.

If writing or review exposes a scientific gap, discuss the question and update
the research route through its coordinator, using
[/pc-research-state](../pc-research-state/SKILL.md) for all research-state writes. Findings and useful unfinished
scientific discussion go there first, then inform manuscript revisions. Plans do
not authorize experiments. This session can inspect remote evidence read-only;
leave remote builds, workflow changes and experiment execution to authorized work.

For proposed text, read the relevant analysis and evidence, present the key points
and intended placement, then draft within the user's authorized editing scope.
Use `/pc-tex-editor` for scientific prose. Manuscript `%PROV` or `%TODO` markers
may point at evidence and record local editorial work; they do not hold the
Project's scientific state.

For figure import, copy the selected verified source into the configured preparation
directory and use the project's documented figure build target. Preserve the source
run and evidence pointer. For HTML notebooks, open the relevant local result in
the user's browser and explain the question it addresses. A copied figure or
notebook is not a replacement for its underlying evidence.

## Session end

Run `/pc-ms-tuckin` before reset. It preserves scientific updates through the
coordinator, operational guidance in project docs, and editorial continuation
pointers without requiring Git commits for research state.
