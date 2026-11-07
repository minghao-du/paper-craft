---
name: pc-workspace
description: Prepare, validate, reuse, or clean up Git workspaces when a task needs an assigned checkout or isolated worktree.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /pc-workspace

Manage Git working directories for implementation, review, integrated verification, and manual use.
Prepared means that Git identity, path, branch, revision, and required cleanliness are verified.
Project dependency installation, compute connections, and data checks belong to the consuming task.

## Inputs

- Operation and absolute source checkout, with the expected repository identity.
- For a feature worktree, issue number or explicit branch, base branch, and destination.
- For integrated verification, base branch, destination, and optional full integrated commit SHA.
- For reuse, assigned path, branch or detached revision, and expected HEAD when known.
- For cleanup, exact candidate paths, creation ownership, completion/merge evidence, active users,
  and locations of records and artifacts to retain.

Use ordinary task prompts for manual invocation. Resolve defaults from the source repository.
Read [the environment contract](references/environment.md) before validating or returning an environment.

## Prepare or reuse

The bundled helper requires Python 3, Git, authenticated GH CLI, and an `origin` remote.
Run it through this skill's absolute installation path.

```bash
python3 <skill-dir>/scripts/prepare-worktree.py --repo-dir "<checkout>" --issue <number>
```

This preserves the existing `issue-<number>` branch and `<primary-checkout>-worktrees/issue-<number>`
defaults. Explicit assignments take precedence. Existing registered worktrees are validated and reused.
For a feature task without an issue, supply `--worktree`, `--branch`, and `--base`.
For rework, add `--expected-head "<delivered-commit>"` to require the existing environment.
For a new repair or refactor, choose a fresh path and branch from the current remote base.

For integrated verification, fetch the requested base, resolve its full commit SHA, and prepare
an isolated detached checkout. Preserve an explicitly requested SHA instead of advancing it.

```bash
git -C "<checkout>" fetch origin "+refs/heads/<base>:refs/remotes/origin/<base>"
git -C "<checkout>" rev-parse "refs/remotes/origin/<base>"
python3 <skill-dir>/scripts/prepare-worktree.py --repo-dir "<checkout>" --base "<base>" --worktree "<absolute-path>" --commit "<full-sha>"
```

An existing checkout may be assigned for planning or research records. Validate it in place.
Record whether each path was created or reused, including partially prepared environments on failure.
Preserve conflicts and report expected and observed state for resolution.

Completion requires a verified environment with absolute `working_directory` equal to `worktree`,
`repository`, `branch` (null for detached HEAD), `baseBranch`, and `commit`. Return creation ownership
and any fixed research entry or artifact locations supplied by the caller. Preparation in this agent
establishes the directory for subsequent assignment. Each consumer must bind its own execution to it.

## Cleanup

Accept only explicitly assigned candidates. Automatic cleanup applies to directories created for
completed work whose users have finished. Manual cleanup requires an explicit request for the path.

1. Validate repository, registered path, branch, and recorded final HEAD. Retain missing or
   conflicting environments with their observed state for resolution.
2. Check tracked and untracked changes, plus ignored files with `git status --short --ignored`.
   Identify research records, data, outputs, logs, and other material that must survive removal.
   Confirm their durable destinations and update evidence paths through the appropriate writer.
   Retain candidates containing unpreserved material or active users.
3. Confirm feature work is delivered using merge evidence for the exact final commit. Squash merges
   require the PR's merged state, delivered head, and merge commit rather than branch ancestry alone.
   Detached verification environments require completed verification evidence.
4. Run `git -C "<retained-checkout>" worktree remove "<candidate>"` from a surviving checkout.
   Preserve directories Git refuses to remove and report the reason. Keep branch refs unless their
   deletion was separately requested. Leave shared research homes, receipts, and external artifacts intact.

Return removed and retained paths with reasons. A retained directory is an explicit cleanup result.
