---
name: pc-agents-config
description: Initialize, audit, or update a managed project's AGENTS.md for paper-craft compatibility (deterministic CLI receipt exemption, compute policy pointer, research entry, and pre-merge checklist).
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# /pc-agents-config

Audit, initialize, or update a paper-craft-managed project's root `AGENTS.md` so project conventions align with `pc-orchestrator`, `pc-workspace`, `pc-issue-work`, `pc-pr-review`, `pc-compute-config`, and `pc-research-state` without introducing contradictions or context bloat.

## 1. Inspect baseline and project signals

Resolve the target repository root (`git rev-parse --show-toplevel`) and check whether it is the primary checkout or a linked worktree (`git worktree list --porcelain`).
Inspect existing guidance and project configuration on disk before proposing any edits:

- Root `AGENTS.md` (and `CLAUDE.md` if present, noting symlinks or mirrored rules).
- `.paper-craft/workspace-config.json` (`shared_paths`, `worktree_container`, `cleanable_ignored`, `protected_ignored`).
- `.paper-craft/compute.md` and `PRE-MERGE-CHECKLIST.md`, if present.
- `research-state/` (or a configured shared research home), `workflow/Snakefile`, `workflow/AGENTS.md`, `tests/AGENTS.md`.
- Project toolchain manifests (`pyproject.toml`, `package.json`, `.venv/`, `uv.lock`).

**Done:** Existing `AGENTS.md` contents (or absence) and all present project signals are established from disk.

## 2. Audit against the paper-craft contract

Evaluate every item below against the observed repository state and classify each as `present`, `missing`, `incomplete`, `conflicting`, or `not_applicable`:

1. **Deterministic CLI Receipt Exemption** *(Required when `AGENTS.md` sets a non-English language policy or formatting/rewriting rule for documentation or stage receipts)*
   - Ensure an explicit exemption states that deterministic CLI-generated mechanical receipts (such as `pc-workspace` `prepare` and `cleanup`) retain their native CLI output verbatim without manual translation or rewriting.
2. **Compute Execution Policy Pointer** *(Required when `.paper-craft/compute.md` exists; recommend `/pc-compute-config` if remote CPU/GPU execution is used without it)*
   - Include one canonical pointer covering all phases and subagents:
     `Before executing project commands in any phase (including check, review, and delegated work), read [.paper-craft/compute.md](.paper-craft/compute.md) and follow its execution boundary and selected platform skill's procedures.`
3. **Fixed Research Entry & `/pc-research-state` Routing** *(Required when `research-state/` or an external shared research home exists)*
   - Name the single fixed research entry path (e.g., `research-state/RESEARCH-STATE.local.md`) shared across checkouts, require reading it before interpreting/planning/updating findings, route updates through `/pc-research-state`, and note that research records alone do not authorize experiment execution.
4. **Pre-Merge / Pre-PR Quality Checklist** *(Required for `pc-issue-work` and `pc-pr-review`)*
   - Provide a `Pre-Merge Checklist` or `Pre-PR Quality Checklist` section in `AGENTS.md` (or pointer to `PRE-MERGE-CHECKLIST.md`) naming exact project-local check commands (lint, format, typecheck, workflow lint, tests) and respecting any remote execution boundary in `.paper-craft/compute.md`.
5. **Workspace, Environment, and Sub-directory Alignment**
   - Align documented environment paths (e.g., `.venv`, `uv`, `node_modules`) with `.paper-craft/workspace-config.json` (`shared_paths`).
   - When `workflow/Snakefile` exists, check that `workflow/AGENTS.md` and `tests/AGENTS.md` are present (flag missing files for follow-up or `/pc-pipeline-snakemake`).
   - **Conflict & Bloat Check:** Flag rules that conflict with paper-craft workflows—such as unscoped prohibitions against writing outside the project root (when worktrees and `.paper-craft/receipts/` live in `worktree_container`), or local test commands contradicting `.paper-craft/compute.md`. Keep rules lean: retain non-obvious conventions and pointers, and avoid duplicating config files or manifests verbatim.

**Done:** Every item has an evidence-backed status, and all missing rules, dangling pointers, and contradictions are identified.

## 3. Propose minimal changes and confirm

Present:
1. A concise audit summary table citing observed files and line numbers.
2. The exact proposed `AGENTS.md` diff (or full initial draft if `AGENTS.md` does not yet exist), written in the project's established language while preserving all unrelated domain rules.

If every applicable item is `present` with zero conflicts, report `AGENTS.md` as compliant and leave it untouched.
Otherwise, ask the user to approve the exact diff before modifying `AGENTS.md` (unless the user explicitly authorized direct updates in the current request).

**Done:** User approves the exact changes, or no changes are required.

## 4. Apply and verify

1. Re-read `AGENTS.md` immediately before writing; if it changed after the proposal, refresh the diff and re-confirm.
2. Apply surgical edits (`Edit` for existing files; `Write` only when creating a new `AGENTS.md`). Keep `CLAUDE.md` synchronized if the repository maintains one.
3. Re-read the saved `AGENTS.md` and verify:
   - Every relative link resolves to an existing file on disk.
   - All approved checklist items are present and free of contradictions.
   - Unrelated project conventions remain intact.

**Done:** Final `AGENTS.md` passes all verification checks and is reported with clickable file links and any out-of-scope setup follow-ups (e.g., `/pc-workspace-config`, `/pc-compute-config`).
