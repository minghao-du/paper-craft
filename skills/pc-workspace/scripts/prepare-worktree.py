#!/usr/bin/env python3
"""Prepare or validate a feature or detached worktree and print its environment as JSON."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", default=".", help="Existing checkout. Remote origin must identify the GitHub repository.")
    parser.add_argument("--issue", type=int, help="Positive issue number for default branch and path names.")
    revision = parser.add_mutually_exclusive_group()
    revision.add_argument("--branch", help="Feature branch. Defaults to issue-<number> when --issue is supplied.")
    revision.add_argument("--commit", help="Full integrated commit SHA for a detached worktree. Requires --worktree.")
    parser.add_argument("--base", help="Remote base branch. Defaults to the GitHub repository default branch.")
    parser.add_argument("--worktree", help="Explicit worktree path. Existing registered worktrees are validated and reused.")
    parser.add_argument("--expected-head", help="Required predecessor commit for rework. Requires an existing worktree.")
    args = parser.parse_args()
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
    try:
        print(json.dumps(prepare(args), indent=2))
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"Worktree preparation blocked. {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
