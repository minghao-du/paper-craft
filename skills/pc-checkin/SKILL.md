---
name: pc-checkin
description: "Check in on recent GitHub activity across tracked repos. Filters to items needing your action (ball-in-court)."
---

# /pc-checkin

Check in on recent activity across tracked repos.
Shows issues, PRs, and comments that need your attention.

## Instructions

Run the check-in to fetch recent GitHub activity:

```bash
pc checkin
```

This will:
1. Read repos from `sources.yml`
2. Fetch issues, PRs, and comments updated since last check-in
3. **Filter to items needing your action** (ball-in-my-court logic)
4. Display activity grouped by repo with GitHub refs (e.g., `matsengrp/repo#123`)
5. Check board sync status

## Ball-in-my-court filtering (default)

By default, checkin only shows items where you need to act:

| Scenario | Shown? | Reason |
|----------|--------|--------|
| Their issue/PR, no comments, you're involved* | Yes | Need to review |
| Their issue/PR, no comments, no involvement | No | Not your responsibility |
| Their issue/PR, they commented last | Yes | They pinged again |
| Their issue/PR, you commented last | No | Waiting for their reply |
| Your issue/PR, no comments | No | Waiting for feedback |
| Your issue/PR, they commented last | Yes | They replied |
| Your issue/PR, you commented last | No | Waiting for their reply |

*"You're involved" means at least one of: you're an assignee, requested reviewer, @mentioned in the body, or have previously commented on the item.

Use `--broad` to restore the older behavior (every teammate item with no window activity counts as needing review).
Use `--all` to disable filtering entirely.

## Options

- `pc checkin --all` — Show all activity (disable ball-in-my-court filtering)
- `pc checkin --broad` — Legacy broad filter (count every teammate item as needing review)
- `pc checkin --since 2d` — Check activity from last 2 days instead of last check-in
- `pc checkin --since 12h` — Check activity from last 12 hours
- `pc checkin --repo matsengrp/dasm2-experiments` — Check single repo
- `pc checkin --category code` — Check only repos in the "code" category
- `pc checkin --summarize` — Add LLM-generated take-home summaries for each item (uses claude CLI)

## Review workflow

After checkin shows activity, spawn tmux windows for items that need review:

Use `/pc-orchestrator-spawn` for the issue's brief, placement and checked tmux launch with the selected runner.
The current CLI does not implement `pc spawn`; retain a prepared brief if launch is unavailable.

Each window:
- Opens in the correct local repo clone
- Launches the selected agent runner with context about the issue/PR
- Named by repo and number (e.g., `repo#123`)

Record the pane identifier and confirm the runner actually started the review.
Retire only the owned pane after its work and dependent jobs finish; a window alone is not evidence of a live reviewer.

## Board triage (optional)

After presenting checkin results, ask the user:

> "Would you like to review board triage?
> I can check if any issues from this checkin should be added to project boards."

If they agree, then:

1. **Get current board state**:
   ```bash
   pc board list --json
   ```

2. **Compare with checkin issues**: Look for issues that:
   - Are newly opened (not just updated)
   - Have active discussion suggesting work is planned
   - Are assigned or have milestone set
   - Are NOT already on a board

3. **Propose additions**: For each candidate, suggest:
   ```
   pc board add <repo>#<number>    # <one-line reason>
   ```

Skip issues that are:
- Already on a board
- Stale (no recent activity beyond the update that triggered checkin)
- Pure questions/discussions without actionable work
- Already closed

## Action item verification

Before presenting any item as an action item (e.g., "ready to merge", "needs review"):
- Verify current state with `gh pr view --repo <owner>/<repo> <number> --json state` or `gh api`
- Do NOT infer state from comment content alone — checkin shows *activity*, not *status*
- Only label items as actionable if they are confirmed OPEN and awaiting the user's input

## Output guidelines

When summarizing checkin results:
- Do NOT include tmux window-switching advice (users have custom prefix keys)
- Include full GitHub URLs for each item so they're clickable
