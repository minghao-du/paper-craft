"""Remove explicitly owned workspaces after delivery and consumer completion."""

import json
from pathlib import Path
import re


def cleanup(args, envelope, git, run):
    """Clean assigned candidates, retaining conflicts and reporting partial progress."""
    parameters = envelope.get("inputs", {}).get("parameters", {})
    candidates = parameters.get("candidates")
    if not isinstance(candidates, list):
        raise ValueError("Cleanup requires inputs.parameters.candidates as an explicit list.")
    if any(not isinstance(candidate, dict) for candidate in candidates):
        raise ValueError("Each cleanup candidate must be an object.")
    source = Path(git(args.repo_dir, "rev-parse", "--show-toplevel")).resolve()
    result = dict(removed_paths=[], retained_paths=[], removed_branches=[], retained_branches=[])
    receipt = Path(args.receipt_path).resolve() if args.receipt_path else None
    common = git(source, "rev-parse", "--path-format=absolute", "--git-common-dir")
    for candidate in candidates:
        path = candidate.get("worktree", "")
        branch = candidate.get("branch")
        try:
            target = Path(path).expanduser().resolve()
            if not path or not Path(path).is_absolute():
                raise ValueError("Candidate requires an absolute worktree path.")
            if candidate.get("created") is not True or candidate.get("consumers_finished") is not True:
                raise ValueError("Creation ownership and completed consumers must be confirmed.")
            if target == source or target in source.parents:
                raise ValueError("Candidate contains the retained checkout.")
            if receipt and (receipt == target or target in receipt.parents):
                raise ValueError("Cleanup receipt must be outside the candidate.")
            commit = candidate.get("commit", "")
            if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", commit):
                raise ValueError("Candidate requires its recorded final full commit SHA.")
            registrations = git(source, "worktree", "list", "--porcelain", "-z")
            records = [dict((field.partition(" ")[0], field.partition(" ")[2]) for field in record.split("\0") if field)
                       for record in registrations.split("\0\0")]
            entries = [entry for entry in records if entry.get("worktree") == str(target)]
            if records[0].get("worktree") == str(target):
                raise ValueError("Primary checkout must be retained.")
            if entries:
                entry = entries[0]
                if "locked" in entry:
                    raise ValueError("Worktree is locked by an active owner.")
                if entry.get("HEAD") != commit or entry.get("branch") != (f"refs/heads/{branch}" if branch else None):
                    raise ValueError("Registered branch or HEAD changed since delivery.")
                if not target.is_dir():
                    raise ValueError("Registered worktree is missing.")
                if git(target, "rev-parse", "--path-format=absolute", "--git-common-dir") != common:
                    raise ValueError("Candidate belongs to a different repository.")
                if git(target, "status", "--porcelain", "--untracked-files=all", "--ignored"):
                    raise ValueError("Candidate contains tracked, untracked, or ignored material.")
            elif target.exists():
                raise ValueError("Candidate directory is unregistered.")

            if branch:
                git(source, "check-ref-format", f"refs/heads/{branch}")
                base = candidate["baseBranch"]
                git(source, "check-ref-format", f"refs/heads/{base}")
                if branch == base:
                    raise ValueError("Base branch must be retained.")
                ref = f"refs/heads/{branch}"
                local_refs = git(source, "for-each-ref", "--format=%(refname) %(objectname)", ref)
                local = dict(line.split(" ", 1) for line in local_refs.splitlines()).get(ref, "")
                if local and local != commit:
                    raise ValueError("Local branch has changed since delivery.")
                if any(entry.get("branch") == ref and entry.get("worktree") != str(target) for entry in records):
                    raise ValueError("Branch is checked out in another worktree.")
                repository = candidate["delivery_target"]
                pr = json.loads(run("gh", "pr", "view", str(candidate["pr"]), "--repo", repository,
                                    "--json", "state,headRefName,headRefOid,baseRefName,mergeCommit,headRepository,headRepositoryOwner", cwd=source))
                if (pr.get("state") != "MERGED" or pr.get("headRefName") != branch
                        or pr.get("headRefOid") != commit or pr.get("baseRefName") != base):
                    raise ValueError("PR merge evidence does not match the delivered branch, base, and HEAD.")
                merged = (pr.get("mergeCommit") or {}).get("oid", "")
                if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", merged):
                    raise ValueError("PR merge commit is missing.")
                base_remote = candidate["base_remote"]
                base_url = git(source, "remote", "get-url", base_remote)
                base_repo = json.loads(run("gh", "repo", "view", base_url, "--json", "nameWithOwner", cwd=source))
                if base_repo.get("nameWithOwner", "").lower() != repository.lower():
                    raise ValueError("Base remote differs from the delivery repository.")
                git(source, "fetch", base_remote, f"+refs/heads/{base}:refs/remotes/{base_remote}/{base}")
                git(source, "merge-base", "--is-ancestor", merged, f"refs/remotes/{base_remote}/{base}")
                remote = candidate["push_remote"]
                remote_url = git(source, "remote", "get-url", remote)
                remote_repo = json.loads(run("gh", "repo", "view", remote_url, "--json", "nameWithOwner", cwd=source))
                head_repo = pr.get("headRepository") or {}
                head_owner = pr.get("headRepositoryOwner") or {}
                expected_repo = f"{head_owner.get('login', '')}/{head_repo.get('name', '')}"
                if remote_repo.get("nameWithOwner", "").lower() != expected_repo.lower():
                    raise ValueError("Push remote differs from the PR head repository.")
                remote_head = git(source, "ls-remote", "--refs", remote, ref)
                if remote_head:
                    if remote_head.split()[0] != commit:
                        raise ValueError("Remote branch has changed since delivery.")
                    git(source, "push", f"--force-with-lease={ref}:{commit}", remote, f":{ref}")
                result["removed_branches"].append(dict(branch=branch, remote=remote, scope="remote", already_absent=not bool(remote_head)))
            elif candidate.get("verification_completed") is not True:
                raise ValueError("Detached worktree requires completed verification evidence.")

            if entries:
                if git(target, "rev-parse", "HEAD") != commit or git(target, "status", "--porcelain", "--untracked-files=all", "--ignored"):
                    raise ValueError("Worktree changed during cleanup.")
                git(source, "worktree", "remove", str(target))
            result["removed_paths"].append(str(target))
            if branch:
                # Compare-and-delete also handles squash merges without ancestry heuristics.
                registrations = git(source, "worktree", "list", "--porcelain", "-z")
                if f"branch {ref}\0" in registrations:
                    raise ValueError("Branch is still checked out in a worktree.")
                if local:
                    git(source, "update-ref", "-d", ref, commit)
                config = git(source, "config", "--local", "--list")
                if any(line.startswith(f"branch.{branch}.") for line in config.splitlines()):
                    git(source, "config", "--local", "--remove-section", f"branch.{branch}")
                result["removed_branches"].append(dict(branch=branch, scope="local"))
        except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
            reason = str(error)
            if str(path) not in result["removed_paths"]:
                result["retained_paths"].append(dict(path=path, reason=reason))
            if branch:
                result["retained_branches"].append(dict(branch=branch, reason=reason))
    return result
