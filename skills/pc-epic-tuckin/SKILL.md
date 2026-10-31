---
name: pc-epic-tuckin
description: Persist topic-side EPIC state before context reset
---

# /pc-epic-tuckin

Flush topic state — EPIC bodies, findings, decisions — to durable storage before a context reset or session end.
Run this when context is getting long or before stopping.

Fleet-side state (clone/slot status, `.epic-status.json`, pending spawn intent) is `/pc-orchestrator-tuckin`'s job, not this skill's — run that separately if the orchestrator session is also resetting.

## Usage

```
/pc-epic-tuckin
```

## Workflow

### Step 1: Push EPIC body edits

For this session's assigned EPIC only, verify its keyed registration under the shared [workflow contract](../lib/workflow.md) and persist its pending findings/confirmation routes under **Lifecycle recovery**. Preserve other EPICs' files and registrations.

For `ISSUE-EPIC-<N>.md`, follow the **EPIC body update pattern** from `/pc-epic` (pull with `updatedAt` tracking → edit → conflict-check → push).
Extract the issue number from the filename (`ISSUE-EPIC-284.md` → 284).
Prune completed sections while you're in there — this is the same discipline as `/pc-epic`'s regular update pattern, not a separate cleanup pass.

Report which EPICs were pushed (and which were skipped due to conflicts).

### Step 2: Filter and route topic-level findings

Most state should already be in EPIC bodies (`ISSUE-EPIC-<N>.md`).
Before recording anything anywhere, run each candidate topic-level finding through this filter:

1. **Is it derived?**
   Recomputable from `git`, `gh`, or the EPIC bodies themselves — record nothing.
2. **Does it already have a home?**
   Dependency-direction or collision findings belong in the EPIC body they concern (Step 1), not as a separate copy.
   A finding that already produced an issue, PR, or EPIC body update needs no second copy either.

Only what survives both gates gets a destination:
- A durable repo-level fact → the repo's `CLAUDE.md` or `AGENTS.md`.
- A workflow rule → a skill.
- A cross-EPIC pattern or key decision not yet captured anywhere → the EPIC body it's most relevant to, or the Step 3 report below if none fits.
- Nothing else fits → the Step 3 report.

### Step 2b: Write the continuation artifact — a long file plus a short prompt

**Two artifacts, and the split is the point.** A continuation prompt longer than a page does not get pasted; a file nobody is pointed at does not get read.

**The file** — `CONTINUATION-<N>.md` in the repo root (add to `.gitignore` if not already covered) — can be as long as it needs to be. Include:
- **How the programme works**: the slicing discipline, what is out of scope by default, when to reach for a skeptic agent.
- **The traps** that caused the most rework — naming collisions, artifacts everyone reads wrong, anything where each reasoning step was locally valid and the conclusion still came out wrong.
- **Current state with its numbers**, and the pointer to the EPIC section that supersedes everything else.
- **What has already been ruled out**, itemised. This is the highest-value section and the easiest to omit — without it a successor re-runs settled work.
- **What is in flight**, per worker, and what each one's next decision point is.
- **Housekeeping**: EPIC body headroom, known recurring conflicts, skill changes landed this session.

**The prompt** is what you write to `_ignore/CONTINUE-epic-<N>.md` (keyed by EPIC number, as the guide requires) and print for the user.
Its path, its under-a-page shape, and the rule that every action item carries its falsifier inline are [the continuation contract](../lib/continuation.md); the next session loads it with `/pc-continue`.
On top of that, the EPIC prompt adds the `/pc-epic <N>` invocation, a one-line pointer to `CONTINUATION-<N>.md` (the long file above), and **the two or three traps that would cost the most if rediscovered** — put those in the prompt itself, not only in the file, since they are what a fresh session gets wrong before it has read anything.

Retain the current-head EPIC confirmation pointer and pending orchestrator receipts under the shared **Lifecycle recovery** contract. EPIC confirmation and explicit user approval remain separate evidence.

### Step 3: Report

Print a summary:

```
## Tuckin Complete

- Assigned EPIC: i<N> (pushed | conflict, with evidence)
- Topic-level findings: <none survived the filter | routed to CLAUDE.md/skill/EPIC body as listed>
- Continuation: CONTINUATION-<N>.md (long) + _ignore/CONTINUE-epic-<N>.md (prompt) written; prompt printed below

Safe to reset context. Fleet-side state (clones, slots) is unaffected
by this — run /pc-orchestrator-tuckin if that session is resetting too.
```
