---
name: pc-pr-land
description: Create or update PR, invoke pre-merge review, verify target HEAD commit, and land guarded merge
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-pr-land

Authoritative instructions for managing pull request delivery: creating or updating the PR, invoking `pc-pr-review`, verifying target HEAD commit, and executing guarded squash merge.
This skill can be invoked directly by a human or agent with an ordinary task prompt.

## Task Responsibilities

`pc-pr-land` is responsible for:
1. Creating or updating the PR on GitHub for the designated feature branch.
2. Invoking `pc-pr-review` to evaluate the PR head commit.
3. If review findings indicate defects or require changes, returning structured review findings without taking over implementation.
4. If review passes, verifying the live PR head against the evaluated commit SHA and landing a guarded squash merge.
5. Note: `pc-pr-land` does NOT reclaim or delete worktrees; workspace lifecycle is managed through [pc-workspace](../pc-workspace/SKILL.md).

## Task Inputs

1. **Branch & Base branch:** Feature branch name (`branch`) and base branch to merge into (`baseBranch`, defaults to the repository default branch).
2. **Issue context:** Issue number and references to close on merge (e.g. `Closes #<issue>`).
3. **Repository & working directory:** Target repository (`repository`, `owner/repo`), absolute `worktree`, feature/base branches, and delivered `commit` SHA. Read these from a supplied predecessor file. Direct invocation may supply them in the task prompt.
4. **Approved evaluated commit SHA (optional):** Prior evaluated commit SHA if previously reviewed.

## Verification & Landing Method

### Step 0: Validate the delivered environment

Follow [the environment contract](../pc-workspace/references/environment.md). Read the predecessor file when supplied, bind execution to its absolute `worktree`, and use that directory for all Git, GH, and review operations. Validate the local `origin` repository identity against `repository`, the current branch against `branch`, a clean working tree, and `git rev-parse HEAD` against the delivered `commit`. Resolve a missing direct-invocation commit from HEAD and record it before proceeding. Missing paths or conflicting environment fields require a blocked result with the expected and observed values.

Use the supplied `baseBranch`, or query the repository default branch for direct invocation. Preserve the worktree for review and any repair. Write assigned result files at their explicit absolute paths.

### Step 1: Create or update pull request

1. Find existing PRs for the designated repository and branch, including completed PRs.
   ```bash
   gh pr list --repo "<repository>" --head "<branch>" --state all --json number,url,state,headRefOid,baseRefName
   ```
   Confirm the selected PR targets `baseBranch`. If it is already merged and its head matches the delivered commit, verify the merge result and report success idempotently. A closed PR or conflicting identity requires a blocked result.
2. Publish the verified local branch before creating or updating an open PR. Feature branches are prepared locally before this task.
   ```bash
   git push --set-upstream origin "<branch>"
   ```
   If publishing fails, preserve the environment and report the conflict. Any history rewrite requires explicit task authorization and `--force-with-lease`.
3. If no PR exists, prepare a body file outside the source worktree with real newlines, summary, test plan, and `Closes #<issue>`, then create it.
   ```bash
   gh pr create --repo "<repository>" --base "<baseBranch>" --head "<branch>" --title "<concise title>" --body-file "<prepared-pr-body-file>"
   ```
4. For an open PR, continue with the published branch. Report merge conflicts as blocked.

### Step 2: Invoke pre-merge review

Invoke `pc-pr-review` with execution bound to the same absolute `working_directory` / `worktree`, supplying `repository`, `branch`, `baseBranch`, the PR reference, and the delivered `commit` as the expected evaluated SHA:
- Inspect PR title, squashed body format, clean working tree, test quality, and static analysis results.
- Reviewer outputs verdict: `pass`, `rework`, or `blocked`.

#### Handling review findings
- If review verdict is **`rework`**:
  - **Do NOT attempt to implement code fixes.**
  - Extract the review findings, defect list, and evaluated commit SHA.
  - Return outcome `rework_needed` with:
    - `merged: false`
    - `findings`: structured review findings and defect items
    - `evaluatedCommit`: evaluated HEAD commit SHA
    - `prNumber` and `prUrl`
- If review verdict is **`blocked`**:
  - Return outcome `blocked` with blocker explanation and `merged: false`.

### Step 3: Verified HEAD commit match & base branch check

When review verdict is **`pass`**:
1. Inspect local HEAD and remote PR head:
   ```bash
   LOCAL_HEAD=$(git rev-parse HEAD)
   REMOTE_HEAD=$(gh pr view <PR> --repo "<repository>" --json headRefOid -q .headRefOid)
   ```
2. Ensure `LOCAL_HEAD` equals `REMOTE_HEAD` and matches the reviewed commit SHA.
   **Halt protocol for PR HEAD drift:**
   If the remote PR head moved or checkout HEAD changed after review, **halt immediately**. Prior review approval is invalidated; report `rework_needed` with note on head drift.
3. Verify required CI checks pass when configured. If the repository has no `.github/workflows/` directory or the PR base branch has no required CI checks configured, skip this gate and continue to Step 4.
   ```bash
   test -d .github/workflows && gh pr checks <PR> --repo "<repository>" --required || true
   ```
   If `.github/workflows/` is absent, treat CI as not configured and proceed to Step 4. If configured required checks exist on GitHub and fail, are pending, or have not been reported, or configuration/status cannot be verified (e.g. permission or network errors), report `blocked`.

### Step 4: Execute guarded squash merge

Merge using explicit `--match-head-commit` to prevent race conditions:

```bash
gh pr merge <PR> --repo "<repository>" --squash --match-head-commit "$LOCAL_HEAD" --body "Closes #<issue>"
```

- Always use `--match-head-commit`. GitHub atomically rejects the merge if HEAD changed.
- Include closing issue references so GitHub auto-closes the linked issue.

### Step 5: Verify merge completion

Verify the merge result on GitHub:
```bash
gh pr view <PR> --repo "<repository>" --json state,mergedAt,mergeCommit
```
Extract the landed squash commit SHA (`mergeCommit.oid`).

## Quality Requirements & Completion Criteria

1. **When landed:**
   - Review verdict was `pass`.
   - Real-time PR HEAD matched evaluated commit SHA.
   - Guarded squash merge succeeded on GitHub with verified `mergedCommit` SHA.
   - `merged` is `true`.
2. **When rework needed:**
   - Review findings or defects identified.
   - Implementation is NOT modified by `pc-pr-land`.
   - Complete findings, evaluated commit SHA, and PR context returned with `merged: false`.

## Task Outputs

When review or delivery detects HEAD drift, preserve the delivered `commit` and record the observed local/remote SHAs with the findings. Rework must reconcile the mismatch explicitly.

Every result includes the available environment fields (`repository`, absolute `working_directory` / `worktree`, `branch`, `baseBranch`, `commit`). Persist them with review findings in any assigned result file so the next worker can resume directly. Keep the implementation commit separate from `mergedCommit`.

1. **Landed outcome (`landed`):**
   - `prNumber`: PR number
   - `prUrl`: PR URL
   - `merged`: `true`
   - `mergedCommit`: Merge commit SHA
   - `summary`: Landing summary
2. **Rework needed outcome (`rework_needed`):**
   - `prNumber`: PR number
   - `prUrl`: PR URL
   - `merged`: `false`
   - `findings`: Review findings and defect details
   - `evaluatedCommit`: Evaluated commit SHA
   - `summary`: Reason rework is required
3. **Blocked outcome (`blocked`):**
   - `merged`: `false`
   - `summary`: Blocker explanation
