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
2. **Issue context:** Issue number and association references (e.g. `Refs #<issue>`). Issue closure follows acceptance verification.
3. **Repository & working directory:** Target repository (`repository`, `owner/repo`), absolute `worktree`, feature/base branches, and delivered `commit` SHA. Read these from a supplied predecessor file. Direct invocation may supply them in the task prompt.
4. **Prior review (optional):** Passing verdict and the original `prEvidence` JSON from `pc-pr-review`. A prior SHA alone requires a new review.
5. **Fork context (when applicable):** Base Git remote, head repository, and the Git remote that publishes to it.

## Verification & Landing Method

### Step 0: Validate the delivered environment

Follow [the environment contract](../pc-workspace/references/environment.md) in the assigned
absolute checkout. Validate the repository, branch, clean working tree, and delivered commit
before publishing. For direct invocation, resolve a missing commit from local HEAD and a missing
base branch from the destination repository’s default. Select the base and publish remotes for
the assigned repositories. Use explicit repository and PR identifiers in GitHub commands.

### Step 1: Create or update pull request

Find PRs for the branch in the destination repository, including completed PRs:

```bash
gh pr list --repo "<repository>" --head "<branch>" --state all \
  --json number,url,state,headRefName,headRepository,headRepositoryOwner,headRefOid,baseRefName
```

Select the unique PR for the base branch, head branch, and head repository, including the fork
owner. An ambiguous or conflicting match requires reconciliation. For an existing merged PR,
run the [evidence helper’s `readback`](../pc-pr-review/references/pr-evidence.md) against the
delivered commit and the selected identity. Report a confirmed merge as landed with the observed merge commit.
A closed, unmerged PR is blocked.

Publish the verified branch to its assigned push remote:

```bash
git push --set-upstream "<push remote>" "<branch>"
```

If publishing fails, preserve the checkout and report the conflict. Any history rewrite requires
explicit task authorization and `--force-with-lease`. If no PR exists, prepare a body file outside
the checkout with real newlines, a summary, a test plan, and `Refs #<issue>`. Create the PR with
the destination repository, explicit base, and head branch. For a fork, qualify the head with the
fork owner.

```bash
gh pr create --repo "<repository>" --base "<baseBranch>" --head "<branch or owner:branch>" \
  --title "<concise title>" --body-file "<absolute PR body file>"
```

Use `Refs #<issue>` in the PR and merge body for assigned issues. Replace any auto-closing
keywords for those issues before review because acceptance verification owns issue closure.

### Step 2: Invoke pre-merge review

Invoke `pc-pr-review` with execution bound to the same absolute `working_directory` / `worktree`, supplying the repository, base remote, base branch, numbered PR, head repository, branch, and
delivered commit as the expected evaluated SHA.
- Inspect PR title, squashed body format, clean working tree, test quality, and static analysis results.
- Require a `pass` verdict and its `prEvidence` JSON to proceed. Save the original evidence to an absolute file outside the checkout for verification and readback. Reuse a supplied passing review only when it includes that evidence.

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

### Step 3: Land the reviewed version

With a passing review, run the [landing command](../pc-pr-review/references/pr-evidence.md)
in the assigned checkout with the original capture, destination repository, numbered PR,
assigned identity flags, and `--issue <number>` for an assigned issue. Use its JSON result even
on a nonzero exit. Report `landed` only with the observed merge commit, request fresh review on
`rework_needed`, and report the reason on `blocked`. An open or queued PR remains pending.
If readback is unavailable after a merge attempt, resume with read-only `readback` first.
Each subsequent authorized landing attempt revalidates the review and required checks.

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

For a landed delivery with required non-Git deliverables, reference the supplying work receipt and carry its durable `artifact_locations` into the landing receipt.

1. **Landed outcome (`landed`):**
   - `prNumber`: PR number
   - `prUrl`: PR URL
   - `merged`: `true`
   - `mergedCommit`: Merge commit SHA
   - `summary`: Landing summary
2. **Rework needed outcome (`rework_needed`):**
   - `prNumber`: PR number
   - `prUrl`: PR URL
   - Include the observed merge state when available.
   - `findings`: Review findings and defect details
   - `evaluatedCommit`: Evaluated commit SHA
   - `summary`: Reason rework is required
3. **Blocked outcome (`blocked`):**
   - Report the observed merge state. Preserve `mergeState: "unknown"` when the merge attempt could not be reconciled.
   - `summary`: Blocker explanation
