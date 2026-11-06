---
name: pc-pr-land
description: Execute PR merge verification and landing, or post-merge artifact preservation and workspace cleanup
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-pr-land

Authoritative instructions for executing pull request merge verification and landing, or performing post-merge artifact preservation and workspace cleanup.
This skill can be invoked directly by a human or agent with a task prompt (standalone/manual mode), or dispatched automatically by the workflow orchestrator.

## Operations Overview

`pc-pr-land` provides two distinct operations based on the task prompt instruction or assigned role:
- **Operation A: PR Merge (Landing):** Verifies approved commit against live PR HEAD, validates base ancestry and checks, and executes guarded squash merge. (Dispatched under role `merger` or manual merge request).
- **Operation B: Cleanup & Preservation (Finalization):** Verifies merge completion, archives essential artifacts, and prepares resources for release. (Dispatched under role `finalizer` or manual cleanup request).

---

## Operation A: PR Merge (Landing)

### Task Inputs

1. **PR context:** PR number or URL (`<PR>`).
2. **Repository & working directory:** Target repository (`owner/repo`) and local git checkout.
3. **Approved evaluated commit SHA (optional):** The specific commit SHA approved during review (from prior evidence or prompt).
4. **Base branch:** Target branch to merge into (defaults to `main` or PR `baseRefName`).
5. **Closing issue references:** Issue numbers to close on merge (e.g. `closes #<issue>`).

### Verification & Landing Method

#### Step 1: Live GitHub and checkout state check
1. Query live PR status on GitHub:
   ```bash
   gh pr view <PR> --json state,headRefOid,baseRefName,closingIssuesReferences,mergeable
   ```
2. Verify local working tree state:
   ```bash
   git status --porcelain
   ```
   **Halt protocol for dirty working tree:**
   A dirty checkout with unstaged or uncommitted changes blocks merge.
   Preserve uncommitted changes in place; never commit, stash, or overwrite them during landing.
3. Check PR state:
   - If the PR is already `MERGED` on GitHub:
     Extract the existing merge commit SHA (`gh pr view <PR> --json mergeCommit -q .mergeCommit.oid`) and report success idempotently without executing another merge.
   - If the PR is `CLOSED` or unmergeable (conflicts):
     Halt immediately and report `blocked`.

#### Step 2: Evaluated commit match & real-time HEAD verification
Inspect local HEAD and real-time remote PR head:
```bash
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(gh pr view <PR> --json headRefOid -q .headRefOid)
```

- When an approved evaluated commit SHA was provided:
  ```bash
  test "$LOCAL_HEAD" = "<evaluated-sha>" && test "$REMOTE_HEAD" = "<evaluated-sha>"
  ```
  **Halt protocol for PR HEAD drift:**
  If the remote PR head moved or local HEAD does not match `<evaluated-sha>`, **halt immediately**.
  Prior review approval is invalidated by the changed head.
  Explain clearly that the PR head has changed from the approved commit, requiring a fresh review before merge.

#### Step 3: Base branch synchronization & check verification
1. Fetch base branch:
   ```bash
   git fetch origin <base>
   ```
2. Verify base ancestry:
   ```bash
   git merge-base --is-ancestor "origin/<base>" "$LOCAL_HEAD"
   ```
   If base has moved ahead: rebase onto `origin/<base>`.
   If a rebase changes the commit SHA, push with `--force-with-lease` and halt for re-verification and fresh review.
3. Verify required checks:
   ```bash
   gh pr checks <PR> --required
   ```
   All required CI checks must pass. If checks are pending or failing, halt and report `blocked`.

#### Step 4: Execute guarded squash merge
Merge using explicit `--match-head-commit` to prevent race conditions:

```bash
gh pr merge <PR> --squash --match-head-commit "<evaluated-sha>" --body "closes #<issue>"
```

- Never use an unguarded merge. The `--match-head-commit` flag ensures GitHub atomically rejects the merge if HEAD moved.
- Include closing issue references in the squash body so GitHub auto-closes the linked issue.

#### Step 5: Verify merge completion
Verify the merge result on GitHub:
```bash
gh pr view <PR> --json state,mergedAt,mergeCommit
```
Extract the landed merge commit SHA (`mergeCommit.oid`).

### Merge Outputs

1. **Merged Commit SHA:** The SHA of the landed squash commit on the base branch (`merged_commit`).
2. **Submission / Result:**
   - **When dispatched via workflow engine:** Submit the result using the command provided in the dispatch prompt:
     - On success: outcome `completed`, summary `"Squash merged PR #<PR> into <base>"`, artifacts `{"merged_commit":"<merge-commit-sha>"}`.
     - When blocked: outcome `blocked`, summary `"Merge blocked: <reason>"`, artifacts `{"merged_commit":""}`.
   - **When invoked manually or standalone:** Report the landed merge commit SHA, PR status, and confirm issue closure to the caller.

---

## Operation B: Post-Merge Cleanup & Preservation

### Task Inputs

1. **Workspace & repository:** Working directory / checkout path to preserve or clean.
2. **PR / Issue context:** PR number or issue number confirming completion.
3. **Preservation configuration:** Path or destination for archived run records and artifacts.

### Verification & Cleanup Method

#### Step 1: Verify prerequisites
1. Verify PR is confirmed merged on GitHub:
   ```bash
   gh pr view <PR> --json state -q .state
   ```
   Must equal `MERGED`. Never clean up an unmerged branch or worktree without explicit operator override.
2. Verify all linked issues are closed.
3. Verify working directory is clean:
   ```bash
   git status --porcelain
   ```
   Ensure no untracked experimental results or uncommitted work remain unaccounted for.

#### Step 2: Artifact preservation
Archive important run artifacts, benchmark results, logs, and research records before deletion:
```bash
pc workflow preserve --dir <checkout> --reason "after final records for PR <PR>"
```
(Or create a local tar/zip archive for standalone runs).
Ensure the preservation bundle is verified on disk before any destructive removal.

#### Step 3: Resource lifecycle & cleanup scope
The boundary of responsibility for resource cleanup is strictly defined:
- **Automated Workflow Runs:**
  **Process termination and worktree directory removal are controlled and performed by the Workflow Engine** (`engine.releaseRunResources`).
  The cleanup agent's responsibility is to:
  1. Confirm PR merge state on GitHub.
  2. Complete required artifact preservation.
  3. Ensure no dirty untracked files remain.
  4. Submit `release_evidence` confirming readiness for engine release.
  The engine then cleanly terminates remaining agent executions and removes the temporary worktree.
- **Manual / Standalone Runs:**
  When operating manually outside the workflow engine:
  1. Switch out of the worktree directory.
  2. Remove the linked worktree:
     ```bash
     git worktree remove <worktree-path>
     ```
  3. Delete the merged local feature branch:
     ```bash
     git branch -d <branch>
     ```
  4. Delete the remote feature branch (if appropriate):
     ```bash
     git push origin --delete <branch>
     ```

### Cleanup Outputs

1. **Release Evidence:** Evidence confirming artifact preservation and checkout clean state (`release_evidence`).
2. **Submission / Result:**
   - **When dispatched via workflow engine:** Submit result via the command provided in the dispatch prompt:
     - On success: outcome `completed`, summary `"Final records preserved and checkout verified for release"`, artifacts `{"release_evidence":"preservation verified, worktree clean"}`.
     - When blocked: outcome `blocked`, summary `"Cleanup blocked: <reason>"`, artifacts `{"release_evidence":""}`.
   - **When invoked manually or standalone:** Report preserved archive paths and deleted branch/worktree status to caller.

---

## Quality Requirements & Completion Criteria

1. **Merge completion:**
   - Real-time PR HEAD matches the evaluated commit SHA.
   - Base branch ancestry is clean; required CI checks pass.
   - Squash merge succeeds on GitHub with verifiable `merged_commit` SHA.
   - Linked issue auto-close is verified.
2. **Cleanup completion:**
   - PR is confirmed merged on GitHub.
   - Required artifacts and records are preserved.
   - No untracked work or dirty files are discarded without authorization.
   - Resource release readiness is confirmed.
