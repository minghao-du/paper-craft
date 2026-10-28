---
name: pc-conductor-tuckin
description: Persist fleet-side clone/slot state before context reset
---

# /pc-conductor-tuckin

Read [the shared runtime and workflow contract](../lib/workflow.md) before using helper commands or runtime-specific tools.
Tmux is shared infrastructure; Claude-specific tool names and examples apply only when that runner provides them, with file-based delivery otherwise.

Flush fleet state — clone/slot status, pending spawn intent — to durable storage before a context reset or session end.
Run this when context is getting long or before stopping.

Topic-side state (EPIC bodies, findings, decisions) is `/pc-epic-tuckin`'s job, not this skill's — run that separately if the epic session is also resetting.

## Usage

```
/pc-conductor-tuckin
```

## Workflow

### Step 1: Verify role registration

Resolve the authoritative config and `clone_root`. Verify `.conductor-session` and
every `.epic-sessions/<N>.json` under the shared **Multi-EPIC registration and scheduling**
contract. Record verified live, paused or unknown separately for each EPIC; each agent
refreshes only its own record. Preserve legacy `.epic-session` for reconciliation.
A runtime address cannot establish task or checkout ownership.

Apply the shared **Lifecycle recovery** contract before reset. Persist outstanding
planning/confirmation requests, priorities/constraints, delivery receipts, transfers,
approval and landing phase evidence with pointers; this is required coordination state,
even when parts can later be queried live. Never replace it with a worker-session roster.

### Step 2: Update slot status files

Read `clone_root` and `local_worktrees` from `.epic-config.json`.

Slot paths:
- *Clone mode*: `$CLONE_ROOT/<clone-name>`
- *Worktree mode*: `$CLONE_ROOT/issue-<N>`

For each slot the conductor interacted with this session:

1. Check if the slot's `.epic-status.json` is stale or missing
2. Record newer verified observations in the task worklog and conductor decisions.
   If updating status with exclusive ownership, merge only observed fields into existing
   JSON; retain quality, awaiting schedule, lead notes and completion evidence. A stale
   timestamp does not authorize rewriting a live worker's state or changing its phase.

Use the absolute authoritative conductor config in every shell invocation; worker snapshots are refused.

Update slots the conductor has direct knowledge about.
This includes:
- Slots whose PRs were merged this session (even if the slot's own session already exited)
- Slots the conductor observed finishing via tmux or poll

Do not guess status for slots with active sessions that may have progressed beyond what the conductor last observed.

### Step 3: Note queued and consumed spawn intent

List `$CLONE_ROOT/.spawn-prompts/` and report two groups separately — these are the epic's authored intent, not conductor state, so don't touch their contents either way:

- **Queued** — regular files directly in `.spawn-prompts/`: `find "$CLONE_ROOT/.spawn-prompts" -maxdepth 1 -type f \( -name '*.md' -o -name 'spawn-*.txt' \)` (both naming conventions live there).
  `-type f` matters: a plain `ls` also lists the `consumed/` directory itself as an entry, which is not a queued intent file.
  Still waiting on execution.
- **Consumed** — files under `.spawn-prompts/consumed/`.
  Already launched by `/pc-conductor-spawn` Step 6.

Reporting these separately matters: a consumed file left in the top level (or a queued one reported as consumed) invites either a re-spawn of work that's already running or merged, or a queued brief getting ignored as if it were stale.
Report both groups so the next conductor session (or the user) knows what's actually queued vs already launched.

### Step 3.5: Environment check

Conditions that bite the next session and are invisible to `git`/`tmux`/`gh`.
Run the host-appropriate equivalents; the following commands are Linux examples, not assumptions about the selected model.

```bash
ps -eo pid,etime,rss,comm --sort=-rss | head -5   # long-lived process, outsized RSS
df -h "$CLONE_ROOT" /tmp                          # headroom where the fleet writes
uptime; free -g | sed -n 2p                       # load and available memory
```

Flag anything **out of proportion to its job** — a mount daemon or stale build
server holding tens of GB, a partition near full, swap consumed while RAM is
free (that combination trips low-memory guards and looks like OOM without being
one). Age is the tell: a process up for weeks is the one nobody is watching.

Report; don't remediate. A remount or a kill is the user's call, and may break
another project's live session. Say what you measured and what it would
reclaim — not "should I?".

### Step 4: Filter and route fleet-level findings

Most state should already be in `.epic-status.json` per slot.
Before recording anything anywhere, run each candidate fleet-level finding through this filter:

1. **Is it derived?**
   For optional fleet findings, recomputable observations need no extra copy. Required lifecycle evidence above remains durable with its observation timestamp; revalidate it on resume.
   Which remote host had a warm cache, which host was mid-build, local cache sizes, open-issue counts, which worker was blocked: all of these are re-measurable on demand and go stale within hours, so don't write them down anywhere.
2. **Is it already recorded?**
   A finding that produced an issue, PR, test, or doc needs no second copy.

Only what survives both gates gets a destination:
- A durable repo-level fact → the repo's `CLAUDE.md` or `AGENTS.md`.
- A workflow rule → a skill.
- A finding → the test, doc, or issue it came from.
- Nothing else fits → the Step 5 report below.

### Step 4b: Persist lifecycle evidence

Follow the shared **Lifecycle recovery** contract: distinguish EPIC confirmation,
user PR/SHA approval, checkout release, verified merge, final records, preservation
and cleanup. Retain source evidence and next owner for every pending step.

### Step 5: Report

Print a summary:

```
## Tuckin Complete

- Roles: conductor = <verified identity/state>; each EPIC = <number, identity, active/paused/unknown, evidence>
- Pending lifecycle steps: <task/PR, evidence path, next owner/action or blocker>
- Slot status updated: cedar, issue-295
- Queued spawn intent: i302 (retry logic)
- Consumed spawn intent: i298 (already launched, moved to consumed/)
- Fleet-level findings: <none survived the filter | routed to CLAUDE.md/skill/issue as listed>

Topic-side state (EPIC bodies) is unaffected by this — run
/pc-epic-tuckin if that session is resetting too.
```

### Step 6: Continuation prompt

Write the continuation prompt to `_ignore/CONTINUE-conductor.md` and echo it, per [the continuation contract](../lib/continuation.md).
For this session: start in the fleet working directory, run `/pc-conductor`, and the durable state is the slot files and queued spawn intents this tuckin wrote under the clone pool.
Then: safe to reset context.
