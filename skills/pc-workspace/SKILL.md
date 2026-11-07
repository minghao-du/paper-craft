---
name: pc-workspace
description: Prepare, validate, reuse, or clean up Git workspaces when a task needs an assigned checkout or isolated worktree.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /pc-workspace

Manage Git working directories for implementation, review, integrated verification, and manual use.
`pc-workspace` follows the **Kernel-Wrapper Pattern**: deterministic workspace operations are implemented in the internal kernel script `scripts/prepare-worktree.py`, while this document serves as the cognitive wrapper guiding subagents through envelope execution, fallback recovery, and cleanup.

Prepared means that Git repository identity, absolute path, branch, revision, and required cleanliness are verified. Project dependency installation, compute connections, and data checks belong to the consuming task.

---

## 1. Kernel-Wrapper Execution Standard

Specialist subagents dispatched for workspace preparation should execute the deterministic kernel script driven by the Task Input Envelope file (`<receipt_root>/<step>-input.json`).

### Standard Envelope Invocation
Run the bundled helper with the assigned input envelope:

```bash
python3 <skill-dir>/scripts/prepare-worktree.py --input-envelope "<envelope_path>"
```

### Automated Kernel Actions
When invoked with `--input-envelope`, the kernel script automatically:
1. Loads and parses the input envelope (`schema_version: "1.0"`).
2. Extracts source checkout (`environment.working_directory`), base branch (`environment.base_branch`), issue identity (`task.current_issue_id` or `task.root_issue_id`), branch (`environment.branch`), integrated revision (`environment.commit`), explicit worktree target (`inputs.parameters.worktree` if specified), and receipt path (`contract.receipt_path`).
3. Validates source repository cleanliness, resolves default base branch from GitHub (`gh repo view`), and checks branch ref formats.
4. Prepares or reuses the target worktree (creating `<primary>-worktrees/issue-<number>` or an explicit path, or checking out a detached revision for integrated verification).
5. Writes the standard Markdown receipt file to `contract.receipt_path` adhering to the unified receipt contract.
6. Emits the compact JSON report to stdout.

The subagent captures stdout and returns the compact JSON report to the Orchestrator without further manual Git commands.

---

## 2. Compact Report & Receipt Contract

### Compact Report (stdout)
The kernel emits a machine-parseable JSON object:

```json
{
  "execution_status": "succeeded",
  "result": {
    "repository": "owner/repo",
    "working_directory": "/path/to/worktree",
    "worktree": "/path/to/worktree",
    "branch": "issue-12",
    "baseBranch": "main",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "created": true
  },
  "receipt_path": "/path/to/receipts/01-workspace-prepare-receipt.md",
  "summary": "Prepared feature worktree for issue 12 at /path/to/worktree"
}
```

- **`succeeded`**: Environment prepared or verified cleanly; receipt written.
- **`blocked`**: Preconditions unmet (e.g. uncommitted dirty files in source or target, missing predecessor commit, conflicting active branch checkout).
- **`failed`**: Unrecoverable Git or environment error (corrupted envelope, invalid repository remote).

### Markdown Receipt (`contract.receipt_path`)
The receipt file written by the kernel contains:
- Metadata header: `root_issue_id`, `current_issue_id`, `task_type: workspace_prepare`, `execution_status`.
- `## Compact Report`: JSON report block.
- `## Artifacts`: `working_directory`, `repository`, `worktree`, `baseBranch`, `branch`, `commit`.
- `## Verification`: Creation/reuse status, Git status checks, and repository identity verification.
- `## Task Result`: Operational summary and worktree registration details.
- `## Current State and Feedback`: Cleanliness confirmation and any non-fatal diagnostics.
- `## Recovery and Budgets`: Origin stage and execution attempt details.

---

## 3. Direct / CLI Flag Invocation (Manual & Backward Compatibility)

When invoked manually without an envelope, the kernel accepts explicit CLI arguments:

```bash
# Feature worktree by issue number
python3 <skill-dir>/scripts/prepare-worktree.py --repo-dir "<checkout>" --issue <number> [--receipt-path "<path>"]

# Feature worktree by explicit branch and destination
python3 <skill-dir>/scripts/prepare-worktree.py --repo-dir "<checkout>" --branch "<branch>" --worktree "<absolute-path>" [--base "<base>"]

# Rework requiring verified predecessor HEAD
python3 <skill-dir>/scripts/prepare-worktree.py --repo-dir "<checkout>" --issue <number> --expected-head "<delivered-commit>"

# Integrated verification (detached HEAD pinned to full commit SHA)
git -C "<checkout>" fetch origin "+refs/heads/<base>:refs/remotes/origin/<base>"
python3 <skill-dir>/scripts/prepare-worktree.py --repo-dir "<checkout>" --base "<base>" --worktree "<absolute-path>" --commit "<full-sha>" [--receipt-path "<path>"]
```

When `--receipt-path` is provided, a Markdown receipt is generated and a standard compact report is emitted.

---

## 4. Fallback Procedure for Constrained Environments

If script execution is blocked by environment constraints (e.g., Python unavailable or restricted subshell permissions), the subagent must execute the manual fallback procedure while preserving contract compliance:

1. **Validate Source**:
   ```bash
   git -C "<source-checkout>" status --porcelain --untracked-files=all
   ```
   Halt if uncommitted modifications exist.
2. **Fetch Base Branch**:
   ```bash
   git -C "<source-checkout>" fetch origin "+refs/heads/<base>:refs/remotes/origin/<base>"
   ```
3. **Create or Validate Worktree**:
   - *Feature worktree*:
     ```bash
     git -C "<source-checkout>" worktree add -b <branch> "<target-path>" "refs/remotes/origin/<base>"
     ```
   - *Detached verification worktree*:
     ```bash
     git -C "<source-checkout>" worktree add --detach "<target-path>" "<commit-sha>"
     ```
4. **Verify Target Cleanliness & Identity**:
   ```bash
   git -C "<target-path>" status --porcelain
   git -C "<target-path>" rev-parse HEAD
   ```
5. **Write Markdown Receipt**:
   Write the receipt to `contract.receipt_path` conforming to `templates/subagent-receipt.template.md`.
6. **Return Compact JSON Report**:
   Output the standard compact report `{ execution_status, result, receipt_path, summary }` to the caller.

---

## 5. Cleanup Protocol

Accept only explicitly assigned candidate directories. Automatic cleanup applies to directories created for completed work whose consumers have finished.

1. **Verify State**: Confirm registered path, branch, and recorded final HEAD. Retain missing or conflicting environments with observed state.
2. **Inspect Material**: Check tracked/untracked/ignored changes with `git status --short --ignored`. Retain candidates containing unpreserved research records, data, logs, or active users.
3. **Confirm Delivery**: Verify feature work is merged into base via PR merge commit evidence. Detached verification environments require completed verification evidence.
4. **Remove Worktree**:
   ```bash
   git -C "<retained-checkout>" worktree remove "<candidate-path>"
   ```
   Preserve directories Git refuses to remove and report the reason. Keep branch refs unless deletion was explicitly requested.

Return removed and retained paths with reasons. A retained directory is an explicit cleanup result.
