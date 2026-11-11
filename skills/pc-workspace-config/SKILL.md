---
name: pc-workspace-config
description: Initialize, inspect, or validate project workspace configuration (.paper-craft/workspace-config.json) for orchestrator and worktree automation.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /pc-workspace-config

Manage project-level workspace configuration for paper-craft workflows.
`pc-workspace-config` provides a one-time local initialization wizard and validator, saving a single git-ignored JSON configuration file (`.paper-craft/workspace-config.json`). Once initialized, `pc-orchestrator` and `prepare-worktree.py` automatically consume this configuration without requiring repeated environment parameters.

---

## 1. Configuration Schema

The configuration file is stored at `.paper-craft/workspace-config.json` (relative to repository root):

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

Resolve `<skill-dir>` to the absolute installed directory containing this `SKILL.md`.
The bundled helper script `<skill-dir>/scripts/config.py` supports deterministic configuration operations.

### Initialize Configuration (`init`)
Probe Git repository remotes, default branch, and GitHub repository URL, interactively confirming or setting values:

```bash
# Interactive wizard
python3 "<skill-dir>/scripts/config.py" init

# Non-interactive initialization with probed defaults
python3 "<skill-dir>/scripts/config.py" init --defaults

# Explicit parameter overrides
python3 "<skill-dir>/scripts/config.py" init \
  --delivery-target "owner/repo" \
  --base-remote "origin" \
  --push-remote "origin" \
  --base-branch "main" \
  --worktree-container "../project-worktrees" \
  --defaults
```

### Display Configuration (`show`)
Inspect the active workspace configuration:

```bash
python3 "<skill-dir>/scripts/config.py" show
```

### Validate Configuration (`validate`)
Verify that the configuration exists, complies with schema `1.0`, and references existing Git remotes:

```bash
python3 "<skill-dir>/scripts/config.py" validate
```

Exit code is `0` when valid, or `1` when missing or invalid, printing actionable guidance.

---

## 3. Integration Contracts

1. **pc-orchestrator Entry Gate**:
   On workflow entry, `pc-orchestrator` checks configuration validity. If configuration is missing or invalid, execution halts immediately with a clear explanation guiding the user to run `pc-workspace-config`. No task worktree is created on the error path.
2. **Task Input Envelopes (the orchestrator TypeScript envelope helper)**:
   When creating task envelopes without repetitive CLI parameters, the orchestrator TypeScript envelope helper automatically populates `environment.repository` and `environment.base_branch` from `.paper-craft/workspace-config.json`, passing `delivery_target`, `base_remote`, `push_remote`, and `worktree_container` cleanly under `inputs.parameters`.
3. **Workspace Preparation (`prepare-worktree.py`)**:
   `prepare-worktree.py` reads the configuration to resolve:
   - Target container directory from `worktree_container`.
   - Mainline fetch remote from `base_remote` (starting worktrees from `refs/remotes/<base_remote>/<base_branch>`).
   - Expected repository identity from `delivery_target`, ensuring valid forks are not falsely rejected when `origin` differs from `delivery_target`.
   - Compact reports and receipts preserve `delivery_target`, `base_remote`, and `push_remote`.
   Explicit CLI parameters (`--repo-dir`, `--worktree`, `--base`, `--branch`, `--commit`, `--base-remote`, `--push-remote`, `--delivery-target`, `--worktree-container`) retain highest precedence for full backwards compatibility.
