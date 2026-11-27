---
name: pc-pr-review
description: Run comprehensive pre-merge quality checklist for current branch's PR
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, Task
---

# /pc-pr-review

Authoritative instructions for conducting a comprehensive quality review before merging a pull request.
This skill can be invoked directly by a human or agent with an ordinary task prompt or parameters.
This skill strictly reviews the specified revision, returns structured conclusions and evidence, and does not modify source code, execute automatic rebase/push operations, or schedule next steps.

## Working directory

Follow [the environment contract](../pc-workspace/references/environment.md) in the prepared
working directory supplied by the caller. For manual use, select an existing checkout or prepare
one with [pc-workspace](../pc-workspace/SKILL.md) before starting.

## Task Inputs

Before starting the review, ensure the following inputs are available:
1. **PR context / target branch:** PR number, URL, or local feature branch (`gh pr view` or `git branch --show-current`).
2. **Base branch and repository:** Supply the assigned GitHub repository and any expected base branch. Use the PR’s live base when the caller leaves the branch open. Supply the base remote and head repository when reviewing from a fork.
3. **Evaluated commit SHA (optional):** Target commit SHA to review (when dispatched with a specific evaluated revision, the live PR head must match it).
4. **Repository & working directory:** The git checkout / worktree of the PR.
5. **Review focus & acceptance criteria:** Specific issue requirements, acceptance criteria, or prior review feedback to verify against.

## Review Method & Professional Verification Steps

### Step 1: Base branch, PR HEAD & worktree hygiene verification

Resolve a branch or PR URL to a single numbered PR in the assigned GitHub repository. Run
[`capture` from the pull request evidence helper](references/pr-evidence.md), passing the expected
revision when assigned. Keep its JSON as `prEvidence` in the review result. A mismatch in the
assigned checkout or PR identity requires reconciliation before review. Unavailable GitHub
evidence blocks review.

Fetch the recorded base branch from the selected base remote and verify `FETCH_HEAD` equals the
captured `baseCommit`. Review the diff between those exact revisions:

```bash
git diff "<baseCommit>...<commit>" --name-only
```

Use that same range for all changed-file checks. Run `capture` again at handoff and compare its
PR identity and local head with the initial capture. If they changed, return the drift with the
original and observed values. Record the base SHA used for the review diff.

### Step 2: PR metadata audit (Title & Squashed Body)

Fetch PR title and body:
```bash
gh pr view "<prNumber>" --repo "<repository>" --json title,body
```

1. **Evaluate PR title:**
   - Descriptive and concise (under ~70 characters).
   - Describes *what* changed, not *how*.
   - Avoids vague markers like "WIP", branch names, or issue numbers alone.

2. **Evaluate PR body (squashed summary vs historical noise):**
   Evaluate whether the body reads as a clean, coherent summary or as noisy commit history:
   - **Signs of bad (historical/unsquashed) body:**
     - Starts with commit message bullet lists (`* commit message` or `- commit message`).
     - Contains a sequence of past-tense actions reading like a git log.
     - Scattered "Co-Authored-By", "fix typo", "address review", or "WIP" entries.
     - Accumulates one section per review round (e.g. "Reviewer follow-up: ...", "Update:", "History") instead of presenting current truth.
     - Empty or just whitespace.
   - **Signs of good (squashed summary) body:**
     - Has a `## Summary` section with 1-3 bullet points explaining *what* and *why*.
     - Provides enough context for a reader who knows the project but hasn't seen the issue.
     - Has a clear `## Test plan` section.
     - Follows `PROSE-DISCIPLINE.md` and `EVIDENCE-DISCIPLINE.md`.
     - First sentence of each section describes the diff. Where the branch departs from the issue spec, that deviation is stated explicitly.

   Flag unsquashed commit logs or noisy revision history as review defects.

### Step 3: Check for project-specific checklist & detect project type

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

### Step 4: Check for large files and transient cruft in diff

Scan changed files for artifacts that should never be committed:
- **Forbidden cruft:** HTML renders from notebooks (`.html`), binary archives (`.zip`, `.tar`, `.gz`, `.pkl`, `.npy`), cache artifacts (`__pycache__/`, `dist/`, `node_modules/`), large datasets (>100KB).
- **Check file sizes:** For each changed blob present at the reviewed commit, pass
  `<commit>:<path>` as a single argument to `git cat-file -s` and flag sizes above 102400 bytes.
  Flag any detected cruft or oversized files as blocking issues.

### Step 5: Run automated quality checks

Before running any check, inspect `.paper-craft/compute.md` (if present) and honor its execution boundary:
- When `.paper-craft/compute.md` restricts local execution to static checks/linting (disallowing local tests or business code), execute **only** static/lint/format checks locally and verify automated test execution from the implementation receipt or remote compute evidence rather than invoking `pytest` / test suites locally.

Resolve check tools strictly from the project's declared configuration (`pyproject.toml`, `package.json`, `PRE-MERGE-CHECKLIST.md`, or `AGENTS.md`) and project-local environment (`.venv/bin/<tool>`, `uv run`, `node_modules/.bin/<tool>`). When a project-specific checklist from Step 3 specifies exact check commands, run those commands; skip any tool absent from both project configuration and project-local environment and record it as not configured.

| Tool Indicator | Check Commands |
|----------------|----------------|
| `package.json` (TypeScript/JS) | `npm run typecheck && npm run lint && npm test` (omit `npm test` locally if `.paper-craft/compute.md` forbids local tests) |
| `pyproject.toml` with declared `ruff` or `.venv/bin/ruff` | Verify project-local tool (`test -f .venv/bin/ruff` or `uv run ruff --version`); run `.venv/bin/ruff check .` (plus `.venv/bin/pytest` only when `.paper-craft/compute.md` allows local tests), else run project-declared linters/tests |
| `pixi.toml` | `pixi run check` or `pixi run test` |
| `Makefile` with `check` | `make check` |
| `build.zig` | `zig build test && zig fmt --check src/ tests/` |
| `go.mod` | `go test ./... && go vet ./...` |
| `Snakefile` | Run main entry via project env (e.g. `.venv/bin/snakemake --lint -s workflow/Snakefile`), applying any project baseline exclusions from Step 3 |

- **Remote CI**: For landing, use the shared helper to verify live GitHub requirements. Local workflow files do not establish which checks are required.

Verify all applicable automated checks exit 0 without errors.

### Step 6: Test quality audit

Audit the test changes for substantive verification:
1. **No placeholder tests:** Ensure tests have real assertions, not just empty bodies or `pass`.
2. **No forbidden mocks:** Adhere to project guidelines regarding real vs mocked dependencies.
3. **No trivial assertions:** Check for `assert True`, `expect(true).toBe(true)`, or meaningless tautologies.
4. **No swallowed exceptions:** Verify test code does not catch and silently discard unexpected errors.
5. **Test budget:** Verify that individual test execution stays well within the project budget (under 120 seconds).

### Step 7: Conditional domain reviews

- **Scientific Conclusion Skeptic (conditional):**
  If the PR claims benchmark improvements, accuracy figures, or algorithmic comparisons:
  Follow `pc-skeptic` to audit methodology, data splits, fair comparisons, and plausible effect sizes.
- **Rendered Notebook Cold Read (conditional):**
  If the PR adds or updates committed `.html` notebook renders:
  Perform a cold read to ensure the stated question and answer are immediately clear from the first screen.
- **Mathematical Documentation (conditional):**
  If the PR implements mathematical, statistical, or algorithmic formulas:
  Verify that mathematical specifications are documented with LaTeX formulas matching the implementation and literature citations.

### Step 8: Synthesize review findings & generate report

Compile findings into a structured report:

```markdown
## Pre-Merge Quality Report

### Review Summary
- Evaluated Commit: `<commit-sha>`
- Base Branch and SHA: `<baseBranch>` at `<baseCommit>`
- Verdict: `<pass | rework | blocked>`

### Quality Checklist
- [x] PR Head and base branch verified
- [x] Worktree clean (git status --short -uall emits zero uncommitted changes/cruft)
- [x] PR Title: descriptive and under 70 characters
- [x] PR Body: squashed summary (no commit logs or chronological round noise)
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
   - Worktree is clean and PR metadata (title and squashed body) meets standards.
   - Zero blocking defects in clean-code and code-reuse audits.
   - All automated checks (typecheck, lint, tests) pass.
   - Zero transient cruft or unauthorized large files.
   - High test quality with real assertions and execution within budget.
2. **Rework (`rework`):**
   - Actionable defects, test failures, linter/typecheck errors, PR body commit noise, or architectural violations requiring code changes.
   - Detail the defect list and reproduction steps in `findings`.
3. **Blocked (`blocked`):**
   - Review cannot proceed due to external blockers: merge conflicts with upstream base, missing external dependencies, or unresolvable environment failures.

## Task Outputs

1. **Evaluated Commit and PR Evidence:** The verified head SHA (`reviewed_commit`) and the capture JSON (`prEvidence`) identify the evaluated revisions and PR.
2. **Review Report:** Structured report detailing findings, severity, and verification evidence (`findings`).
3. **Review Verdict:** The verdict (`pass`, `rework`, or `blocked`) with concise summary reported directly to the caller (or posted as a PR review comment via `gh pr review`).

## Resource Lifecycle

The working directory and branch remain intact for the operator, caller, or developer to address findings or proceed to landing.
