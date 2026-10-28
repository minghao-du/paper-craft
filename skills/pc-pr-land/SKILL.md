---
name: pc-pr-land
description: Land a PR branch — squash merge, clean up local and remote branches, return to main.
---

# /pc-pr-land

Read [the shared runtime and workflow contract](../lib/workflow.md) before using helper commands or runtime-specific tools.
Tmux is shared infrastructure; Claude-specific tool names and examples apply only when that runner provides them, with file-based delivery otherwise.

Squash-merge the current branch's PR and clean up.

## Usage

```
/pc-pr-land           # Land the current branch's PR
/pc-pr-land #42       # Land PR #42 (if not on that branch)
```

## Worktree mode

If the worker runs in a linked Git worktree, this skill detects that in Step 7a and performs the base-branch pull from the primary clone, then removes the worktree in Step 8 before deleting the branch.
In the common clone-mode case (no `layout:` block) every step runs as it always has — the worktree detection is a no-op.

## Where to stand

Use only as a landing agent dispatched by the conductor under the shared
**Scheduling and approval contract**. Workers report clean PRs and retain records;
standing delegation and peer agreement supply no merge authorization.
Before mutation, require recorded user approval for the live PR head, applicable
completion/review and EPIC findings, and explicit worker checkout release.
If the coordinated landing/ownership protocol is unavailable, stop at approval;
never fall back to a direct merge from a worker or conductor session.

Check for co-tenancy using tmux pane paths, recorded ownership and the selected runner's supported process/session evidence.
On Linux with Claude Code, process inspection may include its exact executable and `/proc` cwd; that cannot establish vacancy for other runners or OSes.
Unknown ownership blocks checkout changes and cleanup.
For read-only inspection of a PR, prefer `git show <sha>:<path>` with `gh pr view <N> --json headRefOid`; fetching into an existing local branch needs explicit ref-update handling.

## Workflow

### Step 1: Check for uncommitted work

```bash
git status --porcelain
git diff --stat
```

If there are uncommitted changes or untracked files, you MUST resolve each one explicitly — **never stash and move on**:

1. **Identify every dirty file.**
   For each one, read enough of the diff or file content to understand what it is and why it exists.
2. **Categorize each file:**
   - **Belongs to this PR** (e.g. forgotten formatting fix, test update): stage and commit with a short message.
   - **Unclear**: show the user the file and diff, explain what you see, and ask whether to commit it with the PR or move it aside.
   - **Unrelated / stray**: move it to `_ignore/$(date -I)-landing/` so main stays clean.
     Create the directory if needed.
     Tell the user what you moved and why.
3. **Never use `git stash`.**
   Stashing hides work and risks losing it.
   Every file must be either committed or moved to `_ignore/`.
4. **Ask the user if unsure.**
   If you can't confidently categorize a file, ask.
   A quick question is always better than guessing wrong.

### Step 2: Identify the PR

```bash
# Get current branch
BRANCH=$(git branch --show-current)

# Find the PR for this branch
gh pr view "$BRANCH" --json number,title,state,baseRefName
```

If no PR found, abort: "No PR found for branch `$BRANCH`."
If PR is not open, abort: "PR is already `$STATE`."

Save the base branch name (usually `main` or `master`) from `baseRefName`.

### Step 3: Log and proceed

Print the PR summary line, then continue without waiting for confirmation:

```
Landing: #42 "Add feature X" (branch: my-feature → main)
```

### Step 4: Update base branch and rebase

```bash
git fetch origin
git rebase origin/<base>
```

If rebase has conflicts, stop and report.
Do not force-push or auto-resolve.

### Step 5: Force-push rebased branch

```bash
git push --force-with-lease
```

### Step 5.5: Wait for CI to pass

Check whether the PR has any CI checks configured, and if so, block until they all pass:

```bash
gh pr checks "$BRANCH" --json name,state,conclusion
```

- **No checks configured** (empty array): proceed immediately.
  This repo has no CI for this PR.
- **Checks present**: wait until all required checks are `COMPLETED` with conclusion `SUCCESS` (or `NEUTRAL`/`SKIPPED`).
  Use `gh pr checks "$BRANCH" --watch --fail-fast` to block.
- **Any check fails**: abort with the failing check name and a link via `gh pr view --web`.
  Do **not** merge.
  Report to user and stop.

Never merge a PR with failing or pending required checks.
If checks are still queued/in progress, wait — do not assume they will pass.

### Step 6: Squash merge via gh

First ask GitHub which issues the PR will close — its own parse, which handles code spans and word boundaries:

```bash
gh pr view <N> --json closingIssuesReferences --jq '.closingIssuesReferences[].number'
```

Empty is a defect if the PR has an issue. The field is eventually consistent, so re-read before concluding an edit to the body did not take.

Merge with the guard **inside** the same command, so the base cannot move between check and merge (`--match-head-commit` makes GitHub refuse if the head moved), and always pass `--body` — without it `gh` concatenates every branch commit body into the squash message, and GitHub closes any issue a closing keyword in there names, negated or quoted or not:

```bash
test "$(git rev-parse HEAD)" = "$(gh pr view <N> --json headRefOid -q .headRefOid)" \
  && git fetch -q origin <base> \
  && git merge-base --is-ancestor origin/<base> HEAD \
  && gh pr merge --squash --match-head-commit "$(git rev-parse HEAD)" --body "closes #<issue>"   # or --body "" if it closes nothing
```

If the guard fails, the base moved or HEAD differs from the pushed head: go back to Step 4. An approval names a SHA, so a moved base voids it.

### Step 7a: Preserve EPIC state, then detect worktree mode

Run this as **one** Bash invocation: shell variables do not survive between calls, and the delete of the originals must be conditional on the preserve having verified. It must run before Step 8, which in worktree mode removes the whole directory.

```bash
LAND_DIR=$(pwd -P)
CONFIG=/absolute/path/to/conductor/.epic-config.json
if [ -f "$LAND_DIR/.epic-status.json" ]; then
    RESULT=$(pc workflow preserve --dir "$LAND_DIR" --reason "at land of PR <N>" --config "$CONFIG") || exit 2
    DEST=$(printf '%s\n' "$RESULT" | jq -er 'select(.status == "preserved") | .path') || exit 2
    test -s "$DEST/manifest.json" || exit 2
    echo "Preserved to $DEST; inspect manifest and compare originals before cleanup"
    # Record the verified archive path on the PR; a failed comment does not undo preservation.
fi
```

The destination is `<clone_root>/.preserved/`, outside the slot being retired.
The CLI retains originals on success and failure; preserve, verify and establish exclusive ownership before any separately authorized removal.
A failed or incomplete archive stops cleanup, and the verified path must be recorded on the PR.

Use `git worktree list --porcelain` and the current checkout's Git metadata to identify a linked worktree and the primary checkout; the portable CLI does not implement `pc worktree primary`.
If the primary is separately owned, leave it unchanged rather than switching into it.
Only when `$PRIMARY` has been resolved and its ownership verified may Steps 7 and 7.5 run there; otherwise stay in `$LAND_DIR` and report pending cleanup.

### Step 7: Return to base branch and pull

For a fleet slot, run `pc fleet reclaim-check --dir <slot> --config <authoritative-config>` first and leave checkout changes blocked while it reports unresolved evidence.
For any other checkout, exclusive ownership and verified preservation are prerequisites.

```bash
git checkout <base>
git pull
```

Confirm the landed tree is the gated tree (valid because Step 6 required the head to be current with the base):

```bash
test "$(git rev-parse HEAD^{tree})" = "$(git rev-parse <gated-sha>^{tree})"
```

### Step 7.5: Sync the primary clone (clone-mode only)

**Skip this step if Step 7a already `cd`'d to the primary** — Step 7 has already pulled it.

If you landed from a scratch clone or any working copy that is not the authoritative project checkout, the primary clone is now behind `origin/<base>`.
Pull it forward so the canonical checkout matches `main`.

1. Resolve the primary checkout from the actual Git worktree metadata or authoritative conductor config and verify all owners released it before updating it.
   If `$(pwd -P)` already equals it, or the repo isn't listed, skip this step.

2. `git -C "$PRIMARY" pull --ff-only`.
   On failure, warn with the error and continue — the merge is already upstream, nothing is lost.
   Never stash.

3. Report what you did in Step 10.

### Step 8: Remove worktree (if applicable) and delete branch

If Step 7a found that you were landing from a linked worktree, remove the worktree **before** deleting its branch — git refuses to delete a branch that still has a worktree checked out on it:

```bash
if [ -n "$PRIMARY" ] && [ -n "$LAND_DIR" ] && [ "$LAND_DIR" != "$PRIMARY" ]; then
    git worktree remove "$LAND_DIR"   # only after verified ownership, preservation and work accounting
fi
```

Use ordinary non-forced Git removal; a refusal preserves the worktree for investigation.
The portable CLI does not perform automatic reclaim, and unknown ownership or unaccounted work blocks branch deletion as well.
Then delete the local branch:

```bash
git branch -d <branch>
```

The remote branch is already deleted by `gh pr merge` (GitHub default).
If not, also run: `git push origin --delete <branch>`

### Step 9: Ensure clean main

```bash
git status --porcelain
```

If any untracked or modified files remain on main, account for them before separately authorized cleanup; retain verified workflow originals while ownership or cleanup is unresolved:
- Move them to `_ignore/$(date -I)-landing/` (create the directory if needed)
- Report what was moved

The goal is a clean owned checkout after verified preservation; when cleanup remains blocked, report the retained files and actual branch rather than moving them to manufacture cleanliness.

### Step 10: Confirm

Report only verified outcomes, including cleanup blocked or retained files when applicable; the following is a successful-cleanup example:

"Landed #42.
On `<base>`, up to date, worktree clean.
Branch `<branch>` deleted."
If any files were moved to `_ignore/`, list them.
If the primary clone was synced in Step 7.5, say so: "Primary clone `<path>` pulled."
If Step 8 removed a linked worktree, say so: "Worktree `<path>` removed."
If Step 7a preserved EPIC state, say so: "Worklog preserved to `<DEST>`, noted on the PR."
