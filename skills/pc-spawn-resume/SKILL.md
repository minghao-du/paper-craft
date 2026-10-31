---
name: pc-spawn-resume
description: Cold-start into a worktree/clone from a fresh conversation — read the PR, issue, and any status files, figure out where things stand, then STOP and ask the user what to do next. Use for a fresh conversation dropped into a pc-spawn or pc-orchestrator-spawn worktree/clone that already has history (a PR, an in-progress phase, or a stalled worker).
---

# /pc-spawn-resume

For a fresh conversation dropped into a worktree/clone that was started through a supported runner or `/pc-orchestrator-spawn` and already has history — a PR out, review feedback waiting, an EPIC worker mid-phase, or something stalled.
This skill's job is entirely **orientation**: gather context, report it, and stop.
It does not decide what happens next — the most common case is a vetted PR the user wants to modify (directly, or via PR review comments), but treat that as a prior, not a restriction.
Let the actual state (and the user) drive what happens after Step 2.

For runtime restoration after interruption, use `/pc-orchestrator-recover` and the selected runner's supported session recovery.
This skill is for the ordinary case of a new conversation that needs to re-orient inside a slot that already has state.

## Usage

```
/pc-spawn-resume
```

Always run from inside the slot's worktree/clone, on its branch — `gh pr view` with no args resolves the PR (if any) from the current branch.

## Workflow

### Step 1: Gather context

```bash
git branch --show-current
git log --oneline -10
gh pr view --json number,url,state,isDraft,statusCheckRollup,reviews,comments 2>/dev/null
```

If `.epic-status.json` exists (this is an EPIC slot), read it and `.epic-worklog.md` too — `phase`, `summary`, `blockers`, `stop_reason`, `lead_guidance`, `awaiting`.
If the PR body (or the worklog) references an issue, `gh issue view N --comments` as well.

### Step 2: Branch on what you find, then report and STOP

Don't act past this point without direction.
Assemble a recap and present it, branching on state:

- **No PR yet, EPIC phase in progress** (`exploring`, `coding`, `testing`, `awaiting-results`) — summarize the phase, the last worklog entry, and any `blockers`/`awaiting` fields.
  Don't resume the ralph-loop or continue coding on your own.
- **`needs-human`** — lead the recap with `blockers` and `lead_guidance`; this phase means a person's judgment was already requested.
- **`quality-gate`** — report gate iteration count and what's outstanding.
- **PR open** — report CI status, unresolved review threads, and a diff of what changed since the last commit/worklog entry (new comments or reviews since then).
  Summarize new feedback content, don't just count it.
- **PR merged / phase `completed`** — say so plainly; there may be nothing left, or the user may want a follow-up.
- **Nothing recognizable** (no status file, no PR, just a branch) — say so; report the branch/log state and let the user frame the task.

For a orchestrator-managed task, first reconcile [Lifecycle recovery](../lib/workflow.md#lifecycle-recovery), send the recap and evidence to the orchestrator, and await its verified next assignment/ownership transfer. A merged PR may still owe final evaluation or cleanup. Preserve pending routes when messaging is unavailable.

For an independent session, end the recap with a direct question — what would you like to do?
Do not guess at a next action (fix a comment, keep coding, open a PR, restart the loop) and do not restart any ralph-loop or autonomous machinery on your own initiative.

## After the user responds

The user may hand you a specific instruction, point you at a PR comment or review thread, or just start talking through what they want changed.
Whatever direction they give supersedes any default — there's no fixed Step 3+.
A few things carry over regardless of what they ask for:

- Same branch, same PR — don't open a new branch or a second PR unless told to.
- Apply the DEFERRAL RULE from `/pc-orchestrator-spawn` if scope creep comes up (fold small related fixes in; only defer clearly out-of-scope work).
- Before pushing changes back out, re-run `/pc-pr-check` and `/pc-pr-review`, same REVIEW TRIAGE as `/pc-orchestrator-spawn`.
- Replying to or resolving someone else's review thread is a visible GitHub action — draft it and confirm before posting/resolving, per the standing GitHub Action Sequencing rule.
- If this is an EPIC slot and the change is small and bounded, update `.epic-status.json`/`.epic-worklog.md` directly rather than restarting the ralph-loop.
  Only fall back to `/pc-orchestrator-spawn`'s RECOVERING CONTEXT + ralph-loop protocol if the user actually wants ongoing autonomous iteration, not just this one fix.

## Notes

- Distinct from `/pc-orchestrator-tuckin` (fleet-side, persists slot status across many clones), `/pc-epic-tuckin` (topic-side, persists EPIC dashboards), and `/pc-orchestrator-recover` (rebuilds processes killed by a host reboot).
  This skill is for a plain new conversation re-orienting inside one slot.
- Its write-side counterpart is `/pc-spawn-tuckin` — run that before a context reset so this skill has a clean commit/PR state to read on the next cold-start.
- Works for both EPIC slots (`.epic-status.json` present) and independent worker sessions (no status file — just a branch and maybe a PR).
