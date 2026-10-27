# Claude Code background helper

Use with the common lifecycle in [pc-helper](../SKILL.md). Use these commands only when the installed runner supports them.

## Runtime facts

- `claude --bg` sessions ignore the shell's `CLAUDE_CODE_OAUTH_TOKEN` and authenticate from the `env` token in `~/.claude/settings.json`, which the account switch in matsen/setup writes.
- A `--resume` keeps none of the original flags, so every resume passes them again.
- A cross-session message to a session in a different permission mode is held for that session's user to approve.
  Nobody is watching a background helper, so a held message sits there silently.
  Start the helper in your own permission mode with `--permission-mode`; `bypassPermissions` starts without a confirmation prompt.
- A stopped helper disappears from `ListAgents`, so `SendMessage` cannot reach it; resume it first.
- Idle background sessions nobody is attached to are stopped automatically after roughly an hour.
  A helper that has finished and is waiting for you will therefore often be missing from `ListAgents`; that is the expected state, not a failure.
- A `notify_when_idle` notice reaches you only once your own turn ends, so it can arrive long after the helper went idle, and a subscription made while the helper is already idle reports that earlier idle.
  Don't hold a turn open waiting for one: end your turn and act on the notice, or on the helper's report message, when it arrives.
- `claude --bg` prints a short id (`backgrounded · <id> · <name>`); `stop`, `rm`, `logs`, and `attach` take that id.
  `--resume` takes the full session id from `claude agents --json --all`.
- A background session's scratchpad is `~/.claude/jobs/<id>/tmp/`, and `claude rm` deletes it; nothing citable belongs there.

## Working directory

`claude --bg` refuses a directory Claude Code has never trusted ("Workspace not trusted"). A fresh bare home is one, while a worktree of a trusted repo starts.

## Start

Preserve the primary's current permission mode.

```bash
ARGS=(-n "<primary>-<role>" --permission-mode <your-mode>)
OUT=$(cd "$DIR" && claude --bg "${ARGS[@]}" "<brief>" 2>&1)
ID=$(printf '%s\n' "$OUT" | sed -n 's/^backgrounded · \([0-9a-f]\{1,\}\) · .*/\1/p')
SID=$(claude agents --json --all | jq -r --arg id "$ID" '.[] | select(.id==$id) | .sessionId')
```
`<your-mode>` is one of `claude --help`'s `--permission-mode` choices; bypass mode is `bypassPermissions`.
If `ID` or `SID` is empty, stop and show the user `$OUT`; do not guess an id from the listing.

## Confirm reports

Wait for its first report, then send it something and wait for the answer — a real first task serves as the ping, so reserve a content-free one for when you have nothing to send yet.
If either is missing after a few minutes, read `claude logs <id>` and report to the user.
A `failed` state in `claude agents --json --all` most often means the wrong account; a silent helper, a held message.

## Talk and resume

`SendMessage` to its name; its replies arrive as cross-session messages.

- A missing `ListAgents` row requires checking the recorded job before concluding it stopped.
  Resume it with the message as the prompt, rebuilding `ARGS` exactly as in **Start** above:
  ```bash
  OUT=$(cd "$DIR" && claude --bg --resume "$SID" "${ARGS[@]}" "<message>" 2>&1)
  ```
  Without `--permission-mode` its messages are held, and without `-n` it is renamed from the prompt.
  The resume is a new job with a new short id and session id: parse `ID` and `SID` from `$OUT` as in **Start** above, write a new record (common start step 5), and delete the old one.
  `jq .respawnFlags ~/.claude/jobs/<id>/state.json` shows the flags a job actually runs with.
- The user can watch or type to it with `claude attach <id>` (`←` returns to agent view, `Ctrl+Z` to the shell; the helper keeps running either way).

## Stop

`claude stop <id>`, then `claude rm <id>`.
If `rm` reports unpushed commits or a worktree it could not remove, stop and show the user; do not pass `--discard-unpushed` or `--force-remove-worktree` without their go-ahead.

## Sweep

Look up `id` in `claude agents --json --all` and `primary` in `ListAgents`, then report one line per record:

- **stale** — id not in the listing: the session was removed; offer to finish `stop` from step 3.
- **primary not found** — session present but no `ListAgents` row carries the recorded primary name.
  `ListAgents` renames a resumed session (`birch` becomes `birch-61`), so this is not proof the primary is gone; offer to message the helper or stop it.
- **live** — both present: leave it.
