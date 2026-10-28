---
name: pc-dashboard
description: Launch the read-only local Fleet Dashboard or inspect Fleet evidence as JSON.
---

Register an authoritative Conductor configuration with `pc dashboard serve --config /absolute/path/.epic-config.json`. Registrations persist under `~/.config/pc/dashboard`; use `--data-dir` to select a separate Dashboard store. Worker-local configuration snapshots are refused as authority and invalid registrations remain visible with diagnostics.

Open the startup link privately. The access token stays in the URL fragment and browser session storage; requests require that token and matching Host/Origin. The service binds to `127.0.0.1:4317` and collects until interrupted, even after closing the browser. Use `--port` to change the port, `--no-open` to suppress browser launch, and `--interval` to configure local collection in milliseconds (default 15000). For SSH access forward the same local port and open the startup link through that tunnel.

`pc dashboard status --config /absolute/path/.epic-config.json` prints the same file-evidence contract as JSON and exits. Omit `--config` to inspect remembered registrations. Build with `pnpm run build` before launch.

Expand each row for attributed sources, observation times, blockers and collection failures. Runtime occupancy and execution attempts remain unknown. A phase record does not establish a running agent, completion or slot availability. Refresh is bounded by the collection schedule; clients share cached observations. The Dashboard writes only its own registration/cache data and exposes no workflow controls.

Pass multiple paths after `--config` to register multiple Fleets. `--project <name>` optionally associates newly registered Fleets with a research Project; Fleets work without one. The overview supports Fleet selection, search, phase filtering and evidenced attention items. JSON clients can use `/api/snapshot?fleet=<id>&q=<text>&phase=<phase>&attention=true` with startup authentication. Each task remains scoped to its Fleet even when Issue numbers match.

Intervention reasons cite the status source: recorded blockers, `needs-human`/legacy `blocked` phases and overdue saved checks. For `awaiting-results`, a valid future `awaiting.next_check_at` means planned waiting, even with old file modification times. Missing schedules and runtime evidence remain unknown. File activity uses the latest status/worklog modification time; hand-written `updated_at`, quiet output and an open PR alone do not establish stalled work or a request for approval.

Expand GitHub delivery to inspect explicitly recorded Issue/PR status, CI checks and reviews. Reads reuse `gh` authentication and the checkout's explicit github.com origin; mismatched PR repository links remain unknown. Run `gh auth login` in a terminal when authentication is unavailable. `/api/github` returns cached attributed evidence with observation/last-success times and stale errors. GitHub refresh defaults to 180000 milliseconds; configure `--github-interval`. Refresh respects rate/backoff bounds and never submits comments, approvals or merges. An open PR is not an approval request.
