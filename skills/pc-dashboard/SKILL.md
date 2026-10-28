---
name: pc-dashboard
description: Launch the read-only local Fleet Dashboard or inspect Fleet evidence as JSON.
---

Register an authoritative Conductor configuration with `pc dashboard serve --config /absolute/path/.epic-config.json`. Registrations persist under `~/.config/pc/dashboard`; use `--data-dir` to select a separate Dashboard store. Worker-local configuration snapshots are refused as authority and invalid registrations remain visible with diagnostics.

Open the startup link privately. The access token stays in the URL fragment and browser session storage; requests require that token and matching Host/Origin. The service binds to `127.0.0.1:4317` and collects until interrupted, even after closing the browser. Use `--port` to change the port, `--no-open` to suppress browser launch, and `--interval` to configure local collection in milliseconds (default 15000). For SSH access forward the same local port and open the startup link through that tunnel.

`pc dashboard status --config /absolute/path/.epic-config.json` prints the same file-evidence contract as JSON and exits. Omit `--config` to inspect remembered registrations. Build with `pnpm run build` before launch.

Expand each row for attributed sources, observation times, blockers and collection failures. Runtime occupancy and execution attempts remain unknown. A phase record does not establish a running agent, completion or slot availability. Refresh is bounded by the collection schedule; clients share cached observations. The Dashboard writes only its own registration/cache data and exposes no workflow controls.

Runtime details show exact-directory tmux pane observations and the pane PID’s process name without reading process arguments. An ordinary shell, dead pane, missing tmux or a recorded Ralph session cannot establish a live agent or free slot. Existing Ralph header identities are labelled recorded and unverified; unsupported Runner capabilities remain unknown. Runtime observations default to 15 seconds; use `--runtime-interval <milliseconds>` to change this independently. Runtime failures retain marked stale successes with their last successful observation time and use bounded probes with per-task backoff. No processes are launched or terminated by observation except the short-lived read-only probes themselves.
