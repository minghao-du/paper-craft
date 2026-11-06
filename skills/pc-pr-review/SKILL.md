---
name: pc-pr-review
description: Run comprehensive pre-merge quality checklist for current branch's PR
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-pr-review

Authoritative instructions for conducting a comprehensive quality review before merging a pull request.
This skill can be invoked directly by a human or agent with a task prompt (standalone/manual mode), or dispatched automatically by the workflow orchestrator.

## Task Inputs

Before starting the review, ensure the following inputs are available:
1. **PR context / target branch:** PR number, URL, or local feature branch (`gh pr view` or `git branch --show-current`).
2. **Base branch:** Base branch to compare against (defaults to `origin/<base>` resolved via `gh pr view --json baseRefName` or `origin/main`).
3. **Evaluated commit SHA (optional):** Target commit SHA to review (when dispatched with a specific evaluated revision, the live PR head must match it).
4. **Repository & working directory:** The git checkout / worktree of the PR.
5. **Review focus & acceptance criteria:** Specific issue requirements, acceptance criteria, or prior review feedback to verify against.

## Review Method & Professional Verification Steps

### Step 1: Base branch & PR HEAD verification

Always fetch remote state first so comparisons reflect the true upstream state:

```bash
git fetch origin
```

1. **Resolve base branch:**
   ```bash
   BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo "main")
   ```
   Always compare against `origin/$BASE` rather than a local branch to avoid stale references.

2. **Verify target evaluated commit:**
   Record the current checkout HEAD and remote PR head:
   ```bash
   LOCAL_HEAD=$(git rev-parse HEAD)
   REMOTE_HEAD=$(gh pr view --json headRefOid -q .headRefOid 2>/dev/null || echo "$LOCAL_HEAD")
   ```
   - When an evaluated commit SHA was explicitly specified in the task dispatch/prompt:
     Verify that `LOCAL_HEAD` and `REMOTE_HEAD` match the specified SHA.
     If the PR HEAD has moved or local checkout differs:
     **Halt review immediately.** Explain that the PR head has changed, requiring a re-targeted review.
   - For standalone or manual review:
     Use `LOCAL_HEAD` as the evaluated commit (`reviewed_commit`).

3. **Identify changed files:**
   ```bash
   git diff "origin/$BASE...$LOCAL_HEAD" --name-only
   ```
   Focus review on changed files rather than the entire codebase.

### Step 2: Check for project-specific checklist & detect project type

First check for custom project guidelines:
1. Look for `PRE-MERGE-CHECKLIST.md` in the repo root.
2. If not found, inspect `AGENTS.md` or `CLAUDE.md` for a "Pre-PR Quality Checklist" or "Pre-Merge Checklist" section.
3. If a project-specific checklist is present, incorporate its requirements into the checks.

Detect applicable project types to determine appropriate review modes:

| Indicator | Project Type | Reviewers / Skills |
|-----------|--------------|-------------------|
| `workflow/*.smk` or `Snakefile` | Snakemake pipeline | `pc-pipeline-snakemake` |
| `*.py` files in `src/` or root | Python project | `pc-review-clean-code` + `pc-review-code-reuse` |
| `package.json` | Node.js / TypeScript | `pc-review-clean-code` + `pc-review-code-reuse` |
| `build.zig` or `*.zig` | Zig project | `pc-review-zig` |
| `go.mod` | Go project | `pc-review-clean-code` + `pc-review-code-reuse` |

When both apply, run them in parallel:
- **Clean code reviewer:** Audits the diff against clean-code principles (naming, single responsibility, function length, DRY within hunks).
- **Code reuse reviewer:** Surveys the surrounding codebase first to audit for missed reuse of existing helpers, constants, patterns, and conventions.

### Step 3: Check for large files and transient cruft

Scan changed files for artifacts that should never be committed:
- **Forbidden cruft:** HTML renders from notebooks (`.html`), binary archives (`.zip`, `.tar`, `.gz`, `.pkl`, `.npy`), cache artifacts (`__pycache__/`, `dist/`, `node_modules/`), large datasets (>100KB).
- **Check file sizes:**
  ```bash
  git diff "origin/$BASE...$LOCAL_HEAD" --name-only | xargs -I{} sh -c 'test -f "{}" && stat -f "%z %N" "{}" 2>/dev/null || stat --format="%s %n" "{}" 2>/dev/null' | awk '$1 > 102400 {print}'
  ```
  Flag any detected cruft or oversized files as blocking issues.

### Step 4: Run automated quality checks

Run the repository's configured static and dynamic validation commands:

| Tool Indicator | Check Commands |
|----------------|----------------|
| `package.json` (TypeScript/JS) | `npm run typecheck && npm run lint && npm test` |
| `pyproject.toml` with ruff | `ruff check . && pytest` |
| `pixi.toml` | `pixi run check` or `pixi run test` |
| `Makefile` with `check` | `make check` |
| `build.zig` | `zig build test && zig fmt --check src/ tests/` |
| `go.mod` | `go test ./... && go vet ./...` |
| `Snakefile` | `snakemake --lint` |

Verify all automated checks exit 0 without errors.

### Step 5: Test quality audit

Audit the test changes for substantive verification:
1. **No placeholder tests:** Ensure tests have real assertions, not just empty bodies or `pass`.
2. **No forbidden mocks:** Adhere to project guidelines regarding real vs mocked dependencies.
3. **No trivial assertions:** Check for `assert True`, `expect(true).toBe(true)`, or meaningless tautologies.
4. **No swallowed exceptions:** Verify test code does not catch and silently discard unexpected errors.
5. **Test budget:** Verify that individual test execution stays well within the project budget (under 120 seconds).

### Step 6: Conditional domain reviews

- **Scientific Conclusion Skeptic (conditional):**
  If the PR claims benchmark improvements, accuracy figures, or algorithmic comparisons:
  Follow `pc-skeptic` to audit methodology, data splits, fair comparisons, and plausible effect sizes.
- **Rendered Notebook Cold Read (conditional):**
  If the PR adds or updates committed `.html` notebook renders:
  Perform a cold read to ensure the stated question and answer are immediately clear from the first screen.
- **Mathematical Documentation (conditional):**
  If the PR implements mathematical, statistical, or algorithmic formulas:
  Verify that mathematical specifications are documented with LaTeX formulas matching the implementation and literature citations.

### Step 7: Synthesize review findings & generate report

Compile findings into a structured report:

```markdown
## Pre-Merge Quality Report

### Review Summary
- Evaluated Commit: `<commit-sha>`
- Base Branch: `origin/<base>`
- Verdict: `<pass | rework | blocked>`

### Quality Checklist
- [x] PR Head and base branch verified
- [x] No transient cruft or oversized binaries
- [x] Automated static checks (lint, typecheck) passed
- [x] Automated test suite passed within budget
- [x] Test audit: no placeholder tests, trivial assertions, or forbidden mocks
- [x] Clean-code & code-reuse reviews completed
- [ ] Domain-specific audits: `<result or skipped>`

### Findings & Action Items
1. `<Item 1 with file:line reference and severity: blocking vs advisory>`
2. `<Item 2>`
```

## Quality Requirements & Decision Criteria

1. **Pass (`pass`):**
   - All acceptance criteria are satisfied.
   - Zero blocking defects in clean-code and code-reuse audits.
   - All automated checks (typecheck, lint, tests) pass.
   - Zero transient cruft or unauthorized large files.
   - High test quality with real assertions and execution within budget.
2. **Rework (`rework`):**
   - Actionable defects, test failures, linter/typecheck errors, or architectural violations requiring code changes.
   - Detail the defect list and reproduction steps in `findings`.
3. **Blocked (`blocked`):**
   - Review cannot proceed due to external blockers: merge conflicts with upstream base, missing external dependencies, or unresolvable environment failures.

## Task Outputs

1. **Evaluated Commit SHA:** The verified commit SHA evaluated during the review (`reviewed_commit`).
2. **Review Report:** Structured report detailing findings, severity, and verification evidence (`findings`).
3. **Review Verdict / Submission:**
   - **When dispatched via workflow engine:** Submit the correlated review result using the command provided in the dispatch prompt:
     - For pass: outcome `pass`, artifacts `{"reviewed_commit":"<commit-sha>","findings":"All checks passed cleanly."}`
     - For rework: outcome `rework`, artifacts `{"reviewed_commit":"<commit-sha>","findings":"<detailed defect list and reproduction steps>"}`
     - For blocked: outcome `blocked`, artifacts `{"reviewed_commit":"<commit-sha>","findings":"<blocker details>"}`
   - **When invoked manually or standalone:** Report the summary, verdict (`pass` / `rework` / `blocked`), evaluated commit SHA, and findings directly to the caller, or post a PR review comment via `gh pr review`.

## Resource Lifecycle

- **Automated workflow runs:** Process execution and temporary worktree lifecycle are managed by the workflow engine. The reviewer agent evaluates the code and returns findings without destroying the working directory.
- **Manual / Standalone runs:** The working directory and branch remain intact for the operator or developer to address findings or proceed to landing.
