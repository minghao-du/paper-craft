# Claude Code correction delivery

Use after persisting corrections as required by [pc-conductor](../SKILL.md#correcting-a-live-worker-sendmessage-as-a-nudge-channel--execution-half).

- Delivery is not instant: the message drains at the worker's *next tool call*. It is not a substitute for `tmux capture-pane` when you need current state now.
- `SendMessage` only reaches addressable Claude sessions — never a plain shell, a remote SSH job, or a non-Claude compute node. Run `ListAgents` first; when the target isn't addressable, fall back to the file-only correction and wait for the worker's own loop.
- **The address is whatever the selected runner's supported session API reports — `ListAgents` in the Claude branch — read it off its row, or off the message you are replying to, and never compose it.**
  The bare clone name and tmux window name are not native message addresses.
  A composed name that happens to match another session delivers silently to the wrong one.
- A failed send to a name you composed is a typo: re-run `ListAgents` and use the exact name. A failed send to a self-registered address has drifted: skip it (see [Completion pushes](../SKILL.md#completion-pushes-self-registered-addresses-not-listagents-guessing)).

For idle notification, use `notify_when_idle: true` — main conversation only, same machine only, one-shot. A worker in `awaiting-results` with a live `check_cmd` needs no ping.
