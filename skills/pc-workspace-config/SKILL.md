---
name: pc-workspace-config
description: Initialize, review, or update project workspace configuration (.paper-craft/workspace-config.json). Inspect project conventions and propose evidence-backed changes for user confirmation.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /pc-workspace-config

Manage the git-ignored `.paper-craft/workspace-config.json` in the project's primary Git checkout. `pc-orchestrator` and `packages/workspace` consume this configuration automatically, including from linked worktrees.

## Review on invocation

When the user invokes this skill, review the project configuration by default. Honor explicit requests for a narrower operation such as `show` or `validate`. Workflow entry validation stays read-only.

1. **Load the baseline.** Resolve the primary checkout and read its saved configuration using `findPrimaryCheckout` and `loadWorkspaceConfig` from `packages/workspace-config/src/index.ts`. If the file is absent, build a read-only draft with `prepareWorkspaceConfigInitialization`. If the file cannot be parsed, report the error and ask how to repair it before replacing any content. Use `validateWorkspaceConfig` to identify invalid fields and include any supported repairs in the proposal.
2. **Inspect project conventions.** Read project instructions and relevant workflow or test configurations. Use Git to check ignore rules and tracked paths.
   - Apply the [Snakemake workspace cleanup policy](../pc-pipeline-snakemake/SKILL.md#workspace-cleanup) to the draft. Initialization checks the standard layout automatically. For existing configurations, call `prepareSnakemakeCleanup(primaryCheckout, draft)` from `packages/workspace-config/src/index.ts` and use its returned `draft`. If project instructions and workflow outputs establish adoption of the standard layout through other conventions, pass `{ standardLayoutConfirmed: true }` as the third argument. Include the cleanup additions in the same approval as other changes.
   - Add custom `cleanable_ignored` paths only when the user explicitly designates them for cleanup. Use narrow repository-relative rules for ignored outputs. Preserve existing entries and report any overlap with `protected_ignored`, which takes precedence.
   - Propose `shared_paths` for specific inputs intended to be shared from the primary checkout. Verify that the exact path can be ignored as a symlink and has no tracked content at or beneath it. Cleanup can unlink a managed link while retaining its primary checkout target.
3. **Show the proposed changes.** Validate the draft with `validateWorkspaceConfig` before asking for approval. Present one diff against the current configuration, or the full draft for initialization. Cite the project files that justify each change. Explain that adding `cleanable_ignored` permits deletion of ignored files in those paths when an eligible task worktree is cleaned. Ask the user to approve the exact changes. If the existing configuration validates and there is no justified change, report that it is valid and leave the file untouched.
4. **Apply the approved changes.** Re-read the file before writing. If it changed since the diff was shown, refresh the diff and confirm again. Preserve unrelated keys and existing list entries. Use `saveWorkspaceConfigInitialization` with the approved configuration and the resolved primary checkout. Enable `force` only for an approved update to an existing file. Run `validate` against the saved configuration and report the result. If the user declines or does not confirm, leave the file untouched.

---

## 1. Configuration Schema

The configuration file is stored at `.paper-craft/workspace-config.json` (relative to the primary checkout root):

```json
{
  "schema_version": "1.0",
  "delivery_target": "owner/repo",
  "base_remote": "origin",
  "push_remote": "origin",
  "base_branch": "main",
  "worktree_container": "../project-worktrees"
}
```

### Schema Fields
- `schema_version` (string, required): Schema version, strictly `"1.0"`.
- `delivery_target` (string, required): GitHub repository target (`owner/repo`) for Issues, PRs, and verification.
- `base_remote` (string, required): Git remote name used to fetch mainline base code (`origin` for standard projects, `upstream` for forks).
- `push_remote` (string, required): Git remote name used to push feature branches (`origin`).
- `base_branch` (string, required): Mainline base branch name (e.g. `main` or `master`).
- `worktree_container` (string, required): Directory container for task worktrees. Defaults to `../project-worktrees` (resolved relative to the repository root). Custom relative or absolute paths are supported.
- `shared_paths` (string[], optional): Repository-relative, git-ignored paths in the primary checkout (such as `[".venv"]`) to symlink into linked worktrees during `pc-workspace` preparation (and unlink safely during cleanup without deleting primary targets).
- `cleanable_ignored` (string[], optional): Additional repository-relative paths or glob patterns beyond the built-in regenerable cache list that `pc-workspace` cleanup may safely remove after merge/verification checks pass.
- `protected_ignored` (string[], optional): Repository-relative paths or glob patterns that `pc-workspace` cleanup must never auto-remove (takes precedence over built-in defaults and `cleanable_ignored`).

### Project Scenarios

1. **Standard Repository**:
   - `base_remote`: `"origin"`
   - `push_remote`: `"origin"`
   - `delivery_target`: parsed from `origin` URL
   - `base_branch`: default branch on `origin`

2. **Fork Repository**:
   - `base_remote`: `"upstream"` (mainline fetch)
   - `push_remote`: `"origin"` (feature push)
   - `delivery_target`: parsed from `upstream` URL (e.g. `upstream-owner/repo`)
   - `base_branch`: default branch on `upstream`
   - Automated detection when `upstream` remote exists; fully configurable via CLI flags.

---

## 2. CLI Commands & Options

Configuration CLI is implemented in TypeScript in `packages/workspace-config/src/cli.ts` (requires Node.js >= 22).
Execute using the repository's loader:

```bash
# Set command prefix
PC_CONFIG="node --import <paper-craft-root>/node_modules/tsx/dist/loader.mjs <paper-craft-root>/packages/workspace-config/src/cli.ts"
```

### Initialize Configuration (`init`)
Probe Git repository remotes, default branch, and GitHub repository URL, interactively confirming or setting values:

These commands write configuration. `--defaults` accepts the draft and any applicable standard Snakemake cleanup rules. Existing values are the defaults for reinitialization. The interactive wizard lists new cleanup rules before asking to save them. For the skill's review flow, use the read-only draft and approval steps above.

```bash
# Interactive wizard
$PC_CONFIG init [--repo-dir <path>]

# Non-interactive initialization with probed defaults
$PC_CONFIG init --defaults [--repo-dir <path>]

# Explicit parameter overrides
$PC_CONFIG init \
  --delivery-target "owner/repo" \
  --base-remote "origin" \
  --push-remote "origin" \
  --base-branch "main" \
  --worktree-container "../project-worktrees" \
  --defaults \
  --repo-dir <path>
```

### Display Configuration (`show`)
Inspect the active workspace configuration:

```bash
$PC_CONFIG show [--repo-dir <path>]
```

### Validate Configuration (`validate`)
Verify that the configuration exists, complies with schema `1.0`, and references existing Git remotes:

```bash
$PC_CONFIG validate [--repo-dir <path>]
```

Exit code is `0` when valid, or `1` when missing or invalid, printing actionable guidance.

---

## 3. Integration Contracts

1. **pc-orchestrator Entry Gate**:
   On workflow entry, `pc-orchestrator` checks configuration validity. If configuration is missing or invalid, execution halts immediately with a clear explanation guiding the user to run `pc-workspace-config`. No task worktree is created on the error path.
2. **Task Input Envelopes (the orchestrator TypeScript envelope helper)**:
   When creating task envelopes without repetitive CLI parameters, the orchestrator TypeScript envelope helper automatically populates `environment.repository` and `environment.base_branch` from `.paper-craft/workspace-config.json`, passing `delivery_target`, `base_remote`, `push_remote`, and `worktree_container` cleanly under `inputs.parameters`.
3. **Workspace Preparation (`packages/workspace`)**:
   `packages/workspace` reads the configuration to resolve:
   - Target container directory from `worktree_container` (resolved relative to the primary checkout).
   - Mainline fetch remote from `base_remote` (starting worktrees from `refs/remotes/<base_remote>/<base_branch>`).
   - Expected repository identity from `delivery_target`, ensuring valid forks are not falsely rejected when `origin` differs from `delivery_target`.
   - Compact reports and receipts preserve `delivery_target`, `base_remote`, and `push_remote`.
   Explicit CLI parameters (`--repo-dir`, `--worktree`, `--base`, `--branch`, `--commit`, `--base-remote`, `--push-remote`, `--delivery-target`, `--worktree-container`) retain highest precedence for full backwards compatibility.
