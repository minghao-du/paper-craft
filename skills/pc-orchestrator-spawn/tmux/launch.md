# Checked tmux launch

Run after the common ownership, input and launch checks in [pc-orchestrator-spawn](../SKILL.md#step-5-launch-tmux-window).

1. Create a tmux window named `<N>-<clone-name>` or `<N>-issue-<N>` in the exact checked directory.
2. Establish launch arguments and prompt input from the installed runner's help, and deliver the complete brief as one message. Prefer supported prompt-file input, an initial-prompt argument or stdin; first verify that the method enters the required persistent session. Do not assume arguments, redirection and interactive paste are interchangeable.
   - For multiline input into an interactive runner such as agy, wait for its input interface and use verified bracketed paste. With tmux, use `load-buffer -b <unique-buffer-name> <prompt-file>`, then `paste-buffer -p -b <unique-buffer-name> -t <pane-id>`; `-p` only applies when the target application enables bracketed paste. Verify that the complete text remains one pending message, then send Enter once separately. If this cannot be verified, use a supported file-input method rather than ordinary multiline keystrokes.
   - If the first line starts execution while the remaining paragraphs appear as queued messages, treat delivery as failed. Preserve the pane identity and failure evidence, and inspect current work and queued input before choosing recovery. Do not append the whole brief, restart or launch a duplicate worker.
3. Record the returned pane identity, verify the directory, and apply the common Step 5 acceptance criteria for complete delivery and worker initialization. A process or first tool call establishes startup activity only.
4. If verification fails, leave intent queued as `prepared` or `launch-failed`; otherwise return to **Step 6: Confirm** in the common workflow.

## EPIC specialist windows

For post-merge Pipeline Audit or Research State, use the managed EPIC completion
specialist entry described in [Orchestrator finalization](../../pc-orchestrator/finalization.md).
It attributes work to the original EPIC and opens separate windows in the verified
existing session. This terminal tail does not bypass Worker intake requirements.
