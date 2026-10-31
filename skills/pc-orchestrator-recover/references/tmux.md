# Plugin setup

Read when installing recovery, inspecting save configuration, or handling several tmux servers.

Run `"$HELPER" setup` on the target host. This installs [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) and [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum) under `~/.tmux/plugins/`, copies the standalone helper to `~/.local/share/pc/tmux-recovery/`, and adds a source line to the existing tmux config and `~/.zshrc`. Modified files receive adjacent `.before-pc-recovery-*` backups. Repeat setup after updating the skill to update the installed helper.

The generated tmux fragment is `~/.config/pc/tmux-recovery/tmux.conf`. It sets a five-minute interval, enables startup restore, and saves to `~/.local/share/pc/tmux-recovery/snapshots/last`. Load it after themes/plugins that change `status-right`; continuum saves through that status callback and requires the status line to remain on. With no attached client updating the status line, use an immediate save before shutdown.

New zsh terminals load tracked `codex` and `agy` launchers inside tmux. Existing shells must source `~/.config/pc/tmux-recovery/launchers.zsh`. For another shell, invoke `"$HELPER" run codex` or `"$HELPER" run agy`. Outside tmux and for ordinary subcommands, the zsh functions pass through to the installed CLI.

Source the tmux configuration on an existing server. New servers load it automatically. Continuum auto-restores only at server start, so sourcing configuration later does not trigger recovery; use `"$HELPER" restore` then. No operating-system login service is installed.

Resurrect owns layout fidelity. Its post-save-layout hook replaces agent process entries with exact-ID recovery callbacks in the **same snapshot**; ordinary terminal processes return as shells. Binding records include the owner's PID and start time, and are accepted only while that owner belongs to that pane. They expire when the process exits. A callback from an unrelated/shared daemon cannot overwrite a pane's identity.

## Multiple servers

The helpers and plugins operate on one server at a time. Select a server from a shell attached to it (`TMUX` identifies its socket), or supply that server's `TMUX` value explicitly. For every additional server, set a distinct `@resurrect-dir` **after** sourcing the generated fragment. Continuum defaults to saving only the first server; follow its [multiple-server configuration](https://github.com/tmux-plugins/tmux-continuum/blob/master/docs/multiple_tmux_servers.md) before claiming all servers are protected. Check every server's `last` snapshot separately.

## Removal

Remove the added source lines from the tmux config and `~/.zshrc`, restore the backed-up Codex hooks and agy settings (preserving subsequent user edits), and reload/restart the affected programs. Snapshots and plugin checkouts remain available until deliberately removed. Snapshots store directory paths and conversation IDs, not copies of conversations; each runner's own conversation storage must survive.
