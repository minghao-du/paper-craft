# Codex CLI

Read for a Codex pane. Confirm installed flags with `codex resume --help`.

Setup adds `SessionStart` and `UserPromptSubmit` recording handlers to `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`), preserving existing hooks. In Codex, open `/hooks` and review/trust the two handlers once. Codex skips untrusted hooks. A changed hook definition needs review again; see [official hooks documentation](https://learn.chatgpt.com/docs/hooks).

Launch through `"$HELPER" run codex [arguments...]`, or the installed zsh function. The launcher uses `--no-daemon` so the hook is a descendant of the process assigned to this pane; a shared background daemon's inherited `TMUX_PANE` is insufficient evidence. Recording stores the hook's `session_id`, including after a new conversation, resume, fork, or compaction, only after validating process ownership. A directly launched or remote Codex process without verified recording remains unresolved.

For first-time adoption, read the exact current ID from Codex's own session view and register it from another terminal:

```sh
"$HELPER" bind codex <session-id> --pane <target>
```

Manual registration applies to that conversation while the process remains alive. Re-register after switching conversations if the recording hooks are not active. Check `status` before shutdown.

Recovery executes `codex --no-daemon resume <session-id>` from the saved directory, with no prompt or permission-bypass flags. Keep `$CODEX_HOME` and its stored conversations available. Model, approval and other CLI settings come from the runner's current configuration; transient launch flags are not replayed. Verify the original chat is visible and waiting; startup errors or hook-review prompts remain visible in the pane.
