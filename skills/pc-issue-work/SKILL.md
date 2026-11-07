---
name: pc-issue-work
description: Implement GitHub issue requirements in an isolated worktree, follow TDD and code standards, and deliver verified changes
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-issue-work

Authoritative instructions for implementing GitHub issue requirements in the designated working directory.
This skill can be invoked directly by a human or agent with an ordinary task prompt.

## Task Inputs

Before starting work, ensure the following inputs are available:
1. **Issue context:** Issue number, title, description, and comments from GitHub (`gh issue view <issue> --comments`).
2. **Task brief & objectives:** The specific goals, scope, and instructions provided in the task prompt or assignment.
3. **Environment & working directory:** Prepared absolute working directory, repository identity, feature branch, and base branch. When given a predecessor file, read its environment and verification evidence before starting. Pre-merge rework uses its worktree, branch, base branch, and commit. Post-merge repairs use a fresh assigned worktree and branch from the current base branch. The predecessor provides historical evidence and findings.
4. **Prerequisites & dependencies:** Required external files, weights, datasets, environment variables, or upstream build artifacts.
5. **Rework context (conditional):** If addressing review findings or repair feedback, inspect predecessor findings, previous HEAD SHA, and original constraints.

## Implementation Method

### Step 0: Validate the assigned environment

Follow [the environment contract](../pc-workspace/references/environment.md).
Require a prepared feature worktree before implementation. For manual use, prepare it first with
[pc-workspace](../pc-workspace/SKILL.md). Validate the assigned repository, branch, expected HEAD,
and clean working tree. Preserve conflicts and return expected and observed values to the caller.
Keep the worktree for review and rework, and record the validated environment before editing.

### Step 1: Input and prerequisite verification

Verify that all external prerequisite dependencies and requirements are satisfied before modifying any files.

#### External dependency verification
Inspect the issue requirements for required external inputs — trained models, weights, data tables, or external files.
- When `.paper-craft/compute.md` exists, read it to resolve where each input is consumed and its expected path. Otherwise, use the environment and paths specified in the issue.
- Verify each prerequisite file exists and is readable in that environment.

#### Halt protocol for missing prerequisites
When any prerequisite input is missing, inaccessible, or has an unresolved mapping:
1. **Halt immediately** before modifying files.
2. Never guess missing values, fabricate mock data, or launch unapproved long-running recalculations.
3. Emit the standardized 3-part interactive halt notification:

```markdown
Prerequisite input verification is blocked; the task cannot proceed:
- Input file, consuming environment, expected path, and blocker: `<file, environment, path, missing / inaccessible / unresolved mapping>`
- Dependent operation: `<evaluation script or verification step that requires this file>`
- Action needed: `<provide the file, restore access, or clarify the environment and path; describe the proposed substitute or regeneration plan and request authorization if needed>`
```

4. Report `blocked` outcome with blocker details.

### Step 2: Implementation via TDD red-green loop

- Work inside the validated assigned worktree from Step 0.
- Follow the TDD red-green loop:
  1. Write failing tests first at public seams.
  2. Implement minimal code to pass the tests.
  3. Refactor while keeping tests passing.
- Keep individual test execution well within the project budget (under 120 seconds).
- Ensure all project-configured quality gates pass:
  - Static type checks (e.g. `npm run typecheck`, `pyright`, `mypy`)
  - Linting and formatting (e.g. `npm run lint`, `ruff check`, `cargo clippy`)
  - Automated test suite (e.g. `npm test`, `pytest`, `cargo test`)
- When Snakemake workflows are involved, follow incremental recovery before rerunning.

### Step 3: Adaptive checks for long tasks

Apply adaptive checks to local and remote computation, training, experiments, and long tests:
1. Launch through the configured platform/runtime and retain the exact job ID or PID, execution environment, logs, and completion probe. Verify the probe returns nonzero while unfinished and zero only on verified success.
2. Estimate completion from comparable runs, input size, or measured progress. Record the estimate, its basis, and the next check time before waiting.
3. For SLURM, track submission, queue wait, and actual execution separately.
4. Keep waiting responsive through completion events or a supported scheduled wake-up.

### Step 4: Subagent self-review and repair

After implementation and verification finish, complete self-review before the final commit and delivery.

1. Fix the review scope to the issue's full changes from the merge-base with `origin/<baseBranch>`, including committed, staged, unstaged, and new issue files. Give each reviewer the same absolute working directory, repository, branch, base SHA, current HEAD, changed-file list, issue requirements, and verification evidence. Bind its execution to that directory under the environment contract. Keep the reviewed files unchanged while reviewers run.
2. Launch separate read-only subagents in parallel, each instructed to read and follow its assigned skill at the resolved absolute path. Resolve the following paths relative to this skill's installation directory.
   - One follows [pc-review-clean-code](../pc-review-clean-code/SKILL.md).
   - One follows [pc-review-code-reuse](../pc-review-code-reuse/SKILL.md).
   - When the task produces or relies on computational research conclusions, a third follows [pc-skeptic](../pc-skeptic/SKILL.md), with the exact claims and supporting artifacts or logs. Otherwise skip this subagent and record that no computational research conclusion requires audit.
   Require each subagent to cover the supplied working-tree scope, including uncommitted and new files, and return its skill's findings and evidence. The implementation agent owns all repairs.
3. Wait for every required review. Reconcile findings against the issue scope and repository guidance, fix confirmed defects, and record a reason for dismissed findings or optional suggestions. Re-run configured quality gates after repairs.
4. Reassess which reviews the repairs affect, including shared dependencies and changed claims or evidence. Launch fresh subagents only for affected reviews against the updated changes, retaining unaffected review results with a reason. Repeat repair and affected re-review until every required review is complete and all confirmed defects and unresolved skeptic concerns are resolved.
5. If a required subagent cannot run, fails, or lacks necessary evidence, preserve completed work and report a blocked outcome with the missing review or evidence and recovery action. Resume the outstanding reviews before declaring completion.

### Step 5: Selective staging and pre-commit audit

Maintain zero transient artifacts in git history by staging files selectively:
1. **Selective staging:** Stage modified or new source and test files individually using per-file commands:
   ```bash
   git add <file>
   ```
   Never use indiscriminate staging commands (`git add .`, `git add -A`, or `git commit -a`).
2. **Pre-commit cached diff audit:** Before creating any commit, audit the staged cache:
   ```bash
   git diff --cached --name-only
   ```
   Inspect all staged paths against forbidden transient patterns (`output/*`, `results/*`, `*.joblib`, `*.pt`, `*.tsv`, `*.csv`, `*.png`). If any forbidden path is staged, unstage it immediately (`git reset HEAD <file>`).
3. **Commit:** Commit only verified source code, tests, and documentation using conventional commit messages.

## Quality Requirements & Completion Criteria

A task is complete only when all criteria are met:
1. **Functional verification:** All new and existing tests pass cleanly.
2. **Static verification:** Configured static analysis and lint tools report zero errors or warnings.
3. **Test budget:** All individual tests execute within 120 seconds.
4. **Clean working tree:** No untracked transient cruft, unstaged modifications, or unwanted files remain in the working directory.
5. **Self-review:** Step 4 is complete for the delivered changes, with evidence for required reviews and any skeptic skip.

## Task Outputs

1. **Git commits / Diff:** Clean, conventional commits on the feature branch, or git diff / commit SHA capturing verified changes.
2. **Verification evidence:** Test execution outputs, benchmark metrics, or check results demonstrating passing quality gates. Include self-review results, repairs, finding dispositions, retained-review reasons, and any skeptic skip reason or outstanding review blocker.
3. **Summary:** Concise report of implementation details and verification evidence.
4. **Environment:** `repository` (`owner/repo`), absolute `working_directory` / `worktree`, `branch`, `baseBranch`, and final verified `commit` SHA. Refresh `commit` after implementation so the next worker can validate the delivered HEAD. Include this context in any assigned result file, including blocked or rework results when available.
