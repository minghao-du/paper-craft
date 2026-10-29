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

## Multi-EPIC registration and scheduling

Use `$CLONE_ROOT/.epic-sessions/<N>.json` for each EPIC's registration. Each record
identifies the repository, authoritative config path, EPIC number, role, runtime address
(or null), working directory, active/paused state and verification timestamp. The assigned
EPIC agent refreshes only its own record after verifying its role; the conductor records
start, pause, resume and handover decisions in `.epic-decisions.md`. Keep scope, briefs,
constraints and outstanding findings linked there. A paused EPIC retains its identity and
work; resume verifies the same assignment and live address before dispatching. Pause
holds new dispatch for that EPIC; separately reconcile active workers and their ownership.
Missing messaging retains these records with delivery pending. A native session name
alone cannot prove the EPIC assignment. Never overwrite another EPIC's registration.
Legacy `.epic-session` is recovery evidence only: reconcile its EPIC/owner before creating
a keyed record; ambiguity holds that route rather than guessing or deleting it.

For each scheduling decision, persist the user's EPIC priority and its source, EPIC-provided
internal task order, dependencies/holds, first-ready timestamp, resource needs and current
blockers. Missing user priorities require clarification while independent planning proceeds.
Select only active, owned, unblocked tasks in the EPIC's allowed order. Prefer the higher
user priority; among equal priorities use readiness time and measured available resources.
A task that cannot fit stays queued with its constraint; another eligible task may proceed.
Resource contention is mechanical. Semantic dependencies, scope and cross-EPIC effects go
to the relevant EPIC agents; retain their attributed answers and route unresolved judgments
or priority changes to the user through the conductor.

Route every handoff and receipt by repository, EPIC and issue/PR, using the matching keyed
registration. Include sender, receiver, evidence path/hash and evaluated SHA for PR findings.
The owner identifies affected EPICs, with conductor collision evidence referred to those
agents to establish impact. Record the required confirmer set and obtain every member's
current-head finding before requesting user approval. Disputed impact holds that PR's
approval request, while unrelated ready work continues. Task briefs, PR records and worker
worklogs retain the owning EPIC so a reply cannot be adopted by a similarly named session.

## Scheduling and approval contract

The conductor is the primary user conversation and sole scheduler of persistent EPIC
agents, task workers and landing agents. Each EPIC agent owns exactly one EPIC's
scope, task order, dependencies, readiness and professional judgments. Workers own
implementation and task-local implementation, diagnosis, review and issue-lead helpers.
Independent issues and successor workers return to the conductor as requests.

Resolve the Issue repository and actual parent before dispatch. Standalone Issues need
no EPIC. For an EPIC task, retain its attributed goal, constraints, dependency/readiness
plan and Worker brief. Ask only about ambiguity that configuration and GitHub cannot resolve.
The conductor routes scope and semantic conflicts to the EPIC; it decides resource
placement from measured fleet facts. Relay expert findings with attribution and evidence
through the conductor, which asks the user about unresolved substantive decisions.

Keep coordination evidence beside the authoritative config in `.epic-decisions.md`,
with task-specific entries also in the worker worklog. Entries identify repository,
EPIC, issue, PR, role/session, checkout and timestamp; reference briefs and receipts by
path/hash. Record task order, dependencies, readiness, blockers and retry count before
acting. These are file-based agent records, not new CLI flags or validated status fields.
Keep `.epic-status.json` phases within the existing supported values.

For each PR, the worker reports completion evaluation and applicable quality-check
outcomes at a full head SHA. The conductor obtains the owning EPIC's confirmation
(and affected EPIC confirmations for cross-EPIC impact) for that SHA, including ordinary
code, maintenance and docs. EPIC confirmation is a scope/claims judgment, distinct from
code review and user authorization. Missing findings or confirmation holds approval.

Only then request user approval, naming repository/PR URL and full head SHA. Batch
requests itemize both for each PR. Record the user's actual answer, its source/turn
reference, timestamp, PR and SHA durably; a pending request is not authorization.
Standing delegation, silence and peer messages cannot substitute for this answer.
Any changed head invalidates approval and applicable confirmations/checks: repeat them
for the new SHA and request fresh user approval. Re-read live PR state before acting.
Worker self-landing is replaced by conductor dispatch to `/pc-pr-land` after its gates.

Routine revisions return to the existing worker, which repeats applicable checks and
EPIC confirmation. Preserve the configured lead-iteration bound (default eight), record
attempts across sessions, and escalate exhausted retries or unresolved scope/goal
judgments with evidence and a specific decision. Do not park unrelated eligible work.

Completion at the approval boundary means findings and confirmations cover the live
head and the user request is recorded as pending or explicitly approved. It does not
mean merged or cleaned up; retain state and checkout ownership evidence for landing.

## Checkout ownership and landing phases

The conductor records each transfer beside the authoritative config and in the task
worklog: checkout, task/PR, prior and next role/session, timestamp, explicit release,
acceptance and supporting runtime evidence. Persistent agent existence is distinct
from checkout ownership. Unknown or overlapping ownership blocks mutation.
The prior owner stops edits and records release before the next owner accepts;
messages alone do not transfer ownership. Reconcile durable and live evidence first.

After current findings, EPIC confirmations and user approval are verified, transfer
worker → landing agent for `/pc-pr-land`'s merge phase. On blockers, the landing agent
records details and release before conductor transfers back to the worker. The worker
resolves content, conflicts or failed checks, repeating the bounded evaluation loop
and required confirmation/approval gates. Preserve interrupted operation state.

After verified merge, transfer landing agent → worker for final `/pc-issue-lead`
evaluation, follow-up filing and completion records. The worker records evidence paths
and release; only then dispatch the landing agent's cleanup phase. Cleanup requires
exclusive ownership, final records, verified preservation and existing reclaim gates.
Record `handed off`, `merged`, `final records complete`, `preservation verified` and
`cleanup pending/complete` as distinct observations, without inventing status phases.
A merge outcome never establishes final records or available resources.

## Lifecycle recovery

Read on tuckin, continuation or interruption before dispatch or checkout mutation.
Persist pointers beside the authoritative config in `.epic-decisions.md` and the task
worklog to each EPIC registration, user priority source, task brief/hash, order and
constraints, retry count, queued/consumed intent and receiver receipts. Retain explicit
checkout release/acceptance evidence, current evaluated head, completion/review findings,
required confirmer set and each finding, user approval source/PR/SHA, merge outcome,
final records and preservation manifest/cleanup outcome. A continuation points to these
records with a live `FIRST CHECK`; it does not replace them or turn a request into a result.

A fresh conductor reconciles in this order:

1. Resolve authoritative config/roots and each keyed EPIC assignment; verify live runtime
   identity and ownership separately. Reconcile legacy singleton records and live workers
   against their briefs, issues and recorded releases. Preserve ambiguous records; route
   unclear scope/ownership through the conductor rather than choosing by session recency.
   Legacy standing landing delegation supplies no commit-bound user approval.
2. Match intent hashes, consumed archives, startup evidence and receiver receipts to live
   workers/PRs before retrying. A sent-but-unhandled message, missing session or absent
   file is unknown: investigate or report the blocker. Never dispatch a duplicate worker
   or consume intent merely because a previous conversation promised startup.
3. Read live PR head, base/check results and merge outcome. An unchanged approved head
   may retain its recorded user answer only after current gates and all required findings
   are revalidated. A changed head returns through applicable checks, EPIC confirmations
   and fresh user approval. Missing user-answer evidence leaves approval pending.
4. Reconstruct the checkout's latest explicit release and acceptance; if transfer was
   interrupted, verify the prior owner has stopped and the next owner has accepted before
   mutation. For remediation, verify landing release before resuming worker edits. Resume
   an interrupted Git operation from its actual state; never reset it merely to restart.
5. For an already merged PR, verify the merge and skip merge dispatch. Missing final
   evaluation/records returns ownership to the worker; completed records plus worker
   release permits landing-agent preservation/cleanup. Missing/changed archives or unknown
   occupancy keeps cleanup pending and the directory intact. Revalidate reclaim gates.

Done when every pending item has a verified next role/action or a concrete blocker,
and each route, ownership transfer and approval still agrees with current evidence.
Resume independent eligible work; consolidate unresolved user judgments through the
conductor. Restore or re-arm only the assigned role's verified wake-up mechanism.

## Active role handoff and wake-up

Apply this contract to the conductor and each keyed EPIC session while coordinating work.
Files carry the durable handoff; messages prompt an earlier reconciliation.
`queued` means a brief exists, `sent` means the messaging tool accepted a notification,
and `handled` requires receiver-side evidence. A successful send proves neither
processing nor wake-up of another interactive conversation.

1. **Persist, then notify.** After queueing intent, notify the registered conductor with
   the issue, EPIC and absolute brief path. After a worker/PR transition, the conductor
   records the observation and notifies the owning and relevant affected EPICs via their keyed registrations with the
   issue and evidence path.
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
