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
3. **Environment & working directory:** Repository checkout and optional assigned worktree, feature branch, and base branch. When given a predecessor file, read its environment and verification evidence before starting. Rework uses its worktree, branch, base branch, and commit.
4. **Prerequisites & dependencies:** Required external files, weights, datasets, environment variables, or upstream build artifacts.
5. **Rework context (conditional):** If addressing review findings or repair feedback, inspect predecessor findings, previous HEAD SHA, and original constraints.

## Implementation Method

### Step 0: Prepare the issue worktree

Before editing source files, run the bundled helper using the skill's absolute installation path. It requires Python 3, Git, authenticated GH CLI, and an `origin` remote for the target GitHub repository.

```bash
python3 <skill-dir>/scripts/prepare-worktree.py --repo-dir "<checkout>" --issue <number>
```

The helper queries GitHub repository metadata and creates a local branch `issue-<number>` from the latest remote default branch in `<primary-checkout>-worktrees/issue-<number>`. It prints JSON containing `repository`, `worktree`, `branch`, `baseBranch`, and `commit`. New branches stay local until PR delivery.

- For an assigned environment, supply `--worktree "<absolute-path>" --branch "<branch>" --base "<baseBranch>"`. For rework, also supply `--expected-head "<predecessor-commit>"` to require the existing environment and exact predecessor HEAD.
- Existing registered issue worktrees are validated and reused. Occupied paths, uncommitted changes, base-branch targets, conflicting branches, and missing rework environments stop preparation with an actionable error. Preserve the reported state for resolution.
- Enter the returned absolute `worktree` for source edits, tests, and commits. A separately assigned result or receipt file may be written at its explicit absolute path.
- Retain the worktree after completion for review and rework. The helper leaves the original checkout's branch and files in place.

The underlying local creation commands are shown below. Use the helper for the validation and reuse rules.

```bash
git fetch origin "+refs/heads/<base>:refs/remotes/origin/<base>"
git worktree add --no-track -b "issue-<number>" "<absolute-worktree-path>" "refs/remotes/origin/<base>"
```

When the task explicitly calls for creating a linked branch on GitHub during setup, GH also supports the following command. It creates the remote branch before local checkout, so inspect both states after a partial failure.

```bash
gh issue develop <number> --repo "<owner/repo>" --name "<branch>" --base "<base>" --checkout --worktree "<absolute-worktree-path>"
```

Completion requires a validated issue worktree, clean working tree, and recorded environment JSON.

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

- Work inside the validated issue worktree from Step 0.
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

### Step 4: Selective staging and pre-commit audit

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

## Task Outputs

1. **Git commits / Diff:** Clean, conventional commits on the feature branch, or git diff / commit SHA capturing verified changes.
2. **Verification evidence:** Test execution outputs, benchmark metrics, or check results demonstrating passing quality gates.
3. **Summary:** Concise report of implementation details and verification evidence.
4. **Environment:** `repository` (`owner/repo`), absolute `worktree`, `branch`, `baseBranch`, and final verified `commit` SHA. Refresh `commit` after implementation so the next worker can validate the delivered HEAD. Include this context in any assigned result file, including blocked or rework results when available.
