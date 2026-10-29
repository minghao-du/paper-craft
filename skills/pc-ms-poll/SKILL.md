---
name: pc-ms-poll
description: Poll related research repositories and remote results, integrating findings through the Project's research coordinator.
---

# /pc-ms-poll

Use during research or writing; a manuscript is optional. Read the Project's fixed
entry and relevant details under [the research-state convention](../../docs/guides/research-state.md),
including its integration and handover rules. Report a missing entry or pointer
and available sources before reconstructing any context.

## Locate sources

Use project environment/operation documentation for repository `org/repo`, local
checkout paths, relevant EPIC/issue numbers, selective result-fetch commands and
remote host/result paths. Existing `.ms-config.json` `tracked_repos` entries
(`repo`, `local_path`, `epics`, `fetch_cmds`, `remote_watch`) remain usable as
operational configuration; no manuscript fields are required to poll.
Resolve discoverable information locally; ask only for missing source locations.
Keep operational instructions in project docs and scientific understanding in
the shared research state, without a second poll summary authority.

## Collect changes

Scan each repository separately; parallel workers may collect evidence while the
coordinator alone integrates scientific state. Give remote workers the relevant
research context and question. Each worker returns findings, evidence locations,
limitations and suggested actions.

- Read tracked issues with `gh issue view <N> --repo <org/repo> --json body,updatedAt,state`.
  Compare with a known previous poll, or explicitly report the interval used when
  no baseline exists. Read full bodies/comments supporting scientific claims.
- Read recent merged PRs with `gh pr list --repo <org/repo> --search "is:merged sort:updated-desc" --limit 10 --json number,title,body,mergedAt`;
  inspect producing experiments and actual evidence before adopting findings.
  Issue/PR status and active assignments stay in GitHub.
- For local code freshness, `git -C <local_path> fetch origin`, then
  `git -C <local_path> rev-list --left-right --count main...origin/main`.
  Both counts nonzero means divergence; `0 / N` means behind. Do not pull into
  an arbitrary feature checkout. Report unavailable refs or failed fetches.
- Run the project's selective fetch commands from their documented local paths
  to copy results FROM remote. Inspect the command/target if its effects are
  unclear. Preserve host, remote path and specific run identity alongside any
  local copy; a changed file timestamp or overwritten latest path is only a lead.
- Inspect configured result paths for figures, tables, notebooks and logs relevant
  to the question. Use read-only SSH inspection for remote evidence. Never build,
  launch experiments, unlock workflows or modify remote state during a poll.
  Report failed access or retrieval and the resulting coverage gap.

## Integrate and respond

Apply the convention's evidence and integration rules to every consequential
finding. Compare conditions and competing explanations; update detailed analysis,
entry summaries and the route through the designated coordinator. Other sessions
submit their findings to it. Unchecked findings remain explicitly provisional.
This step does not require a manuscript or a completed research thread.

Report new results with evidence pointers, their scientific implications,
unresolved differences or access gaps, and useful next actions. Check live issue
and PR state before mentioning their status. When nothing changed and coverage
is complete, one line is enough; incomplete coverage cannot establish “all quiet.”

During writing, use `/pc-ms` for manuscript organization and figure import after
scientific state is updated. Propose missing experiments as research route changes;
plans and poll findings do not authorize execution. File issues only when requested,
using `/pc-issue-next` and the target repository's issue quality gate.

Continuous monitoring is optional and requires the user's scheduling request.
Use the runtime's supported monitor or automation facility to inspect configured
remote paths read-only; keep change baselines locally. On a meaningful change,
retrieve the selected evidence and apply this workflow. Report access failures;
do not turn silent SSH failure into “no new results.”
