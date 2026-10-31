# Recovery verification

Read after changing the helper or installation behavior. Follow `test-budget`: each complete isolated test, including setup and cleanup, must finish within 120 seconds.

Use temporary tmux sockets and snapshot directories. Load resurrect without the user's tmux config, point its save hook to the changed helper, and use fake `codex`/`agy` executables that report their received arguments and emit realistic lifecycle/status callbacks. No model request or real reboot is required.

Check one round trip with two agent panes in the same directory, a split layout, a named ordinary terminal, and an unresolved agent. Assert names, directories, pane count and geometry, distinct exact conversation IDs, resume arguments without a prompt, and the unresolved notice. Restore twice and verify an existing pane does not receive a second command.

End one tracked process, leave its old binding behind, and verify the next snapshot drops that ID. Send a callback from outside the owning process tree and verify it cannot replace another pane's ID. Include spaces and shell metacharacters in directories and confirm no command executes from path text.

Exercise setup twice with temporary HOME and a pre-existing hook/status command. Verify no duplicate hook or source line, unchanged unrelated settings, forwarded status output, and backups for edited files. Delete only test-owned tmux servers and files in cleanup. Separately report real CLI hook-trust and model-backed conversation checks as unverified unless actually performed.
