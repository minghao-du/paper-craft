---
name: pc-workspace
description: Prepare, validate, reuse, or clean up Git workspaces when a task needs an assigned checkout or isolated worktree.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /pc-workspace

Manage Git working directories for implementation, review, integrated verification, and manual use.
`pc-workspace` follows the **Kernel-Wrapper Pattern**: deterministic workspace operations are implemented in `packages/workspace` (`packages/workspace/src/cli.ts`, requiring Node.js >= 22), while this document serves as the cognitive wrapper guiding subagents through envelope execution, fallback recovery, and cleanup.

Prepared means that Git repository identity, absolute path, branch, revision, and required cleanliness are verified. Project dependency installation, compute connections, and data checks belong to the consuming task.

---

## 1. Kernel-Wrapper Execution Standard

Specialist subagents dispatched for workspace preparation execute the deterministic TypeScript CLI driven by the Task Input Envelope file (`<receipt_root>/<step>-input.json`).

### Standard Envelope Invocation
Run the CLI helper with the assigned input envelope:

```bash
node --import <paper-craft-root>/node_modules/tsx/dist/loader.mjs <paper-craft-root>/packages/workspace/src/cli.ts prepare --input-envelope "<envelope_path>"
```

### Automated Kernel Actions
Cleanup envelopes (`task.logical_stage: workspace_cleanup`) route to §5 before preparation.

When invoked with `--input-envelope`, the CLI automatically:
1. Loads and parses the input envelope (`schema_version: "1.0"`).
2. Extracts source checkout (`environment.working_directory`), base branch (`environment.base_branch`), issue identity (`task.current_issue_id` or `task.root_issue_id`), branch (`environment.branch`), integrated revision (`environment.commit`), explicit worktree target (`inputs.parameters.worktree` if specified), and receipt path (`contract.receipt_path`).
3. Validates source repository cleanliness, resolves default base branch from GitHub facts, and checks branch ref formats.
4. Prepares or reuses the target worktree (creating `<resolved-container>/issue-<number>` or an explicit path, or checking out a detached revision for integrated verification).
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
    "created": true,
    "outcome": "prepared"
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

When invoked manually without an envelope, the CLI accepts explicit arguments:

```bash
PC_WORKSPACE="node --import <paper-craft-root>/node_modules/tsx/dist/loader.mjs <paper-craft-root>/packages/workspace/src/cli.ts"

# Feature worktree by issue number
$PC_WORKSPACE prepare --repo-dir "<checkout>" --issue <number> [--receipt-path "<path>"] [--base-remote <remote>] [--delivery-target <target>] [--worktree-container <dir>]

# Feature worktree by explicit branch and destination
$PC_WORKSPACE prepare --repo-dir "<checkout>" --branch "<branch>" --worktree "<absolute-path>" [--base "<base>"]

# Rework requiring verified predecessor HEAD
$PC_WORKSPACE prepare --repo-dir "<checkout>" --issue <number> --expected-head "<delivered-commit>"

# Integrated verification (detached HEAD pinned to full commit SHA)
git -C "<checkout>" fetch origin "+refs/heads/<base>:refs/remotes/origin/<base>"
$PC_WORKSPACE prepare --repo-dir "<checkout>" --base "<base>" --worktree "<absolute-path>" --commit "<full-sha>" [--receipt-path "<path>"]
```

When `--receipt-path` is provided, a Markdown receipt is generated and a standard compact report is emitted.

---

## 4. Fallback Procedure for Constrained Environments

If CLI execution is blocked by environment constraints (e.g., Node runtime unavailable), the subagent must execute the manual fallback procedure while preserving contract compliance:

1. **Validate Source**:
   ```bash
   git -C "<source-checkout>" status --porcelain --untracked-files=all
   ```
   Halt if uncommitted modifications exist.
2. **Fetch Base Branch**:
   ```bash
   git -C "<source-checkout>" fetch <base_remote> "+refs/heads/<base>:refs/remotes/<base_remote>/<base>"
   ```
3. **Create or Validate Worktree**:
   - *Feature worktree*:
     ```bash
     git -C "<source-checkout>" worktree add -b <branch> "<target-path>" "refs/remotes/<base_remote>/<base>"
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
   Write the receipt to `contract.receipt_path` using the template at `contract.receipt_template`.
6. **Return Compact JSON Report**:
   Output the standard compact report `{ execution_status, result, receipt_path, summary }` to the caller.

---

## 5. Cleanup Protocol

`cleanup` authorizes removal of assigned worktrees and merged local and remote task branches with verified issue-tree ownership. Run the cleanup subcommand with the cleanup envelope from the retained persistent checkout.

```bash
node --import <paper-craft-root>/node_modules/tsx/dist/loader.mjs <paper-craft-root>/packages/workspace/src/cli.ts cleanup --input-envelope "<envelope_path>"
```

Before execution, reconcile creation receipts with final delivery/verification receipts and durable artifact locations. Confirm all consumers have finished. Supply the reconciled issue-tree inventory in `inputs.parameters.candidates`, including historical resources with verified ownership. For historical candidates, supply `ownership_evidence: { root_issue_id, issue, source }`, where `source` points to the matching PR or durable delivery receipt; verify that issue belongs to the root tree. Use `worktree: null` for branches without worktrees. Supply ambiguous inventory items in `inputs.parameters.unresolved`; never silently omit them. Preserve default/base branches and active resources. Each candidate uses the following fields from its preparation result, updated with its final delivered HEAD and PR identity.

```json
{
  "worktree": "/absolute/path/to/task-worktree",
  "created": true,
  "consumers_finished": true,
  "branch": "issue-12",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "baseBranch": "main",
  "delivery_target": "owner/repo",
  "base_remote": "origin",
  "push_remote": "origin",
  "pr": 12
}
```

For detached verification candidates, use `branch: null` and `verification_completed: true` after checking the verification receipt. Receipts and preserved artifacts must reside outside disposable candidates.

The kernel checks registered path, repository, branch and final HEAD, completed consumers, worktree locks, and tracked/untracked/ignored material. Feature cleanup requires live PR state `MERGED`, matching head branch/SHA and base, plus the PR merge commit in the fetched delivery base. This supports squash merges. Both remote identities must match the PR base and head repositories, including fork delivery.

Delete the remote branch with an exact-SHA lease, remove the worktree without force, then compare-and-delete the local ref at its delivered SHA. Retain changed, active, unmerged, or conflicting resources and report why. Already absent resources permit retry after partial cleanup.

The compact result and durable cleanup receipt contain `removed_paths`, `retained_paths` (path and reason), `removed_branches` (branch, scope, and remote where applicable), and `retained_branches` (branch and reason). Partial progress remains visible in these lists. The result `outcome` is `cleaned` only when both retained lists are empty; otherwise it is `incomplete`. Successful execution with retained resources does not mean workflow completion. Retry outstanding resources after rechecking live state. Invalid cleanup inputs report `blocked`.
