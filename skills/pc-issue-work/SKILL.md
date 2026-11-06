---
name: pc-issue-work
description: Implement issue requirements in working directory, follow TDD and code standards, and deliver verified changes
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-issue-work

Authoritative instructions for implementing GitHub issue requirements in the designated working directory.
This skill can be invoked directly by a human or agent with a task prompt, or dispatched automatically by the workflow orchestrator.

## Task Inputs

Before starting work, ensure the following inputs are available:
1. **Issue context:** Issue number, title, description, and comments from GitHub (`gh issue view <issue> --comments`).
2. **Task brief & objectives:** The specific goals, scope, and instructions provided in the dispatch prompt or task assignment.
3. **Environment & working directory:** The assigned git checkout / worktree. Never switch to another directory or branch outside the designated scope.
4. **Prerequisites & dependencies:** Required external files, weights, datasets, environment variables, or upstream build artifacts.

## Implementation Method

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

4. If executing under workflow dispatch, report `blocked` outcome with blocker details. If invoked manually, wait for user direction.

### Step 2: Implementation via TDD red-green loop

- Work strictly inside the assigned working directory.
- Follow the TDD red-green loop:
  1. Write failing tests first at public seams.
  2. Implement minimal code to pass the tests.
  3. Refactor while keeping tests passing.
- Keep individual test execution well within the project budget (under 120 seconds).
- Ensure all quality gates pass:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
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

### Step 5: Pull request creation or update

Create or update the PR for the assigned branch:

```bash
gh pr create --title "<concise title>" --body "<body>"
```

- Include `Closes #<issue>` in the body to auto-close the issue on merge.
- Do NOT manually close the issue.
- Report key findings, test outcomes, benchmark tables, and reproduction commands in the PR body.
- When transient local outputs or benchmarks were produced, record in the PR body where the local outputs were placed alongside reproduction commands and resource metrics.

## Quality Requirements & Completion Criteria

A task is complete only when all criteria are met:
1. **Functional verification:** All new and existing tests pass cleanly.
2. **Static verification:** `npm run typecheck` and `npm run lint` report zero errors or warnings.
3. **Test budget:** All individual tests execute within 120 seconds.
4. **Clean working tree:** No untracked transient cruft, unstaged modifications, or unwanted files remain in the working directory.
5. **PR readiness:** PR is created or updated, linked to the target issue, with clear description and reproduction evidence.

## Task Outputs

1. **Git commits:** Clean, conventional commits on the feature branch.
2. **Pull request:** Created or updated PR linked with `Closes #<issue>`.
3. **Receipt / submission:**
   - When dispatched via workflow engine: the execution receipt is submitted via the `pc workflow submit-result` command supplied in the dispatch prompt.
   - When invoked manually or standalone: report the PR URL, git diff summary, and test verification output to the caller.
