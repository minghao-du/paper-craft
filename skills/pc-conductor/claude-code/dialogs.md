# Claude Code permission dialogs

Use when sweeping Claude panes during [conductor reconciliation](../SKILL.md).

Sweep on every reconciliation; the following text match and cancellation keys are the Claude Code branch, so inspect the selected runner's actual dialog before acting:

```bash
for p in $(tmux list-panes -a -F '#{pane_id} #{pane_current_path}' | /usr/bin/grep -F "$CLONE_ROOT/" | awk '{print $1}'); do
  tmux capture-pane -p -t $p | /usr/bin/grep -q 'Do you want to proceed?' && echo "MODAL: $p"
done
```

Cancel with `Escape`; never send `Enter` or select "Yes" (the cursor sits on "1. Yes"). Then tell the worker what was blocked and that you declined. A subagent's modal surfaces in its parent's pane. For a slot "waiting on a subagent", ~20 minutes with no output is worth a sweep.
