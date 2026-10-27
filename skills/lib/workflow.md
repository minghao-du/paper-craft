# Portable workflow contract

Read this before fleet scheduling, task handoff, state preservation or reclaim.
The baseline requires Node.js, the installed `pc` CLI, Git and file access.
GitHub-specific checks additionally require authenticated `gh` access.
Use the same protocol from Codex, Claude Code, Antigravity or any other harness with these capabilities.

## Configuration and scope

Use the conductor's authoritative `.epic-config.json`, passing its absolute path with `--config` when working elsewhere.
Worker copies whose `main_checkout` points elsewhere are refused.
Relative paths resolve beside the config file; `~` expands to the home directory.

```json
{
  "main_checkout": "/path/to/project",
  "clone_root": "/path/to/pool",
  "clone_names": ["cedar", "pine"],
  "base_branch": "main",
  "local_worktrees": false
}
```

Both directories must already exist.
Clone slots come from `clone_names`; worktree slots are `issue-<N>` directories directly under `clone_root` when `local_worktrees` is true.
Research data remains in nexus; workflow state may live in this configured project and pool.
Read the output's `scope` before acting on fleet checks.

## Commands and completion criteria

```sh
pc workflow root --config /path/to/project/.epic-config.json --path
pc workflow intent write 123 --prompt-file /path/to/brief.md --config /path/to/project/.epic-config.json
pc workflow intent find 123 --config /path/to/project/.epic-config.json --path
pc workflow intent consume 123 --config /path/to/project/.epic-config.json
pc workflow preserve --dir /path/to/pool/cedar --reason "before landing PR 456" --config /path/to/project/.epic-config.json
pc fleet currency --config /path/to/project/.epic-config.json --fetch
pc fleet collisions --config /path/to/project/.epic-config.json --fetch
pc fleet reclaim-check --dir /path/to/pool/cedar --config /path/to/project/.epic-config.json
```

Default output is JSON; `root` and `intent find` support `--path` for shell assignment.
Exit 0 means the requested file operation or Git/file check succeeded; 1 means an observed problem (or absent intent); 2 means the operation could not establish its result.
Check exit codes directly, without piping the command into another program.
`reclaim-check` is read-only, always reports `eligible: false` and exits 2 because portable runtime occupancy and GitHub completion checks are not yet available.

- **Intent:** lookup prefers `<N>.md` and also accepts legacy `spawn-<N>.txt`.
  Queueing refuses to overwrite either form.
  Reconcile duplicate current/legacy briefs before launching; consumption refuses to leave a second queued copy behind.
  Consume only after the worker has actually started with the intended brief in the intended directory; preparing a prompt is not successful launch.
  Consumption moves the selected brief to a unique directory under `.spawn-prompts/consumed/`.
- **Preserve:** the status file must be valid JSON; the worklog is optional and its absence is recorded.
  Success returns a unique archive path, hashes and a manifest under `.preserved/`.
  Originals remain in place on success and failure.
  Verify `status: preserved`, inspect the manifest and ensure the source has not changed before any separately authorized cleanup.
- **Currency:** checks branch, dirty files, holds and commit relation against origin's base branch.
  A current clean checkout is not evidence that the directory is unoccupied.
- **Collisions:** conservatively checks every registered slot, including committed, staged, unstaged and untracked files, and overlap with files landed on base since each branch forked.
  It does not infer which sessions are alive or declare state files stale.
- **Remote freshness:** default checks use cached refs and label them `cached`.
  Before scheduling, use `--fetch`; a failed refresh makes the check unknown, not clear.
  Different origins, missing slots, detached heads, unreadable Git state and mismatching cached bases are reported as unknown.

## Runtime capabilities

Tmux is a supported shared dependency for fleet terminal orchestration across agent runners.
Keep the terminal layer separate from the selected agent executable: use that runner's actual supported invocation, prompt input and resume behavior.
Read installed CLI help before composing a launch; Claude-specific flags, transcripts and slash commands belong only to the Claude Code branch.
The Git/file commands above can run independently of tmux.

Use file-based briefs, `.epic-status.json` and `.epic-worklog.md` as the durable handoff.
Record observations with timestamps; terminal task state and runtime occupancy are separate facts.
Use tmux for terminal placement and observation, and the selected runner's supported startup and reset behavior, within the user's authorization and the harness's tool rules.
Native launch and messaging tools are additional environment capabilities.
In existing skills, `ListAgents`, `SendMessage`, `Agent`, `Monitor`, `Skill`, Ralph commands and Claude transcript paths describe that harness's branch.
Use an equivalent only when the current harness exposes it and the user authorized the action; otherwise persist the handoff or notification and report delivery pending.
Invoke a skill by reading its text when a native skill tool is unavailable.
Keep every scope, ownership, preservation, review and stopping-point gate in the original procedure; changing runners does not waive a gate.
An independent issue-lead evaluation may run through tmux or native agents; if unavailable, leave the gate pending rather than replacing it with self-approval.
Use the explicitly assigned role and task markers when a native session identity is unavailable; a missing address never establishes vacancy or permission.
Runtime process and dialog examples are conditional on the selected runner and host OS; inspect actual capabilities before using their commands or keys.
If the selected runner cannot be launched through the available tools, provide the brief path, working directory and next instruction for a user or another agent to resume.
Report `prepared` until startup is confirmed; leave intent queued in that state.

The portable CLI currently supplies neither `pc spawn` nor `pc fleet watch` nor destructive reclaim.
Re-run fleet checks and read status files when observing progress; use a supported runtime monitor only when available.
Unknown occupancy blocks directory reuse, checkout reset, process termination and deletion.
Missing sessions, windows or status files are not proof of vacancy.
A tmux pane identifies a terminal, not a live agent: the runner may have exited while its shell or background jobs remain.

## Active role handoff and wake-up

Apply this contract to a conductor and its EPIC session while coordinating work.
Files carry the durable handoff; messages prompt an earlier reconciliation.
`queued` means a brief exists, `sent` means the messaging tool accepted a notification,
and `handled` requires receiver-side evidence. A successful send proves neither
processing nor wake-up of another interactive conversation.

1. **Persist, then notify.** After queueing intent, notify the registered conductor with
   the issue, EPIC and absolute brief path. After a worker/PR transition, the conductor
   records the observation and notifies the registered EPIC with the issue and evidence path.
   Use the runtime's supported addresses; absent/failed messaging leaves a pending handoff.
2. **Reconcile on wake.** Verify current state before acting on a message. The conductor
   checks queued briefs, slot status/worklogs and linked PRs; the EPIC checks conductor
   decisions/notifications, consumed briefs and its tracked issues/PRs. The conductor's
   `.epic-decisions.md` and `.epic-notifications.log` live beside the authoritative config.
   Run the relevant role steps for changed or unresolved work.
3. **Acknowledge handling.** The conductor appends a timestamped receipt to its
   `.epic-decisions.md`: issue, brief content hash, and `started`, `deferred` or `launch-failed`,
   with pane/session evidence or the concrete blocker. Notify the EPIC of that receipt.
   Append and send only when the brief hash, outcome or blocker changes; unchanged receipts
   and acknowledgements need no reply.
   Only verified startup permits intent consumption. Messages, receipts and timers preserve
   all existing ownership, review and merge-authorization gates.
4. **Deduplicate.** Recheck live issue ownership and consumed intent before every launch.
   Repeated messages, acknowledgements and timer ticks do not create another worker.
   Retry deferred work when its blocker changes; a missing acknowledgement triggers
   reconciliation, not re-queueing. Record EPIC decisions in its existing body/local copy
   so unchanged transitions do not generate duplicate issues.
5. **Arm before yielding.** While coordination remains active, keep one confirmed native
   wake-up per role conversation, including when its queue is temporarily empty. Inspect
   the runtime task manager, reuse an active role timer or replace an expired one, and retain
   its exact returned identity. On every message or timer wake, reconcile and re-arm before
   ending the turn. Report changes or required user action; keep unchanged polls quiet.

### Runtime wake-up

For Antigravity sessions exposing `schedule`, read [the Antigravity wake-up procedure](antigravity/wake-up.md) before arming a timer.
Other runners may use a verified equivalent. Promise automatic pickup only with a confirmed wake-up; shell sleeps, another process resuming the same live conversation, and tmux keystrokes are not substitutes.
If registration fails or no supported tool exists, retain durable intent and report `manual continuation required` with the next role command.
On explicit pause, stop or role handover, cancel only the conversation's registered timer; restart/re-entry must inspect tasks and establish one active timer.

## Installation

Run `scripts/link-skills.sh` from this repository to install the default skill locations.
For another harness, use `scripts/link-skills.sh --dest /path/to/its/skills` after identifying its actual skill directory.
This links each skill and the shared `lib/` references; conflicts are reported without deleting existing directories.
Install the repository dependencies with `pnpm install`, then expose the repository's `pc` launcher on PATH separately.
The launcher preserves the caller's working directory and can be reached through a symlink.
Verify a linked skill can read `../lib/workflow.md` and `pc workflow --help` succeeds in the harness environment.
