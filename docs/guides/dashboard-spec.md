# Read-only multi-Fleet Dashboard MVP

## Problem Statement

A single user supervises research and development across independent Fleets. Understanding current work requires visiting configuration files, worklogs, terminals, Git checkouts, GitHub and remote compute tasks separately. It is difficult to distinguish work that needs intervention from planned waiting, failed observations or stale evidence. Repeatedly asking an agent to reconstruct this overview also consumes model tokens.

The user needs a simple, local overview that collects existing evidence without invoking models, changing workflow ownership or pretending that incomplete records provide a complete execution history.

## Solution

Provide a locally launched, read-only Web Dashboard with one overview and expandable details. Aggregate explicitly registered Fleets, show active work, blockers, intervention items and collection failures, and expose supporting Git, runtime, GitHub, remote-task and log evidence on demand. Provide basic cross-Fleet search/filtering and a recent-change list.

Preserve the agreed breadth with minimal depth: no six-page management console, scheduling controls or mandatory future control infrastructure. A useful read-only Dashboard is a complete delivery.

## User Stories

1. As a sole operator, I want to launch the Dashboard locally, so that I can inspect my workflow in a browser without a cloud service.
2. As a sole operator, I want collection to continue after closing the browser until I stop the service, so that useful observations do not depend on an open tab.
3. As a sole operator, I want to register a Fleet using its authoritative configuration, so that the Dashboard observes the intended directories.
4. As a sole operator, I want registered Fleets to be remembered across restarts, so that I do not repeat setup.
5. As a sole operator, I want invalid Fleet registrations retained with actionable errors, so that configuration problems do not look like missing work.
6. As a sole operator, I want to inspect multiple Fleets together or select one, so that I can move between a global view and focused investigation.
7. As a sole operator, I want every result to identify its Fleet and any known Project association, so that similarly named tasks are not confused.
8. As a sole operator, I want Fleets without a Project association to work, so that research metadata is not a prerequisite for monitoring.
9. As a sole operator, I want an overview of Conductor, EPIC Agent and Worker evidence, so that I can see who is associated with current work.
10. As a sole operator, I want tasks without an EPIC displayed, so that directly requested work remains visible.
11. As a sole operator, I want task phase, summary, blockers and next required decisions together, so that I can identify intervention needs.
12. As a sole operator, I want work stage, runtime evidence and ownership constraints distinguished, so that a stopped process is not mistaken for a reusable slot.
13. As a sole operator, I want branch, changed files, cached-base relation, collisions and holds in task details, so that I can understand checkout constraints.
14. As a sole operator, I want tmux, Runner and process observations with their limitations, so that a terminal window is not mistaken for proof of an active agent.
15. As a sole operator, I want Issue, PR, CI and review information, so that I can inspect delivery progress without switching tools for every check.
16. As a sole operator, I want configured remote tasks with explicit workflow associations displayed, so that I can follow experiments without guessing process ownership.
17. As a sole operator, I want worklogs as the default log view, so that I can read the recorded progress of a task.
18. As a sole operator, I want bounded terminal output and existing Runner logs on demand, so that I can investigate without loading or archiving entire sessions.
19. As a sole operator, I want segmented log loading, manual refresh and copying, so that large logs remain usable.
20. As a sole operator, I want log sources, read times and failures shown, so that absent output is not mistaken for an empty successful read.
21. As a sole operator, I want basic search and filtering across Fleets, so that I can locate a task without navigating many pages.
22. As a sole operator, I want intervention items derived from explicit records or deterministic rules with supporting evidence, so that I understand why my attention is requested.
23. As a sole operator, I want an open PR distinguished from an explicit approval request, so that the Dashboard does not invent pending decisions.
24. As a sole operator, I want planned waiting distinguished from suspected staleness, so that long experiments do not produce misleading warnings.
25. As a sole operator, I want unknown and conflicting evidence displayed explicitly, so that incomplete observations do not become false certainty.
26. As a sole operator, I want successful observation times and stale values visible after a source fails, so that I can judge what information remains useful.
27. As a sole operator, I want one failed or slow source isolated from other sources, so that partial monitoring remains available.
28. As a sole operator, I want meaningful changes retained for 30 days, so that I can inspect recent observed progress.
29. As a sole operator, I want monitoring gaps marked after downtime, so that the change list does not imply uninterrupted coverage.
30. As a sole operator, I want indistinguishable execution attempts marked as unknown, so that retries are not assigned invented identities or histories.
31. As a sole operator, I want conservative configurable collection intervals and failure backoff, so that monitoring uses limited local and remote resources.
32. As a sole operator, I want multiple browser clients to share collection results, so that opening another tab does not multiply probes.
33. As a sole operator, I want manual refresh to remain read-only and bounded, so that investigating does not invoke agents or fetch Git refs unexpectedly.
34. As a sole operator, I want collection, aggregation, intervention classification and history recording to use no models or agent messages, so that routine monitoring consumes no additional LLM tokens.
35. As a sole operator, I want existing GitHub authentication and SSH configuration reused, so that I do not place passwords or private keys in the Dashboard.
36. As a sole operator, I want interactive remote authentication requirements reported clearly, so that background probes do not hang awaiting input.
37. As a sole operator, I want loopback-only access protected by a startup token and request validation, so that private workflow evidence is not freely readable by other Web pages.
38. As a sole operator, I want access through an SSH tunnel with the same token protection, so that remote viewing does not require a public service or account system.
39. As a sole operator, I want the Dashboard to leave workflow files, Git checkouts and running tasks unchanged, so that observing cannot dispatch, reclaim or terminate work.

## Implementation Decisions

- **Product boundary:** one overview with Fleet filtering and expandable details; basic tables, search/filtering and a recent-change list. Keep broad observation coverage with minimal presentation depth.
- **Domain language:** Project retains its existing meaning as a research project grouping related repositories. Fleet is an independently configured workflow unit containing a Conductor, its configured EPIC Agent and a working-directory pool. Do not expand the existing one-EPIC-agent-per-Conductor relationship; user-originated work can lack an EPIC.
- **Architecture:** React + Vite front end and a Hono local service in the existing TypeScript workspace. CLI and server depend on Core's public interfaces; Core does not depend on React, Hono or concrete Runner integrations. Extract only aggregation logic actually shared by CLI and Web, rather than building a general monitoring framework.
- **Entry points:** provide the locally launched Dashboard command and a JSON status command using the same aggregation semantics. Launch the browser using startup access protection. The service keeps collecting until explicitly stopped, with no default boot startup.
- **Registration:** persist explicit authoritative configuration registrations in pc-owned local configuration/data storage. Project association is optional. Reuse existing authoritative configuration resolution and physical-path checks; reject Worker-local snapshots as authority. Invalid registrations remain visible with diagnostics. Registration is local setup, not an arbitrary workflow-write HTTP endpoint.
- **Read-only boundary:** the service may update its own registrations, observation records and retention data; it must not mutate workflow source files, Git refs/checkouts, holds, tasks or remote jobs. No workflow control routes or terminal-input endpoint. Monitoring and manual refresh do not invoke Git fetch.
- **Existing reuse:** reuse Core's Fleet configuration and read-only currency/collision checks where appropriate, with cached Git evidence. Existing occupancy evidence is unknown; runtime observations must not turn into launch/reclaim authorization. Existing Git probes are synchronous, so collection must explicitly bound/isolate blocking work rather than assuming an existing asynchronous monitoring service.
- **Observation contract:** snapshots distinguish phase, runtime evidence and scheduling/ownership constraints. Expose source attribution, observation time, last successful value/time, freshness, errors and uncertainty. A failed source must not erase other evidence. Do not invent a stable execution identity from an Issue number, slot, pane or collection identifier.
- **Snapshot and HTTP contracts:** expose authenticated read-only aggregate snapshots, task/Worker details, bounded logs, observation history and collection health. Snapshots carry generation time and a version that allows clients to detect changed observations. Preserve Fleet context and distinguish missing data from failed collection. Exact endpoint spelling and type layouts are implementation details, not additional product scope.
- **Intervention rules:** use explicit records and deterministic rules only. A PR being open is not an approval request. Use existing workflow staleness and planned-waiting semantics, including file modification evidence and saved check schedules. Quiet output, clean Git, absent tmux or an old phase record cannot prove exit, completion or availability. Present conflicting evidence rather than suppressing it.
- **Collection schedule:** default to 15 seconds for local state/terminal/process evidence, 60 seconds for Git, 3 minutes for GitHub and 5 minutes for associated remote tasks. Make intervals configurable. Cache results across clients, avoid overlapping probes for a source, use finite timeouts and failure backoff, and keep expensive probes off request paths. Manual refresh is bounded and subject to backoff/rate constraints.
- **Remote observations:** observe only configured hosts and explicitly associated tasks. Do not poll hosts with no associated tasks or scan arbitrary processes to infer ownership. Reuse local GitHub login and SSH configuration; remote execution is noninteractive and time-bounded. Missing capabilities, credentials or connection requirements produce diagnostics while local monitoring continues. Invoke fixed programs with validated argument arrays, not request-supplied shell strings.
- **Logs:** default to the worklog, with bounded on-demand terminal output and existing Runner logs where safely identifiable. Support segmented loading, refresh and copy; expose source/read time and actionable failures. Restrict reads to validated registered sources; avoid disclosure of credentials and private prompt material. Do not continuously archive full terminal output.
- **History:** retain meaningful observed changes for 30 days in pc-owned local file-based storage; respect the repository's JSONL persistence direction. Do not persist every complete polling snapshot. Record monitoring interruptions and observation timestamps; do not claim to reconstruct changes during downtime or provide a complete execution audit. Retention must not delete workflow sources.
- **Token use:** do not invoke models, start agents, send status into agent conversations or generate LLM summaries for any refresh, collection, intervention rule or history operation. HTTP/API/SSH traffic is resource usage distinct from LLM token consumption.
- **Security:** bind to loopback, require a startup access token and validate Host/Origin requests. Apply protection to evidence, logs and health endpoints as well as snapshots; use the same protection through SSH tunnels. Do not log access credentials or store passwords/private keys. No user accounts or interactive login flow.
- **Compatibility and documentation:** preserve existing CLI/MCP workflow behavior and file contracts. New capabilities must be documented through the repository's skill-first conventions, with real command help matching the workflow. Do not introduce native addons or external database services.

## Testing Decisions

The user confirmed the following test boundary before publication.

- **Primary seam:** exercise the assembled local service through its public HTTP read interface. Use real temporary authoritative configurations, state files and Git checkouts. Substitute only external process/network boundaries such as tmux, Runner, GitHub and SSH responses; control time to test intervals and retention without real waits. This is a new HTTP boundary over existing Core behavior, not a new mockable interface for every collector.
- **External behavior:** assert returned evidence, errors, source times, history, access rejection and preservation of source data. Avoid testing private helpers, component state, exact call order, chosen class layout or internal snapshot representation.
- **Core regression scenarios:** cover multiple Fleets and work without an EPIC; partial failure and stale/conflicting evidence; planned waiting versus suspected staleness; unknown occupancy and indistinguishable retries; refresh isolation, shared cache and bounded remote probes; observed-change retention, restart gaps and source preservation. Combine related behavior in a small number of representative integration scenarios rather than duplicating the same assertions at every layer.
- **Access and read-only checks:** through the same HTTP seam, verify missing/invalid credentials and disallowed request origins are rejected; unregistered/escaping log paths are refused; log responses remain bounded; unsupported control requests cannot mutate source files, Git state or process/job state. Observe external invocations in the test harness to catch model/agent launches or Git fetch during collection and refresh.
- **CLI and browser edges:** add a thin launch/JSON-status compatibility check using the same fixtures, plus a focused browser smoke check that a user can filter Fleets, expand evidence, read segmented logs and see partial-failure indicators. Do not introduce a separate full UI test hierarchy or duplicate the service matrix in component tests. Manual browser verification is sufficient unless an existing suitable harness is available.
- **Prior art:** existing portable-workflow tests use temporary authoritative configuration, real Git clones, Core public exports and spawned CLI processes, including symlink/path rejection and unknown occupancy. Existing MCP transport tests compare public adapter output with compiled CLI behavior and verify source preservation and recovery after malformed data. Follow those fixture-driven public-contract patterns.
- **Execution budget:** use deterministic local fixtures and clocks, never live credentials, live HPC jobs or multi-minute polling sleeps. Each added test must target a concrete regression and complete within 120 seconds. Run relevant integration checks, build, lint, typecheck and command-help validation when implementation occurs; no implementation tests are added by this specification task.

## Out of Scope

- Implementation as part of this spec-writing/publishing task. Publishing an issue does not authorize starting it.
- Dispatch, pause/resume, retry, slot reclaim, process termination, merge actions, approval submission or terminal input.
- Command queues, Command Gateway, ConductorBridge, future control-policy scaffolding or a committed control-plane milestone.
- Changes to Conductor/EPIC/Worker responsibilities, ownership gates, approval policy or one-EPIC-agent-per-Conductor behavior.
- New mandatory Worker execution-identity records, reconstructed complete retry history, inferred process ownership or authoritative audit claims from observed changes.
- Multi-user accounts, team permissions, public hosting, mandatory cloud services or default boot startup.
- Six fully developed management pages, DAG editing/visualization, historical replay, trend charts, push notifications or browser configuration editing.
- SSE, a separate database service, generic collector/plugin frameworks or continuous full-session log archival.
- Arbitrary filesystem discovery, remote process scanning, shell execution endpoints, interactive Web authentication or credential management.
- Changes to existing research data formats, CLI/MCP contracts or workflow source writers merely to support observation.

## Further Notes

This spec supersedes the broader external architecture proposal wherever they differ. In particular, the original staged control platform is not an agreed roadmap; the read-only MVP stands on its own.

Existing configuration/Fleet checks are reusable foundations, not an existing Monitoring Service. Runtime occupancy may remain unknown, and stable execution identity is not guaranteed by current records. Approval presentation must respect existing repository-specific authorization rather than inventing a universal new approval gate.

The agreed domain distinction between Project and Fleet and the decision that Dashboard history records observations rather than execution identity remain binding. Existing unrelated local workflow/recovery changes must be preserved.

Apply the canonical `ready-for-agent` label when publishing. It describes specification readiness; the user's explicit instruction remains to stop before implementation.
