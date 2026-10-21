---
name: pc-conductor-handoff
description: Worker self-spawns a follow-up issue and hands off to a new slot
---

# /pc-conductor-handoff

Read [the shared runtime and workflow contract](../lib/workflow.md) before using helper commands or runtime-specific tools.
Tmux is shared infrastructure; Claude-specific tool names and examples apply only when that runner provides them, with file-based delivery otherwise.

Hand off work from a finishing worker session to a new slot.
Run this from a **worker** (not the conductor) when your current issue is done and you know what should happen next.

## Prerequisites — direction must be decided FIRST

**Do not run this skill until you have a clear next direction.**

If you have just finished an issue and are unsure what comes next:
1. Think through what you learned, what's unresolved, and what the logical next step is
2. Write a **prose proposal** (2-4 sentences) describing the direction and why it's the right next move
3. Present it to the user and **wait for confirmation**
4. Only after the user agrees, proceed with the handoff

This skill is for execution, not ideation.
The thinking happens before you invoke it.

## Usage

```
/pc-conductor-handoff [issue-number]
```

- With an issue number: spawn work for an existing issue
- Without: run `/pc-issue-next` first to create the follow-up issue

## Workflow

### Step 1: Ensure current work is complete

Before handing off, verify:
- Current branch is pushed
- PR is created (or work was exploratory with no PR needed)
- `.epic-status.json` phase is `completed` or `quality-gate`

If not, finish the current work first.

### Step 2: Create follow-up issue (if needed)

If no issue number was provided:
```
/pc-issue-next
```

This drafts and creates the follow-up issue.
Record the new issue number as `<N>`.

### Step 3: Update the EPIC body

Add the new issue to the EPIC dashboard so the conductor sees it.
Follow the **EPIC body update pattern** from `/pc-epic`:

1. Pull the current EPIC body with conflict tracking (`updatedAt`)
2. Add the new issue to the status dashboard (unchecked)
3. If the current issue's PR is ready, check its box
4. Conflict-check and push

If the conflict check fails, report it and continue — the conductor will reconcile on next poll.

### Step 4: Select or create a slot

Read `.epic-config.json` from the repo root.

**Finding the config**: In clone mode, `.epic-config.json` is in each clone's repo root.
In worktree mode, it's in the **main checkout** (the conductor's working directory, not the worktree).
To find it:
```bash
# Worktree mode: find the main checkout
MAIN_CHECKOUT=$(git worktree list | head -1 | awk '{print $1}')
cat "$MAIN_CHECKOUT/.epic-config.json"
```

Then select or create a slot:

**Clone mode** (`local_worktrees` absent or false):
```bash
CONFIG=/absolute/path/to/conductor/.epic-config.json
CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
# Find an idle clone (on main, clean worktree)
for name in $(jq -r '.clone_names[]' .epic-config.json); do
  branch=$(git -C "$CLONE_ROOT/$name" branch --show-current 2>/dev/null)
  [ "$branch" = "main" ] && echo "$name"
done
```

Use the absolute authoritative conductor config in every shell invocation; worker snapshots are refused.

These are candidates only: confirm currency, file collisions, holds and release by every owner/job through `/pc-conductor` before selecting one.
Pick the first confirmed available clone **that is not the current clone**.
The handoff should move work to a different slot so the current session can wind down cleanly.
If all other clones are busy, use the current clone as a last resort (after confirming with the user).
If all clones including current are busy, offer to create a new clone using a name from `new_clone_names` in the config.

**Worktree mode** (`local_worktrees: true`):
```bash
CONFIG=/absolute/path/to/conductor/.epic-config.json
CLONE_ROOT=$(pc workflow root --config "$CONFIG" --path) || exit 2
SLOT="$CLONE_ROOT/issue-<N>"
SLUG=$(gh issue view <N> --json title -q '.title' | tr '[:upper:]' '[:lower:]' | awk '{for(i=1;i<=4&&i<=NF;i++) printf "%s%s",$i,(i<4&&i<NF?"-":"")}')

if [ -d "$SLOT" ]; then
  echo "Worktree exists — will resume"
else
  # Clean up leftover branches from previous attempts
  # Inspect leftover branches; preserve and resolve unmerged work before creating or reusing a slot.
  git -C "$MAIN_CHECKOUT" branch --list "<N>-*"
  # Proceed below only after those checks and exclusive ownership are established.
  # Create worktree from the main checkout
  git -C "$MAIN_CHECKOUT" worktree add "$SLOT" -b "<N>-$SLUG"
fi
```

### Step 5: Prepare the slot

**Clone mode**:
```bash
SLUG=$(gh issue view <N> --json title -q '.title' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 ]//g' | awk '{for(i=1;i<=4&&i<=NF;i++) printf "%s%s",$i,(i<4&&i<NF?"-":"")}')
cd "$CLONE_ROOT/<clone-name>"
git checkout main && git pull --ff-only origin main
git checkout -b "<N>-$SLUG"
# Preserve and verify existing state via /pc-conductor-spawn Step 2 before separately authorized cleanup.
```

The branch **must** be created before spawning.
If the spawn starts on `main`, any uncommitted work lands on `main` and is hard to rescue.

**Worktree mode** — just clear stale status files:
```bash
pc workflow preserve --dir "$SLOT" --reason "before handoff reuse" --config "$CONFIG"
# Inspect the archive and confirm ownership before separately authorized cleanup; stop on failure.
```

### Step 6: Compose prompt and spawn

Follow `/pc-conductor-spawn` Steps 3-4 to compose the prompt, keeping its full gates and issue-lead protocol:
1. Read the new issue: `gh issue view <N>`
2. Compose the full prompt including:
   - A branch guard as the **first line**: `IMPORTANT: Before doing any work, verify you are on branch <N>-<slug> (run "git branch --show-current"). If you are on main, run "git checkout -b <N>-<slug>" first. Never commit directly to main.`
   - `/pc-issue-work <N>` as the core instruction
   - Iteration/stopping-point protocol; Ralph invocation only for Claude Code with that plugin
   - EPIC status protocol (`.epic-status.json` fields, worklog format)
   - Any phasing or gate criteria from the issue
3. Use the **Write tool** to create `/tmp/spawn-<N>.txt` with the full prompt (do NOT use shell redirection — complex prompts break zsh expansion)

Then follow `/pc-conductor-spawn` Step 5 for the checked tmux launch in the selected directory using the installed runner's documented input method.
Keep the issue/slot window name, explicit working directory, branch guard and startup confirmation.
The current CLI does not implement `pc spawn`; report prepared when startup is unavailable and leave intent queued.
After verified startup, use `pc workflow intent consume <N> --config <authoritative-config>` and verify its returned archive path.
A failed consumption after startup must be reported so queued intent cannot trigger a duplicate worker.

### Step 7: Clean up current slot (optional)

If the current issue's PR is merged:
- **Worktree mode**: refer cleanup to the conductor
- **Clone mode**: refer checkout changes to the conductor

Both modes retain terminal, ownership and preservation gates; `pc fleet reclaim-check` is read-only and currently blocks automatic reclaim.

Don't force-remove your own worktree while you're in it — just let the conductor handle cleanup.

### Step 8: Report

```
## Handoff Complete

- Finished: i<current> — <title>
- Handoff: i<N> — <title> → <slot-name> (<prepared | confirmed started>, with evidence)
- EPIC updated: i<epic-number> ✓ (or ✗ conflict, conductor will reconcile)
```

## Conventions

Same as `/pc-epic`: `iN`/`pN` prefixes, full URLs on first mention.
Tmux windows named `NNN-YYY` where NNN is the issue number and YYY is the clone/slot name (e.g. `281-cedar` in clone mode, `281-issue-281` in worktree mode).

## Layout config (issue #149)

`.epic-config.json` keeps working.
Use the authoritative `.epic-config.json` for clone/worktree layout; this CLI does not implement the upstream global `layout:` launcher.
