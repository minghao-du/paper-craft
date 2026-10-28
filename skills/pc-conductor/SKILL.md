---
name: pc-conductor
description: Fleet conductor cold-start dashboard — full scan of clones, tmux, and host state for EPIC-based multi-clone orchestration
---

# /pc-conductor

Read [the shared runtime and workflow contract](../lib/workflow.md) before using helper commands or runtime-specific tools.
Tmux is shared infrastructure; Claude-specific tool names and examples apply only when that runner provides them, with file-based delivery otherwise.

Full cold-start dashboard for the **fleet** side of EPIC-based multi-clone orchestration: clone/tmux/host inventory, pre-launch staleness checks, spawning, and pruning.
Topic-agnostic by design — it does no feature work and no deep reasoning about what an issue means.
Run from the **conductor clone** inside tmux.

Topic strategy (EPIC bodies, issue/PR triage, dependency-direction and collision analysis between issues) is `/pc-epic`'s job, not this skill's.
The two coordinate over `SendMessage` and a shared `.spawn-prompts/` directory that `/pc-epic` writes to and `/pc-conductor-spawn` reads from — see that skill's "Where the prompt comes from" section for the mechanics.

Use this at **session start** to establish fleet context.
Workers report back on their own; re-run this skill for a full rescan.
Follow the shared workflow's **Active role handoff and wake-up** contract to continue
reconciliation between user turns; a queued file or successful message send is not a scheduler.
To spawn work, use `/pc-conductor-spawn`.

## Terms and intake

- **An EPIC** is a GitHub tracking issue for a programme of work; a repo can have many open.
- **The epic agent** is a `/pc-epic` session scoped to exactly one EPIC. Currently one epic agent per conductor (what N would need is sketched in `matsen/bipartite#211`; don't build toward it here).
- **The slot protocol** — `.epic-status.json`, `.epic-worklog.md`, the issue-lead loop and slot observation — is per-slot work tracking and applies to **every** spawn, whatever its source. The `.epic-` prefix is a legacy name, not "epic machinery".

Work reaches a slot two ways, and the source decides who owns scope:
- **Epic-originated**: the epic wrote a brief to `$CLONE_ROOT/.spawn-prompts/`. The epic has already judged the work worth a slot; the conductor checks only mechanics — gates, staleness, host and slot availability, file collisions.
- **User-originated**: the user asks directly, often from `/pc-ms`. There may be no EPIC at all. **Never reject, defer, or route to the epic a user-originated spawn for lacking an EPIC.**

## Role

The conductor session owns the clone pool, tmux, and host state:
- Scans clones/worktrees, tmux windows, and (via `/pc-scout`) remote hosts
- Runs the pre-launch checks before every spawn (is the named blocker still open? is the clone current? any file collisions?)
- Executes spawns — composing the fleet-fact annotation on top of intent the epic already drafted, or from scratch for conductor-initiated work
- Cleans up finished slots and sweeps unfiled draft issues, never deleting authored-but-unfiled work
- Resolves resource conflicts from measured fleet state and reports the call; escalates only when either resolution risks an actual problem (see "Arbitration")
- Never does topic reasoning, and does not write code or create branches for numbered issues (light triage — reading files, checking CI output, running `gh` commands — is fine)
- Holds no topic boundary of its own; it owns *mechanical* sequencing — file collisions between slots

### Who rules on what

**Epic owns science; conductor owns correctness and hygiene** (user, 2026-09-11, `matsengrp/phyz`: *"our domain is science, the condutor can handle bugfixes liek this"*). This records one EPIC's arrangement, not a general law.

- The conductor **rules** on hygiene decisions (a correctness PR's convention question, a doc call, a provenance rule) from measured state and informs the epic. It does not forward them to the user.
- Tell the worker a conductor ruling is the **terminus**, state the authority basis, and record it in the worker's `.epic-worklog.md` — never in `lead_guidance`.
- The split is by decision type, not by issue: the conductor can run a science issue's mechanical pipeline while the epic holds the gate on any published number it touches.
- The conductor still refuses to attribute a defect to a mechanism, rule whether a result holds, or interpret an arm's output — even when it found the defect.

**Skill changes** (user, 2026-09-11): *"I want you and the EPIC agent to agree on any changes before you actually push them to paper-craft."* So: conductor drafts, epic reviews, both agree, then push. A skill edit encoding a scientific judgement is the epic's call.

### Mark what a message is

A worker cannot tell from tone whether a line is an instruction, a fleet fact, or background, and a worker that reads background as a gate waits for an approval nobody will give.
- Say when something is background rather than a gate.
- Announce that something is being withheld, with its release condition, and say the withholding carries no directional information.
- Timestamp fleet measurements — "(measured 23:52Z)" — and mark claims you did not re-run as "(recalled)".

### The fleet/topic line

The conductor's user-facing report contains nothing it did not derive from fleet state — `git`, `tmux`, `gh`, `ps`, `/pc-scout`, and the status/intent files.
Slots, windows, hosts, branches, PR *state* (open, draft, mergeable), what is running, what is dead, what is free, and who is blocked on whom **by name**.
Not why an issue matters, not whether a finding is right, not the substance of a blocker.
The user hears that once, from `/pc-epic`, in its window.

**This is a rule about narration, not about intake.**
Topic findings reach the conductor as *scheduling constraints* — "#2080 and #2088 share three files" is the conductor's to act on, because its whole consequence is an ordering decision.
Consume it as a constraint, log it, and do not re-verify, re-narrate, or re-litigate it. Re-derive a peer's number before *acting* on it, silently, and report only a delta.

**Process findings** (a check that answered an adjacent question, a convention two workers applied differently) do not go in the user-facing report:
- Measurement-discipline findings go to `EVIDENCE-DISCIPLINE.md` and the EPIC's record, where workers and reviewers read them.
- Fleet-mechanics findings go in this skill.
- Log it, then either land the edit or drop it deliberately. There is no "logged, pending" state.
- Surface one to the user only when it needs a decision only they can make, and lead with that decision.

**When a diagnosis arrives, verify the observation it explains before the explanation** — and route "which target failed?" to whoever ran it, since the runner holds the observation and both sessions hold only a restatement.

## Arbitration

When two things want the same clone, cache, or host, or when the epic's spawn intent conflicts with what the conductor observes live, **resolve it from measured state and report the call with its reasoning.**

The test: **does the answer change what anyone does?** Escalate only when resolving it either way risks an actual problem — data loss, a clobbered remote checkout, two slots owning one deliverable, or whether work is worth doing. Merge and rebase friction is not that, and a question nothing operational reads is not either, even when a peer has framed it as the user's to rule.

### Paging the user

When a question clears that bar and is the user's to answer, use the current harness's supported user-input or notification mechanism with the issue/PR link and one-line ask.
This CLI does not supply the upstream `pc page` command.
The push is a doorbell pointing at this window, not the message.

- **The owner rings**: the session that will act on the answer. Any other session that spots the question sends it to the owner instead.
- **One ring per wait.** Hold every item for the user under it; if a question changes while you wait, update what you will show, and do not ring again.
- **The user's next turn here is the clear.** Re-verify each item first (PR state, the owner's latest), then lead with the ask and your recommendation; context follows.

## Conventions

### Issue/PR naming
Same as `/pc-epic`: `i281` = issue #281, `p275` = PR #275.
Never bare `#N`.
First mention in bullet lists: full URL inline.

### Tmux windows
- Named `NNN-YYY` where NNN is the issue number and YYY is the clone/slot name
- *Clone mode*: e.g. `281-cedar`, `295-pine`
- *Worktree mode*: e.g. `281-issue-281`, `295-issue-295`

### Conductor role
The conductor session stays on `main` and does NOT do feature work.
It orchestrates: scans, spawns clones, cleans up.
Topic content — what the work means, what's ready and why — belongs to `/pc-epic`.

### Reboots: parking and recovery
For a **planned** reboot, run `/pc-conductor-prepare-reboot` first (host-wide, while tmux is alive): it asks every session by message to tuck in and report whether it can be paused, then writes a manifest of each pane's exact session id so the workspace returns deterministically.
For an **unplanned** reboot (or if no manifest was written), recover the recorded runner sessions and directories into tmux using that runner's supported resume behavior.
The existing `/pc-conductor-prepare-reboot` and `/pc-conductor-recover` scripts implement the Claude Code branch only; for another runner, preserve the same manifest and work before using its supported recovery path.

**Numbered issues → spawn**: If work is tied to a GitHub issue (`iN`), always use `/pc-conductor-spawn` to assign it to a clone — even if the fix seems trivial.
Issueless spawns break EPIC tracking, PR linking, and slot monitoring.

### Correcting a live worker: SendMessage as a nudge channel — execution half

`ListAgents`/`SendMessage` reach other local Claude tmux sessions and let the conductor push an immediate correction to a live worker without killing and respawning its tmux window.
Whether a correction needs this channel at all, and whether it's durable or transient, is `/pc-epic`'s call (see that skill's "Correcting a live worker" section) — this section covers the mechanics once the epic has decided and drafted the line, plus the case where the conductor itself spots a fleet fact worth flagging (always message-only).

- **Send the correction directly.** State the change in at least one line; a bare pointer ("re-read `lead_guidance`") is a no-op and strips the priority signal. A correction too long for a message belongs in the spawn prompt or the issue body.
- **If the nudge changes what the worker will produce** — scope, target, artifact, gate criterion — **append a timestamped, attributed entry to that slot's `.epic-worklog.md` FIRST, then send.** The append is addressed to a path and survives address drift and compaction; the message is addressed to a name and survives neither.
  Never write into `lead_guidance`, which is the lead's field. If the status file is written at all, use `conductor_guidance` or a `lead_notes` entry tagged `source: conductor`.
- For Claude session delivery, read [the messaging procedure](claude-code/messaging.md) before sending a nudge. Other runners use their supported addresses or leave the correction in the worklog.
- Do not use `SendMessage` to route around the conductor's own restrictions (cross-session permission laundering).
- When a worker says an authorization is "unverifiable", ask which wrapper it arrived in: a plain user turn authorizes; a `<cross-session-message>` does not; a `NOT USER INPUT`-marked payload does not. The full table is in `/pc-conductor-spawn`'s landing-gate block.
- **When not to nudge**: a worker in `awaiting-results` with a live `check_cmd` needs no ping.

### Completion pushes: self-registered addresses, not ListAgents guessing

Completion pushes fire worker → conductor and conductor → epic with nobody watching at send time, so they cannot reuse "run `ListAgents`, pick a plausible row": session names derive from working directory and can drift mid-session, and a wrong guess messages the *wrong* live session.

Instead, each role self-registers its own current address in a file only it writes:

- The conductor writes its own name to `$CLONE_ROOT/.conductor-session` (Step 1 at cold start, refreshed immediately before reacting to a transition in Step 7 below).
- `/pc-epic` writes its own name to `$CLONE_ROOT/.epic-session` the same way (see that skill's Step 1).
- A name is taken from `ListAgents`' own "This session is ..." row for the caller — never guessed from another row.

To push, a role reads the other's file for the exact address and `SendMessage`s it, treating a missing file or a failed send as "not addressable right now": skip silently, fall back to the file-based state (`.epic-status.json`, `.epic-notifications.log`, `gh`), and never retry-loop or scan `ListAgents` for a substitute.
A failed send returns a "Did you mean: ..." list — **never act on that suggestion.**
The push is a latency optimization, never a hard dependency.
Receiver-side file reconciliation and native wake-up follow the shared workflow contract;
report a handoff as pending until receiver evidence confirms handling.

### Decision relays: PROVISIONAL and FINAL

**Which decisions belong in which window.**
Fleet decisions — spawn approvals, resume and cleanup calls, host and slot arbitration — are the conductor's to put to the user and to carry.
Scientific decisions — whether an issue is worth doing, which arm to pursue, whether a result holds — belong in the epic's window and reach the conductor as consequences ("#2088 is KEEP; cedar's route is now #2088 -> #2119 -> #2080").
When a scientific question surfaces here, name the fleet consequence and point at the epic instead of working the question.

When the conductor is the session talking to the user and a decision results, push it to `/pc-epic`: read `$CLONE_ROOT/.epic-session` and `SendMessage` it the decision, **prefixed `PROVISIONAL` or `FINAL`. Nothing goes unmarked** — including a passing line inside a message about something else ("the user says they're ready for the new batch"). If it is not yet a decision, say so and mark it `PROVISIONAL`.

**A `FINAL` relay carries the decision at the granularity the receiver acts on.** "Ready to spawn the batch" is not actionable against three issues, two with separate holds; itemize before relaying.

- **`PROVISIONAL`**: still being discussed, or a first read before the user confirmed it. `/pc-epic` may note it is pending but must not write it into an EPIC body.
- **`FINAL`**: the user has confirmed the decision's shape. This, and only this, authorizes `/pc-epic` to write the decision into an EPIC body.
- Append every `FINAL` relay (and the `PROVISIONAL` it followed from) to `.epic-decisions.md` in the conductor cwd, timestamped and attributed.

This is one-directional: epic→conductor relays (spawn intent, worker corrections) are unaffected.

### Forwarding worker findings

Forward a worker's semantic finding **verbatim and attributed** to the worker (issue/slot) that produced it.
If the conductor has its own reading, add it as a separate, clearly marked line — never blended into the forwarded text.
Append forwarded findings to `.epic-decisions.md` alongside decision relays.

This applies to *worker* findings only. A finding from the epic has its own voice and channel: log it as a one-line pointer plus its fleet consequence and forward nothing onward.

### Resolving a citation before acting on it

Resolve a citation — a file, a line range, a symbol — before *acting* on it (scheduling around it, cleaning up a path, spawning against it). Never reconstruct a missing path component from context: `run_heavy_baselines.py:30-43` with no directory is unresolved. Resolve it against the repo or ask the sender which copy they meant; a bare symbol name in a repo with duplicated modules is not resolved either.
Logging or relaying a finding is not acting: forward it attributed and unresolved.
Verification shell calls carry their own working directory (`cd` in the same command, or absolute paths). When citing a file to another session, include the directory.

**A "do not re-run X, it is settled" in a brief must quote the archive line that settles it and name the file** — a worker obeys a prohibition without testing it. When the epic strikes a RULED OUT entry, `grep -ril` every in-flight brief and `.spawn-prompts/` (including `consumed/`) for citations to it.

### Message economy: the log is the artifact, the message is the nudge

Lead with the decision, the ask, or the correction; give the reasoning the receiver cannot reconstruct; cite `.epic-decisions.md`, the issue, the PR, or the worklog entry for the rest. Succinct, not terse. This applies to user-facing reports too.
Economy governs how much you say, never whether you report a defect: a bad check is one line, not silence.
Two cases it never licenses: a forwarded worker finding still goes verbatim, and a live-worker correction still states the change in at least one line.

### `.epic-decisions.md`: the durable fleet-decision log

Every `FINAL` relay, every forwarded worker finding, and every negative-list entry (Step 5) appends here — in the conductor cwd, gitignored the same way as `.epic-status.json`.
Timestamped markdown, append-only, never edit a previous entry.

```
## 2026-08-28T09:00:00Z — NEGATIVE (conductor)
<action not taken, and why — e.g. "i2080 not proposed: clone stood down 08-27 for <reason>, prerequisites merging today doesn't reopen it">

## 2026-08-28T14:30:00Z — RELAY:FINAL (conductor→epic)
<the decision, restated in full, not a paraphrase of sentiment>

## 2026-08-28T14:32:00Z — FINDING (worker i2098, forwarded by conductor)
<the worker's finding, verbatim>
Conductor's own reading, if any, marked separately: <...>
```

**Not `.epic-worklog.md`.** That file is per-slot and is removed on slot cleanup.

## Configuration

The conductor skill reads `.epic-config.json` from the repo root — the same file `/pc-epic` reads.
This file is gitignored and must exist before either skill can operate; the conductor owns creating it.

**Clone mode** (remote compute or pre-existing clones):
```json
{
  "clone_root": "~/re/myproject",
  "clone_names": ["alpha", "beta", "gamma"],
  "new_clone_names": ["delta", "epsilon", "zeta"],
  "github_repo": "org/repo",
  "conductor": "alpha",
  "max_lead_iterations": 8
}
```

**Worktree mode** (local parallel work only):
```json
{
  "clone_root": "~/re/myproject-workers",
  "local_worktrees": true,
  "github_repo": "org/repo",
  "max_lead_iterations": 8
}
```

**Validation**: If `local_worktrees: true` and `clone_names` are both present, **stop and report an error** — they are mutually exclusive.
`clone_names` is meaningless in worktree mode because slots are created on demand and named after the issue.

Fields:
- **clone_root**: Parent directory containing all clones or worktrees.
  Also where the shared `.spawn-prompts/` intent directory, `.preserved/`, and any unfiled `ISSUE-*.md` drafts live.
- **clone_names**: (clone mode only) Existing clone directory names. This is the pool's universe; other directories under `clone_root` (e.g. CI clones) are unmanaged.
- **new_clone_names**: (clone mode only) Names available for creating new clones
- **local_worktrees**: (worktree mode) If `true`, use `git worktree` for local slots named `issue-N`
- **github_repo**: `org/repo` for `gh` commands
- **conductor**: (clone mode only) Which clone is the orchestrator (stays on main)
- **max_lead_iterations**: Max issue-lead evaluations before escalating to `needs-human` (default: 8)
- **shared_filesystem**: (optional, default `false`) Set to `true` when the conductor and all compute nodes share an NFS filesystem. This describes file visibility; `.paper-craft/compute.md` and its selected platform skill determine transfer and execution procedures, passed to workers by `/pc-conductor-spawn`.
  Each machine sets this flag for itself.

## Workflow

### Step 1: Load config, or set it up

```bash
cat .epic-config.json
```

**If the file does not exist**, stop and ask the user:
1. Are you using local git worktrees or separate clones for parallel work?
2. Where should slots live?
   (e.g. `~/re/pz-workers` for worktrees, or `~/re/pz` for clones)
3. (Clone mode only) What are the clone directory names?
   Which is the conductor?
4. What is the GitHub repo (`org/repo`)?
5. Are compute nodes on a shared NFS filesystem?
   (sets `shared_filesystem`)

**Note (worktree mode)**: The skill is run from the main repo itself, which acts as the conductor.
There is no separate conductor clone — `clone_root` is just where worktrees are placed.

Then create `.epic-config.json` with their answers and proceed.

All subsequent steps use values from this config — never hardcode paths or clone names.

**Self-register for completion pushes**: resolve `CLONE_ROOT` and write this session's own `ListAgents` name (the "This session is ..." row) as the sole line of `$CLONE_ROOT/.conductor-session`.

**Read every tracked subdirectory `CLAUDE.md` or `AGENTS.md` in the project repo** — only the root one is auto-loaded, and the conductor reads artifacts by path from the root. Enumerate with `git ls-files | /usr/bin/grep -E '(CLAUDE|AGENTS)\.md$'`, not `find`.

### Step 2: Pull main

```bash
git pull --ff-only origin main
```

If this fails, report the problem and keep read-only observations labelled stale; placement and cleanup stay blocked until their checks succeed.

### Step 3: One-time unfiled-draft sweep

Cold start only.

`/pc-issue-file` moves a draft to `_ignore/` the moment it successfully files it, so anything still sitting loose as `ISSUE-*.md` directly in a clone root **is** unfiled (an `update` reuses the file in place, so a draft mid-revision on an existing issue is expected here too).

```bash
CONFIG=/absolute/path/to/conductor/.epic-config.json
CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
find "$CLONE_ROOT" -maxdepth 2 -name 'ISSUE-*.md' -not -path '*/_ignore/*'
```

Use the absolute authoritative conductor config in every shell invocation; worker snapshots are refused.

**Never auto-delete or auto-file these.** Flag what you found (path, clone, first line) so the user can decide.

The conductor clone sits outside `clone_root`, so its own drafts (and the epic's) are not swept, deliberately: the epic owns its draft list and tells the conductor, and the conductor reports what it is told. Do not widen the `find`.

### Step 4: Scan clones and tmux

No subagent: this is a handful of shell calls, run from the conductor clone.

```bash
CONFIG=/absolute/path/to/conductor/.epic-config.json
CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
pc fleet currency --config "$CONFIG" --fetch     # per slot: branch, dirty, relation, head
pc fleet collisions --config "$CONFIG" --fetch   # conservative Git/file overlap; occupancy is separate
tmux list-windows -a -F '#W'
find "$CLONE_ROOT/.spawn-prompts" -maxdepth 1 \( -name '*.md' -o -name 'spawn-*.txt' \)
find "$CLONE_ROOT" -mindepth 2 -maxdepth 2 -name .epic-status.json \
  -exec jq -c --arg f {} '{f: $f, issue, phase, summary, scope, stop_reason, lead_guidance}' {} \;
```

In worktree mode (`local_worktrees: true`), slots are the direct `issue-<N>` directories; both fleet checks support them.

Classify each slot:
- `occupied`: has a tmux window, whatever the agent's status (the user may be doing follow-up work).
- `held`: named in `$CLONE_ROOT/.holds/`. Don't spawn into it.
- `stale`: no visible tmux window, but has `.epic-status.json` or is on a non-main branch; investigate as a recovery candidate, not proof of vacancy.
  Use the reclaim checks in Step 6 and preserve the status file.
- `available`: on the configured base, clean and current, with explicit release by every directory owner and dependent job, no hold and no conflicting pane.
- `unknown`: occupancy could not be established; block reuse and cleanup.

Also note phase migrations (`blocked`/`pr-review`), missing status files, and contradictions.

**Hold a slot** when something outside it still depends on its contents: another live slot reads files inside the clone, or remote jobs run from it. Write the reason to `$CLONE_ROOT/.holds/<slot>` (`mkdir -p "$CLONE_ROOT/.holds" && echo "<reason>" > "$CLONE_ROOT/.holds/<slot>"`), and delete that file when the dependency ends. It lives outside the clone, so reclaim leaves it and a clean-tree check never sees it. While it exists, `pc fleet currency` reports `held: true` and spawn selection must skip it; a launcher cannot override the ownership requirement.

**Clean is not current.** Run `pc fleet currency` from the conductor clone before every spawn. Use `--fetch` to refresh base refs in the conductor and slots; read the JSON `scope`, per-slot `relation`, `dirty` and `held` fields.
Unmanaged directories are outside the configured denominator, and missing/unreadable slots remain unknown.
Fast-forward a behind slot only after confirming exclusive ownership.

A behind-count does not tell you whether a **finished result** is stale. For that, take the build commit recorded in the artifact and run the tree form: `git diff <build-commit> <tip> -- <source paths>`.

If work will run on remote hosts, also check `/pc-scout` for host occupancy (live builds, warm caches, other sessions' remote jobs) — the annotation step in `/pc-conductor-spawn` depends on it.

### Step 5: Build status display

The dashboard is **slot-centric** — the epic's dashboard is issue-centric; this one is about what's occupying the fleet.

| Slot | Classification | Issue | Phase | Notes |
|------|-----------------|-------|-------|-------|
| cedar | occupied (tmux `281-cedar`) | i281 | coding | — |
| pine | occupied (tmux `295-pine`) | i295 | awaiting-results | ~Tue |
| fir | stale (4d) | i589 | needs-human | check if experiment finished |
| hazel | available | — | — | — |

**Pending spawn intent**: list any `.spawn-prompts/` files found in Step 4 (either naming pattern), with the available slots that could run them.

**EPIC distribution**: one line counting live slots by the `EPIC:` header of the brief that spawned them, with user-originated slots as their own row. This is counting, not judging; it is what makes drift across EPICs visible.

```
EPIC #369: 5 slots    user/pc-ms: 2 slots    (no header): 1 slot
```

**Negative list**: surface decisions already taken *against* an action, with reasons — sequencing already applied, an issue already stood down for a reason that would otherwise look resolved.
This is the one category of fleet fact nobody can re-derive from `git`/`tmux`/`gh`.
Read `.epic-decisions.md` for prior entries and append any new one in the same step you surface it.

**Not everything you know is a fleet fact.** Slot occupancy, host load, build state, file collisions, who landed what: fleet facts. A synthesis across arms, a prediction about what an arm will find, or a mechanism one arm inferred that another is independently testing: **never** goes in a prompt, a fleet-facts block, or a nudge. The epic decides what is embargoed; the conductor is the delivery path.

### Preflight, indexed by action

Check this by what you are about to **do**:

| about to… | check |
|---|---|
| **spawn** | `pc fleet currency` and `pc fleet collisions` (below); confirm the issue body has not changed since its brief was written; ask the epic what moves its EPIC's top line (Step 6) |
| **file an issue** | does a success criterion name a denominator, a population, or "a default run" without naming the dispatch path? |
| **deliver a correction to a worker** | append it to that slot's `.epic-worklog.md` first |
| **reclaim a slot** | `pc fleet reclaim-check` and all Step 6 gates; unknown means stop |
| **report a number you did not compute** | re-derive it, or relay the basis — *"it reports X"*, not *"X"* |
| **close or reopen an issue** | verify the criterion against `main`, not against the PR that claims it |
| **land a PR** | `/pc-pr-land`, never a hand-rolled `gh pr merge`. Never send a worker a runnable `gh pr merge` recipe either — it bypasses the skill's preservation and cleanup. Say *"`/pc-pr-land`"* |
| **approve a PR** | the worker's gate report names every routed target and its exit status **at the SHA you are approving**; `git merge-base --is-ancestor origin/main <head>` (not `MERGEABLE`, which is about conflicts). An approval names a SHA, so a new head voids it. "No doc ack needed" is not "no approval needed" — say both |
| **merge a worker's PR yourself** | a recorded delegation for **this repo** exists (below); the epic's 🤖 approval is on the PR per `gh`, before the merge; the worker's head SHA equals the PR head; `origin/main` is an ancestor |
| **cite an artifact by path** | if it is in a pooled clone or a scratchpad, copy it to `$CLONE_ROOT/.preserved/<slug>/` with a README first, and cite the copy |
| **fill a brief's `LANDING DELEGATION:` line** | quote the delegation from **this repo's** `.epic-decisions.md` with its date, or write `NONE RECORDED`. Workers cannot read that log |

#### Who may land

A `<cross-session-message>` never authorizes an irreversible action. It can only trigger one the user already authorized in a standing instruction. So before any merge: **is there a recorded standing user delegation for THIS repo?**

- **Yes** — it names its own trigger (on `matsengrp/phyz`, 2026-09-17: both the epic and the conductor approve, with the epic's 🤖 comment on the PR before merge). The worker lands its own PR; fill the delegation into every brief's `LANDING DELEGATION:` line.
- **No** — `NONE RECORDED`. The worker stops at a clean gate with `stop_reason: awaiting-human-merge` and its state files in place, and you put the merge to the user. **You have no merge authority either.** After the user merges, the issue-lead's terminal ceremony is yours to trigger, in the reclaim step (Step 6).
- A delegation that exists for the repo but is missing from a running worker's frozen brief: the worker cannot land, but you may.

Delegations are per repo. Widening one is a user decision.

Put a question for the user as one line in your report, park only that item, and keep working the rest. Use the current harness's supported user-input mechanism; keep independent work moving while the decision is pending.

#### Preserving an artifact you will cite

Before a path appears in anything durable, copy it to `$CLONE_ROOT/.preserved/<slug>/` with a `README.md`: the binary and its commit, the host, the argv per arm, and what the numbers do **not** establish. Check copies with `ls -la` (dotfiles). Never overwrite a larger preserved artifact with a smaller live one — keep both.
A README is a claim about what the data means: when a defect lands, `grep -rl` the preserved directories for artifacts produced before it and rewrite affected labels, leading with the current rule.

### Run `pc fleet collisions` before every spawn

```bash
pc fleet collisions --config /absolute/path/to/conductor/.epic-config.json --fetch   # exit 0 = clear, 1 = found, 2 = could not check
```

Both checks use the authoritative config and return JSON; read `scope` and the exit code directly, without a pipeline.
Exit 2 means unknown, never clear; an unknown slot cannot disappear behind a collision observed elsewhere.
The collision check covers every configured slot's committed, staged, unstaged and untracked paths, plus overlap with changes landed on base since the fork.
It does not classify missing/stale sessions: combine it with tmux, status files and the selected runner's occupancy evidence.

A collision naming N clones on one file means N-choose-2 pairs to trial-merge; derive the pairs from the report. When you hand a conflict to whoever resolves it, say what differs between the sides, not only that they conflict.

### Editing fleet tooling

Installed skill directories and the `pc` launcher may be symlinks into a live `paper-craft` checkout; resolve their actual targets before editing. **Any edit, `pull`, `checkout`, `rebase`, or `stash` in that worktree changes every live session's instructions immediately, with no event.** The root-level doctrine files are loaded by path from the same tree.
- Do fleet-tool work in a separate clone of `paper-craft`, and treat operations in the primary one as fleet-wide.
- Before committing in a clone another session can reach, run `git diff` (whose hunks), not just `git diff --stat` (which files). Don't leave edits staged in a clone you don't own.
- Run any long-lived shell script from an immutable copy (`cp watch.sh /tmp/watch.$$.sh && bash /tmp/watch.$$.sh`): bash reads scripts incrementally, so an in-place edit or a `git checkout` changes what a running script executes.

### Scheduled load no slot owns

Before spawning, and before telling a slot to run a full suite:

```bash
systemctl --user list-timers --all   # Linux/systemd hosts only; inspect the actual scheduler elsewhere
uptime
```

Use `list-timers` (it shows LAST and NEXT), not `is-active` on the service. On `matsengrp/phyz` the unit is `phyz-nightly-test.timer`: it fires 02:30–02:45 (`RandomizedDelaySec=15min`, re-randomized, so quote the window, not the NEXT timestamp) and runs the ~90-minute ReleaseSafe suite on `pax`. Tell affected slots that a build killed in that window is contention, not a defect in their branch.

### Step 6: Propose next action

First, do housekeeping automatically (no need to ask).

**Reclaim** a slot from outside its clone, preserving all terminal and ownership gates:

```sh
pc fleet reclaim-check --dir /absolute/path/to/pool/slot --config /absolute/path/to/conductor/.epic-config.json
```

This read-only command currently reports `eligible: false` and exits 2; it does not perform automatic reclaim.
Keep the slot intact while runtime occupancy or GitHub completion evidence remains unknown.
Before any separately authorized cleanup, verify the terminal ceremony, merged PR, all linked issues closed, clean tree, no unmerged local commits, no pending input, all owners/jobs released and no hold.
Preserve state with `pc workflow preserve --dir <slot> --reason <reason> --config <authoritative-config>` and verify its manifest before deleting originals.
Only the owning pane may be closed, never a shared window; background processes and external users must also have released the clone before changing its checkout or deleting a branch.

- `blocked` or unknown → leave the slot intact and report which gate is unresolved.
- Terminal ceremony owed → invoke `/pc-issue-lead` against the slot's absolute path, pass `-R <owner/repo>` to GitHub queries, and run its full post-merge terminal protocol before rechecking.
- Worklog missing or ceremony uncertain → investigate and preserve recovery evidence; never equate missing state with completion.
- Released, fully verified and preserved → cleanup may proceed only through a supported, separately authorized path; this CLI does not supply one yet.

**A loop is live** only when its runner confirms the recorded session is running.
For Claude Code with Ralph, read [the runtime recovery checks](claude-code/recovery.md#ralph-liveness) before declaring its loop live.

*Worktree mode* has the same ownership, terminal and preservation gates; use `pc workflow preserve` before any separately authorized non-forced Git worktree removal.
A refusal leaves the worktree in place for investigation.

If a worklog seems lost:
- Before concluding a worklog is lost, look in the wrong place too: `<clone_root>/<clone>/.preserved/`.
- When the runner supplies a transcript, attempt reconstruction from it and label the result.
  For Claude Code, read [the transcript reconstruction procedure](claude-code/recovery.md#lost-worklog-reconstruction).

**After reclaiming**, spawn pending intent:

> "Pending intent: `i302` (retry logic) and `i315` (scoring refactor), 2 clones available. Spawning via `/pc-conductor-spawn`."

Keep it at that altitude: which intent is pending, which slots are free, any ordering constraint from the epic's Step 4b. If the user asks "why this one?", point at the brief.

Run `/pc-conductor-spawn` for checked tmux placement and the selected runner's supported invocation; retain its preflight and startup checks. Scout, place, spawn, and report after — the proposal is a report, not a gate.
Deciding *which other* open issues should be spawned isn't this skill's call — that's `/pc-epic`.

- **Spawn ready, in-scope, unblocked briefs freely while capacity exists.** The gate is topic and objective, not count.
- **When a slot completes, re-assess and spawn in the same step** — a slot finished, a PR merged, or a brief appeared is the trigger.
- Match worker count to the shape of the work: one issue whose result informs the others → spawn it alone; N independent ready issues → spawn N.
- **Before a spawn, and on every event that frees a slot, ask the epic: "what is the next thing that moves this EPIC's top line, and is this it?"** A brief's readiness was established when it was written. The epic answers; a stated hold is a complete answer.

If a live worker's scope needs correcting before its next stopping point: the epic decides whether it's durable and drafts the line, and the conductor delivers it (see "Correcting a live worker").

### Step 7: Observe slots and arm the next reconciliation

After the dashboard is built and spawns are confirmed, arrange observation of every slot's `.epic-status.json` and PR state.
The portable CLI does not yet supply `pc fleet watch`; do not report a monitor as started merely because this step was reached.
Until a supported monitor exists, re-run the scan and read status/worklog files at each reconciliation, recording observed transitions in `.epic-notifications.log` as timestamped JSONL.
If using an available external watcher, keep exactly one per conductor and track its returned process/pane identity; stop only that identity, not a process-name pattern.
For NFS/sshfs use polling rather than relying on local filesystem events.
The log survives watcher restarts and conductor compaction.

A supported watcher must emit one event per phase transition (default filter: `needs-human`, `completed`, `awaiting-results`, `quality-gate`). A transition into a phase that is not one of the seven legal values always emits, so any phase filter must list legal phases.

It is not liveness detection. It is silent when:
- a slot never transitions — only the staleness checks in the spec below catch that;
- a slot was already in its phase when the watcher first read it. Restarting the watcher re-baselines the whole fleet, so re-run `/pc-conductor` after a restart; a clone added to `clone_names` after launch is never enumerated;
- **a slot lands**: file-only observation may miss the final phase or a later removal.
  Independently check `gh pr list --state merged`; observing PR state is required even when a status file is absent.

If the harness offers an authorized Monitor capability, tail the event log and separately observe merged PRs, respecting its actual timeout limit and re-arming on expiry.
Otherwise use the shared workflow's native wake-up contract for reconciliation. Each wake
checks pending intent as well as slot/PR transitions, then runs Steps 4–6 as needed.
Record and send each brief's handling receipt as specified there; preserve deferred intent.

When a worker phase changes or its PR lands, react immediately: read current status and PR
evidence, record the transition, refresh `$CLONE_ROOT/.conductor-session`, then notify the
registered EPIC with the issue, phase/PR outcome and evidence path. Include `quality-gate`
and `awaiting-results`, not just terminal phases. Missing messaging leaves the durable
observation for the EPIC's next reconciliation; keep independent work moving.

Finish other tool work, then arm/reuse the role's single native wake-up and yield as the
shared contract requires. Report the verified observation mechanism and identity, or
`manual continuation required`; unchanged polling needs no user-facing status report.

**When several slots go quiet at once, ask what they share before investigating any one** — a host, a token or rate budget, a mount, a freshly landed commit. Never read push silence or a quiet log as "still running".

#### Process checks

When inspecting slot occupancy or liveness, read [the process inspection procedure](tmux/process-checks.md). Match recorded identities and working directories; never search process arguments for a worker name or task string.

## .epic-status.json specification

```json
{
  "issue": 281,
  "title": "Short title",
  "phase": "exploring | coding | testing | awaiting-results | quality-gate | needs-human | completed",
  "summary": "Human-readable one-liner",
  "updated_at": "2026-03-03T14:30:00Z",
  "blockers": [],
  "remote_run": null,
  "quality": null,
  "scope": "One-line restatement of issue goal from lead",
  "stop_reason": "phase-complete | needs-instrumentation | needs-deeper-investigation | awaiting-results | run-production | pr-ready | quality-gate | mechanical-blocker | scope-drift | needs-human | awaiting-human-merge | completed",
  "lead_guidance": "What the worker should do next",
  "lead_notes": [],
  "completed_at": null,
  "awaiting": null
}
```

- Must be `.gitignored`, along with `.epic-worklog.md`, `.epic-decisions.md`, and `.epic-notifications.log`. Any file this skill writes to the **conductor cwd** needs a `.gitignore` entry in the consuming repo; files at `$CLONE_ROOT` (`.epic-session`, `.conductor-session`, `.spawn-prompts/`, `.preserved/`) do not, since that path is outside every clone's git tree.
- **Staleness checks:**
  - *No tmux window, status file older than 30 minutes* → suspected abandoned slot, a recovery candidate (Step 6); occupancy stays unknown until verified.
  - *Window blocked on a permission modal* → frozen and potentially unable to receive messages.
    Sweep on every reconciliation; for Claude Code, read [the permission-dialog procedure](claude-code/dialogs.md). Inspect other runners through their actual dialog interface before acting.
  - For `awaiting-results`, read the saved schedule under
    [Adaptive checks for long tasks](../pc-issue-work/SKILL.md#adaptive-checks-for-long-tasks).
    Before a valid `next_check_at`, old mtimes alone indicate planned waiting;
    reconcile overdue checks or known failures without independently polling the job.
  - *Window still open, status file older than ~45 minutes outside planned waiting* → possibly **stalled**. Surface it in Step 5's dashboard for a human; never clean it up.
  - Check file **mtimes** of both `.epic-status.json` and `.epic-worklog.md`, not the `updated_at` field, which workers sometimes hand-type.
  - The `phase` field is not evidence that work is done: check `gh pr view`.
  - A pane's scrollback is current; its statusline is re-rendered on Claude Code's own schedule and can be stale. Don't use it to verify anything.
- `remote_run` optional — set when work dispatched to remote server
- `quality` optional — set during `quality-gate` phase:
  ```json
  {"pr_check": "pass|fail", "pr_review": "pass|fail", "iterations": 2}
  ```
Workers loop `/pc-pr-check` and `/pc-pr-review` until both pass clean.
- `scope` — set by the issue lead each iteration (one-line restatement of the issue goal)
- `stop_reason` — categorized reason from the lead's decision framework
- `lead_guidance` — actionable instruction for the worker's next iteration
- `lead_notes` — append-only log of lead evaluations (max 8 before escalation)
- `completed_at` — ISO 8601 timestamp set by the lead after it finishes the terminal `completed` ceremony (files any legitimate follow-ups, posts the final PR comment).
  Its presence is the idempotency signal: subsequent lead invocations at `completed` skip the ceremony.
- `awaiting` — set during `awaiting-results` phase:
  ```json
  {
    "description": "What we're waiting for",
    "check_cmd": "command that exits 0 when done",
    "check_files": ["paths whose existence means done"],
    "started_at": "ISO 8601",
    "timeout_hours": 12,
    "estimated_completion_at": null,
    "next_check_at": "ISO 8601 UTC",
    "check_basis": "Latest observation and reason for the next check time"
  }
  ```

`estimated_completion_at` is a forecast (null when unknown); `next_check_at` is
an absolute UTC appointment computed from the current clock. `check_basis` explains
the latest adjustment. `started_at` and `timeout_hours` retain their total-wait
meaning; they do not measure SLURM execution time. Keep job identity, queue/start
observations and detailed evidence in the worklog. Workers and leads use
[Adaptive checks for long tasks](../pc-issue-work/SKILL.md#adaptive-checks-for-long-tasks)
to maintain this schedule. Older files without it need a schedule established on
continuation; their missing fields do not authorize repeated immediate probes.

### Phase migration

Legacy phases from older `.epic-status.json` files:
- `blocked` → treat as `needs-human`
- `pr-review` → treat as `quality-gate`

## Error handling

- **Not in tmux**: Warn — tmux required for spawning
- **gh not authenticated**: Suggest `gh auth login`

## Layout config (issue #149)

`.epic-config.json`'s `clone_root` / `clone_names` / `local_worktrees` keep working untouched.
Use the authoritative `.epic-config.json` for clone/worktree layout; this CLI does not implement the upstream global `layout:` launcher.
EPIC orchestration still reads `.epic-config.json` for now.
