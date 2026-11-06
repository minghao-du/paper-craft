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
5. Note: `pc-pr-land` does NOT reclaim or delete worktrees; workspace lifecycle is managed by the execution environment.

## Task Inputs

1. **Branch & Base branch:** Feature branch name (`branch`) and base branch to merge into (`baseBranch`, defaults to `main`).
2. **Issue context:** Issue number and references to close on merge (e.g. `Closes #<issue>`).
3. **Repository & working directory:** Target repository (`owner/repo`) and local git checkout.
4. **Approved evaluated commit SHA (optional):** Prior evaluated commit SHA if previously reviewed.

## Verification & Landing Method

### Step 1: Create or update pull request

1. Check if a PR already exists for the branch:
   ```bash
   gh pr list --head "<branch>" --json number,url,state,headRefOid
   ```
2. If no PR exists, create it:
   ```bash
   gh pr create --base "<baseBranch>" --head "<branch>" --title "<concise title>" --body "Closes #<issue>\n\n## Summary\n<summary>\n\n## Test plan\n<test plan>"
   ```
3. If the PR exists and is open, push any updated commits with `--force-with-lease` if needed.
4. If the PR is already merged, extract the merge commit and report success idempotently.
5. If the PR is closed or has merge conflicts, report `blocked` with conflict details.

### Step 2: Invoke pre-merge review

Invoke `pc-pr-review` to audit the live PR and local checkout HEAD:
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
   REMOTE_HEAD=$(gh pr view <PR> --json headRefOid -q .headRefOid)
   ```
2. Ensure `LOCAL_HEAD` equals `REMOTE_HEAD` and matches the reviewed commit SHA.
   **Halt protocol for PR HEAD drift:**
   If the remote PR head moved or checkout HEAD changed after review, **halt immediately**. Prior review approval is invalidated; report `rework_needed` with note on head drift.
3. Verify required CI checks pass:
   ```bash
   gh pr checks <PR> --required
   ```
   If required checks fail or are pending, report `blocked`.

### Step 4: Execute guarded squash merge

Merge using explicit `--match-head-commit` to prevent race conditions:

```bash
gh pr merge <PR> --squash --match-head-commit "$LOCAL_HEAD" --body "Closes #<issue>"
```

- Always use `--match-head-commit`. GitHub atomically rejects the merge if HEAD changed.
- Include closing issue references so GitHub auto-closes the linked issue.

### Step 5: Verify merge completion

Verify the merge result on GitHub:
```bash
gh pr view <PR> --json state,mergedAt,mergeCommit
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
