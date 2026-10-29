# Checked tmux launch

Run after the common ownership, input and launch checks in [pc-conductor-spawn](../SKILL.md#step-5-launch-tmux-window).

1. Create a tmux window named `<N>-<clone-name>` or `<N>-issue-<N>` in the exact checked directory.
2. Use the actual runner executable and arguments established from its installed help, within the task authorization. Prefer supported prompt-file input over shell-interpolated multiline text.
3. Record the returned pane identifier and verify the directory and actual runner startup with the intended brief. A pane alone does not establish that a worker started.
4. If verification fails, leave intent queued as `prepared` or `launch-failed`; otherwise return to **Step 6: Confirm** in the common workflow.

## EPIC specialist windows

For post-merge Pipeline Audit or Research State, use the managed EPIC completion
specialist entry described in [Conductor finalization](../../pc-conductor/finalization.md).
It attributes work to the original EPIC and opens separate windows in the verified
existing session. This terminal tail does not bypass Worker intake requirements.
