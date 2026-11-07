#!/usr/bin/env python3
"""Prepare or validate a feature or detached worktree and print its environment as JSON."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Dict, Optional


def run(*args, cwd):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or str(args))
    return result.stdout.strip()


def git(directory, *args):
    return run("git", *args, cwd=directory)


def require_clean(directory):
    if git(directory, "status", "--porcelain", "--untracked-files=all"):
        raise RuntimeError(f"Uncommitted changes in {directory}. Preserve them and resolve before retrying.")


def atomic_write_text(file_path: Path, content: str) -> None:
    """Write text file atomically with flush and fsync."""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp_file = file_path.with_suffix(f".tmp.{os.getpid()}")
    try:
        with open(temp_file, "w", encoding="utf-8") as f:
            f.write(content)
            if not content.endswith("\n"):
                f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_file, file_path)
    finally:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except OSError:
                pass


def build_markdown_receipt(
    *,
    status: str,
    compact_report: Dict[str, Any],
    artifacts: Dict[str, Any],
    created: bool,
    args: argparse.Namespace,
    envelope_data: Optional[Dict[str, Any]] = None,
    summary: str = "",
    error_msg: Optional[str] = None,
) -> str:
    """Generate Markdown receipt strictly matching subagent-receipt.template.md."""
    env = envelope_data or {}
    task = env.get("task", {}) if isinstance(env, dict) else {}
    inputs = env.get("inputs", {}) if isinstance(env, dict) else {}
    budgets = env.get("budgets", {}) if isinstance(env, dict) else {}

    receipt_path = compact_report.get("receipt_path") or ""
    dispatch_id = Path(receipt_path).stem if receipt_path else "workspace_prepare"

    predecessors = inputs.get("predecessor_receipts", []) if isinstance(inputs, dict) else []
    if predecessors and len(predecessors) > 0:
        orig_dispatch_id = Path(predecessors[-1]).stem
    else:
        orig_dispatch_id = "N/A"

    root_issue = str(task.get("root_issue_id") or getattr(args, "issue", "") or "N/A")
    current_issue = str(task.get("current_issue_id") or getattr(args, "issue", "") or "N/A")
    logical_stage = task.get("logical_stage") or "workspace_prepare"
    attempt = task.get("attempt", 1)
    del_used = budgets.get("delivery_attempts_used", 0)
    rep_used = budgets.get("replans_used", 0)

    json_block = json.dumps(compact_report, indent=2, ensure_ascii=False)

    workdir = artifacts.get("working_directory", "N/A")
    repo = artifacts.get("repository", "N/A")
    worktree = artifacts.get("worktree", "N/A")
    base_b = artifacts.get("baseBranch", "N/A")
    branch = artifacts.get("branch")
    branch_str = "null" if branch is None else str(branch)
    commit = artifacts.get("commit", "N/A")
    env_receipt = artifacts.get("environment_receipt", receipt_path or "N/A")

    if status == "succeeded":
        verification_text = f"""- Git repository root: {getattr(args, 'repo_dir', '.')}
- Target worktree directory: {worktree}
- Cleanliness verified: Source repository and target worktree verified clean (no uncommitted or untracked files).
- Branch and revision: Pinned to commit {commit} (branch: {branch_str if branch else 'detached HEAD'}).
- Worktree ownership: {'created fresh feature worktree' if created else 'reused existing registered worktree'}."""

        task_result_text = f"""Successfully {'created' if created else 'validated and reused'} Git execution environment at `{worktree}`.
- Repository: `{repo}`
- Worktree path: `{worktree}`
- Base branch: `{base_b}`
- Branch: `{branch_str}`
- Commit SHA: `{commit}`"""

        feedback_text = f"""Workspace is clean and ready for domain task execution.
Subsequent stage tasks must bind execution to `{worktree}` and adhere to the environment contract."""

        recovery_text = f"""- Dispatch ID: {dispatch_id}
- Origin stage: {logical_stage}
- Attempt: {attempt}
- Delivery attempts used: {del_used}
- Replans used: {rep_used}
- Recovery note: For rework, supply --expected-head {commit if commit != 'N/A' else '<commit>'} to require this exact environment."""
    else:
        err = error_msg or summary
        verification_text = f"""Workspace preparation blocked: {err}"""
        task_result_text = f"""Workspace preparation blocked: {err}"""
        feedback_text = f"""Preparation halted: {err}
Remediation required before retrying workspace preparation."""
        recovery_text = f"""- Dispatch ID: {dispatch_id}
- Origin stage: {logical_stage}
- Attempt: {attempt}
- Delivery attempts used: {del_used}
- Replans used: {rep_used}
- Recovery note: Resolve reported blocker before retrying workspace preparation."""

    return f"""# Subagent Receipt

- root_issue_id: {root_issue}
- current_issue_id: {current_issue}
- task_type: {logical_stage}
- dispatch_id: {dispatch_id}
- original_dispatch_id: {orig_dispatch_id}
- origin_stage: {logical_stage}
- attempt: {attempt}
- delivery_attempts_used: {del_used}
- replans_used: {rep_used}
- execution_status: {status}

## Compact Report

```json
{json_block}
```

## Artifacts

- working_directory: {workdir}
- repository: {repo}
- worktree: {worktree}
- baseBranch: {base_b}
- branch: {branch_str}
- commit: {commit}
- environment_receipt: {env_receipt}
- research_entry: N/A
- artifact_locations: N/A
- pr: N/A

## Verification

{verification_text}

## Task Result

{task_result_text}

## Current State and Feedback

{feedback_text}

## Recovery and Budgets

{recovery_text}
"""


def prepare(args):
    source = Path(git(args.repo_dir, "rev-parse", "--show-toplevel")).resolve()
    records = git(source, "worktree", "list", "--porcelain", "-z").split("\0\0")
    worktrees = []
    for record in records:
        fields = dict(field.split(" ", 1) for field in record.split("\0") if " " in field)
        if "worktree" in fields:
            worktrees.append(fields)
    primary = Path(worktrees[0]["worktree"]).resolve()
    remote_url = git(source, "remote", "get-url", "origin")
    metadata = json.loads(run(
        "gh", "repo", "view", remote_url, "--json",
        "nameWithOwner,defaultBranchRef", cwd=source
    ))
    if not metadata.get("defaultBranchRef"):
        raise RuntimeError("The GitHub repository needs a default branch with an initial commit.")

    expected_repo = getattr(args, "expected_repository", None)
    if expected_repo and expected_repo != "local/repo" and expected_repo != metadata.get("nameWithOwner"):
        raise RuntimeError(
            f"Expected repository {expected_repo}, observed {metadata.get('nameWithOwner')}."
        )

    default_base = metadata["defaultBranchRef"]["name"]
    base = args.base or default_base
    branch = None if args.commit else args.branch or f"issue-{args.issue}"
    if branch:
        git(source, "check-ref-format", "--branch", branch)
    git(source, "check-ref-format", f"refs/heads/{base}")
    if branch in (base, default_base):
        raise RuntimeError(f"Expected an issue branch, received protected base branch {branch}.")

    if args.commit:
        matches = [entry for entry in worktrees
                   if Path(entry["worktree"]).resolve() == Path(args.worktree).expanduser().resolve()]
    else:
        matches = [entry for entry in worktrees if entry.get("branch") == f"refs/heads/{branch}"]
    if len(matches) > 1:
        raise RuntimeError(f"Branch {branch} is registered in multiple worktrees. Resolve the ambiguity first.")
    if args.worktree:
        target = Path(args.worktree).expanduser().resolve()
    elif matches:
        target = Path(matches[0]["worktree"]).resolve()
    else:
        target = primary.parent / f"{primary.name}-worktrees" / f"issue-{args.issue}"
    if target == primary or primary in target.parents:
        raise RuntimeError(f"Expected a separate worktree outside the primary checkout {primary}.")
    if source in target.parents or (target == source and not matches):
        raise RuntimeError(f"Expected a separate worktree outside the source checkout {source}.")

    require_clean(source)
    if matches:
        git(source, "ls-remote", "--exit-code", "--heads", "origin", f"refs/heads/{base}")
        existing = Path(matches[0]["worktree"]).resolve()
        if existing != target:
            raise RuntimeError(f"Branch {branch} is already checked out at {existing}.")
        if not target.is_dir():
            raise RuntimeError(f"Registered worktree is missing at {target}. Restore it before retrying.")
    else:
        if args.expected_head:
            raise RuntimeError("The predecessor worktree is missing. Restore it before continuing rework.")
        if target.exists():
            raise RuntimeError(f"Target path is occupied by an unregistered worktree or directory at {target}.")
        if branch:
            local_branch = subprocess.run(
                ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=source
            )
            if local_branch.returncode == 0:
                raise RuntimeError(f"Branch {branch} exists without a worktree. Supply explicit recovery instructions.")
            if local_branch.returncode != 1:
                raise RuntimeError(f"Could not inspect local branch {branch}.")
        git(source, "fetch", "origin", f"+refs/heads/{base}:refs/remotes/origin/{base}")
        start = f"refs/remotes/origin/{base}"
        if args.commit:
            start = git(source, "rev-parse", "--verify", f"{args.commit}^{{commit}}")
            git(source, "merge-base", "--is-ancestor", start, f"refs/remotes/origin/{base}")
        target.parent.mkdir(parents=True, exist_ok=True)
        if branch:
            git(source, "worktree", "add", "--no-track", "-b", branch, str(target), start)
        else:
            git(source, "worktree", "add", "--detach", str(target), start)

    common = git(source, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if git(target, "rev-parse", "--path-format=absolute", "--git-common-dir") != common:
        raise RuntimeError(f"Worktree {target} belongs to another repository.")
    if git(target, "branch", "--show-current") != (branch or ""):
        raise RuntimeError(f"Worktree {target} is on an unexpected branch.")
    require_clean(target)
    commit = git(target, "rev-parse", "HEAD")
    if args.commit and git(target, "rev-parse", "--verify", f"{args.commit}^{{commit}}") != commit:
        raise RuntimeError(f"Expected integrated HEAD {args.commit}, found {commit}.")
    if args.expected_head and git(target, "rev-parse", f"{args.expected_head}^{{commit}}") != commit:
        raise RuntimeError(f"Expected predecessor HEAD {args.expected_head}, found {commit}.")
    return dict(repository=metadata["nameWithOwner"], working_directory=str(target),
                worktree=str(target), branch=branch, baseBranch=base, commit=commit,
                created=not bool(matches))


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", help="Existing checkout. Remote origin must identify the GitHub repository.")
    parser.add_argument("--issue", type=int, help="Positive issue number for default branch and path names.")
    revision = parser.add_mutually_exclusive_group()
    revision.add_argument("--branch", help="Feature branch. Defaults to issue-<number> when --issue is supplied.")
    revision.add_argument("--commit", help="Full integrated commit SHA for a detached worktree. Requires --worktree.")
    parser.add_argument("--base", help="Remote base branch. Defaults to the GitHub repository default branch.")
    parser.add_argument("--worktree", help="Explicit worktree path. Existing registered worktrees are validated and reused.")
    parser.add_argument("--expected-head", help="Required predecessor commit for rework. Requires an existing worktree.")
    parser.add_argument("--input-envelope", "--input", dest="input_envelope", help="Path to Task Input Envelope JSON file (<step>-input.json)")
    parser.add_argument("--receipt-path", help="Path to write Markdown receipt.")
    parser.add_argument("--output-format", choices=["raw", "compact"], default=None, help="Output format for stdout: raw environment dict or compact report JSON")
    return parser.parse_args(argv), parser


def main():
    args, parser = parse_args()

    envelope_data = None
    if args.input_envelope:
        env_path = Path(args.input_envelope).resolve()
        if not env_path.exists():
            print(f"Worktree preparation blocked. Input envelope not found: {env_path}", file=sys.stderr)
            return 1
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                envelope_data = json.load(f)
        except Exception as e:
            print(f"Worktree preparation blocked. Malformed envelope JSON at {env_path}: {e}", file=sys.stderr)
            return 1

        env_section = envelope_data.get("environment", {}) if isinstance(envelope_data, dict) else {}
        task_section = envelope_data.get("task", {}) if isinstance(envelope_data, dict) else {}
        inputs_section = envelope_data.get("inputs", {}) if isinstance(envelope_data, dict) else {}
        params_section = inputs_section.get("parameters", {}) if isinstance(inputs_section, dict) else {}
        contract_section = envelope_data.get("contract", {}) if isinstance(envelope_data, dict) else {}

        # 1. Issue extraction
        if args.issue is None:
            raw_issue = task_section.get("current_issue_id") or task_section.get("root_issue_id")
            if raw_issue is not None:
                if isinstance(raw_issue, int):
                    args.issue = raw_issue
                elif isinstance(raw_issue, str):
                    cleaned = raw_issue.strip().lstrip("#")
                    if cleaned.startswith("issue-"):
                        cleaned = cleaned[len("issue-"):]
                    if cleaned.isdigit():
                        args.issue = int(cleaned)

        # 2. Base branch
        if args.base is None and env_section.get("base_branch"):
            args.base = env_section["base_branch"]

        # 3. Parameters: worktree and expected_head
        if args.worktree is None and params_section.get("worktree"):
            args.worktree = params_section["worktree"]
        if args.expected_head is None and params_section.get("expected_head"):
            args.expected_head = params_section["expected_head"]

        # 4. Branch & Commit
        env_branch = env_section.get("branch")
        env_commit = env_section.get("commit")
        if args.branch is None and args.commit is None:
            if env_branch:
                args.branch = env_branch
                if env_commit and not args.expected_head:
                    args.expected_head = env_commit
            elif env_commit:
                args.commit = env_commit

        # 5. Repository verification attribute
        if env_section.get("repository"):
            args.expected_repository = env_section["repository"]

        # 6. Working directory & Worktree resolution
        env_workdir = env_section.get("working_directory")
        if env_workdir:
            p = Path(env_workdir).expanduser().resolve()
            if args.worktree is not None:
                if args.repo_dir is None:
                    args.repo_dir = str(p)
            else:
                is_git = False
                if p.exists():
                    try:
                        res = subprocess.run(
                            ["git", "rev-parse", "--show-toplevel"],
                            cwd=p,
                            capture_output=True,
                            text=True,
                        )
                        if res.returncode == 0:
                            is_git = True
                    except Exception:
                        pass
                if not is_git:
                    args.worktree = str(p)
                else:
                    if args.repo_dir is None:
                        args.repo_dir = str(p)

        # 7. Receipt path
        if args.receipt_path is None and contract_section.get("receipt_path"):
            args.receipt_path = contract_section["receipt_path"]

    # Default repo-dir to "." if still unset
    if args.repo_dir is None:
        args.repo_dir = "."

    # Default output format
    if args.output_format is None:
        args.output_format = "compact" if (args.input_envelope or args.receipt_path) else "raw"

    # Validation checks
    if args.issue is not None and args.issue <= 0:
        parser.error("--issue must be positive")
    if args.commit and (
        len(args.commit) not in (40, 64)
        or any(c not in "0123456789abcdefABCDEF" for c in args.commit)
    ):
        parser.error("--commit must be a full commit SHA")
    if not args.issue and not (args.worktree and (args.branch or args.commit)):
        parser.error("supply --issue, or --worktree with --branch or --commit")
    if args.commit and not args.worktree:
        parser.error("--commit requires --worktree")

    receipt_file = Path(args.receipt_path).resolve() if getattr(args, "receipt_path", None) else None

    try:
        env_result = prepare(args)
        status = "succeeded"
        target_path = env_result.get("working_directory", "N/A")
        branch = env_result.get("branch")
        commit = env_result.get("commit", "N/A")
        created = env_result.get("created", False)

        task_section = envelope_data.get("task", {}) if isinstance(envelope_data, dict) else {}
        current_issue_id = str(task_section.get("current_issue_id") or getattr(args, "issue", "") or "N/A")

        if created:
            if current_issue_id != "N/A":
                summary = f"Prepared feature worktree for issue {current_issue_id} at {target_path}"
            elif branch:
                summary = f"Prepared feature worktree on branch '{branch}' at {target_path}"
            else:
                summary = f"Prepared detached worktree at {target_path} pinned to commit {commit}"
        else:
            summary = f"Reused existing worktree at {target_path} with commit {commit}"

        compact_report = {
            "execution_status": status,
            "result": env_result,
            "receipt_path": str(receipt_file) if receipt_file else "",
            "summary": summary,
        }

        if receipt_file:
            receipt_content = build_markdown_receipt(
                status=status,
                compact_report=compact_report,
                artifacts=dict(
                    working_directory=target_path,
                    repository=env_result.get("repository", "N/A"),
                    worktree=env_result.get("worktree", target_path),
                    baseBranch=env_result.get("baseBranch", "N/A"),
                    branch=branch,
                    commit=commit,
                    environment_receipt=str(receipt_file),
                ),
                created=created,
                args=args,
                envelope_data=envelope_data,
                summary=summary,
            )
            atomic_write_text(receipt_file, receipt_content)

        if args.output_format == "compact":
            print(json.dumps(compact_report, indent=2, ensure_ascii=False))
        else:
            print(json.dumps(env_result, indent=2, ensure_ascii=False))
        return 0

    except (RuntimeError, OSError, ValueError, KeyError) as error:
        err_msg = str(error)
        print(f"Worktree preparation blocked. {err_msg}", file=sys.stderr)

        err_result = {
            "error": err_msg,
            "stage": "workspace_prepare",
        }
        compact_report = {
            "execution_status": "blocked",
            "result": err_result,
            "receipt_path": str(receipt_file) if receipt_file else "",
            "summary": f"Worktree preparation blocked: {err_msg}",
        }

        if receipt_file:
            try:
                receipt_content = build_markdown_receipt(
                    status="blocked",
                    compact_report=compact_report,
                    artifacts=dict(
                        working_directory=str(getattr(args, "worktree", "N/A")),
                        repository=getattr(args, "expected_repository", "N/A"),
                        worktree=str(getattr(args, "worktree", "N/A")),
                        baseBranch=getattr(args, "base", "N/A"),
                        branch=getattr(args, "branch", None),
                        commit=getattr(args, "commit", "N/A"),
                        environment_receipt=str(receipt_file),
                    ),
                    created=False,
                    args=args,
                    envelope_data=envelope_data,
                    summary=f"Worktree preparation blocked: {err_msg}",
                    error_msg=err_msg,
                )
                atomic_write_text(receipt_file, receipt_content)
            except Exception:
                pass

        if args.output_format == "compact":
            print(json.dumps(compact_report, indent=2, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
