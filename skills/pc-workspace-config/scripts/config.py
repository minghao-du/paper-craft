#!/usr/bin/env python3
"""Project workspace configuration manager for paper-craft (pc-workspace-config).

Probes Git repositories, initializes, inspects, and validates local workspace
configuration (.paper-craft/workspace-config.json).
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

SCHEMA_VERSION = "1.0"
CONFIG_REL_PATH = Path(".paper-craft") / "workspace-config.json"
DEFAULT_WORKTREE_CONTAINER = "../project-worktrees"
DEFAULT_WORKFLOW = "default"
DEFAULT_DELIVERY_ATTEMPTS_MAX = 3
DEFAULT_REPLANS_MAX = 2


def atomic_write_json(file_path: Path, data: Dict[str, Any]) -> None:
    """Write dictionary to file atomically with flush and fsync."""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp_file = file_path.with_suffix(f".tmp.{os.getpid()}")
    try:
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
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


def run_git(directory: Path, *args: str) -> Tuple[int, str, str]:
    """Execute git command and return (returncode, stdout, stderr)."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=directory,
            capture_output=True,
            text=True,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def find_repo_root(directory: Path) -> Path:
    """Find git repository root, falling back to directory."""
    code, stdout, _ = run_git(directory, "rev-parse", "--show-toplevel")
    if code == 0 and stdout:
        return Path(stdout).resolve()
    return directory.resolve()


def get_config_file_path(repo_root: Path) -> Path:
    """Get path to canonical workspace configuration file."""
    return repo_root / CONFIG_REL_PATH


def parse_repo_from_url(url: str) -> Optional[str]:
    """Parse 'owner/repo' identifier from Git remote URL."""
    if not url:
        return None

    # Handle SSH url: git@github.com:owner/repo.git or ssh://git@github.com/owner/repo.git
    m = re.search(r"[:/]([a-zA-Z0-9_\-\.]+)/([a-zA-Z0-9_\-\.]+?)(?:\.git)?$", url)
    if m:
        owner = m.group(1)
        repo = m.group(2)
        # Avoid matching 'git' as owner in ssh://git@host/...
        if owner == "git" and "/" in url:
            parts = url.rstrip("/").split("/")
            if len(parts) >= 2:
                repo_part = parts[-1]
                if repo_part.endswith(".git"):
                    repo_part = repo_part[:-4]
                return f"{parts[-2]}/{repo_part}"
        return f"{owner}/{repo}"

    # Handle file path: /path/to/owner/repo.git
    path_obj = Path(url)
    stem = path_obj.stem
    parent_name = path_obj.parent.name
    if stem and parent_name:
        return f"{parent_name}/{stem}"
    return None


def probe_git_remotes(repo_root: Path) -> List[str]:
    """List configured git remotes."""
    code, stdout, _ = run_git(repo_root, "remote")
    if code == 0 and stdout:
        return [r.strip() for r in stdout.splitlines() if r.strip()]
    return []


def probe_default_branch(repo_root: Path, remote: str = "origin") -> Optional[str]:
    """Probe default branch from remote symbolic ref or branch list.

    Returns None if undetectable, avoiding fallback guessing.
    """
    # 1. Try git symbolic-ref refs/remotes/<remote>/HEAD
    code, stdout, _ = run_git(repo_root, "symbolic-ref", f"refs/remotes/{remote}/HEAD")
    if code == 0 and stdout:
        # e.g. refs/remotes/origin/main
        return stdout.split("/")[-1]

    # 2. Try gh repo view if available
    try:
        code_url, remote_url, _ = run_git(repo_root, "remote", "get-url", remote)
        if code_url == 0 and remote_url:
            proc = subprocess.run(
                ["gh", "repo", "view", remote_url, "--json", "defaultBranchRef"],
                cwd=repo_root,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if proc.returncode == 0:
                meta = json.loads(proc.stdout)
                branch = meta.get("defaultBranchRef", {}).get("name")
                if branch:
                    return str(branch)
    except Exception:
        pass

    # 3. Try current HEAD branch if attached
    code, stdout, _ = run_git(repo_root, "rev-parse", "--abbrev-ref", "HEAD")
    if code == 0 and stdout and stdout != "HEAD":
        return stdout

    # 4. Try local branch names if unambiguous
    code, stdout, _ = run_git(repo_root, "branch", "--format=%(refname:short)")
    if code == 0 and stdout:
        branches = [b.strip() for b in stdout.splitlines() if b.strip()]
        if len(branches) == 1:
            return branches[0]
        if "main" in branches and "master" not in branches:
            return "main"
        if "master" in branches and "main" not in branches:
            return "master"

    return None


def load_workspace_config(repo_root: Path) -> Optional[Dict[str, Any]]:
    """Load and parse workspace configuration JSON if present."""
    config_path = get_config_file_path(repo_root)
    if not config_path.exists():
        return None
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise ValueError(
            f"Malformed JSON in workspace configuration at {config_path}: {e}. "
            "Please run 'pc-workspace-config' to reconfigure."
        ) from e
    if not isinstance(data, dict):
        raise ValueError(
            f"Workspace configuration at {config_path} must be a JSON object. "
            "Please run 'pc-workspace-config' to reconfigure."
        )
    return data


def validate_workspace_config(
    data: Any,
    repo_root: Optional[Path] = None,
) -> List[str]:
    """Validate workspace configuration structure and repository semantics."""
    errors: List[str] = []
    if not isinstance(data, dict):
        return ["Workspace configuration must be a JSON object"]

    # 1. schema_version
    ver = data.get("schema_version")
    if ver != SCHEMA_VERSION:
        errors.append(f"Invalid schema_version '{ver}'. Expected '{SCHEMA_VERSION}'")

    # 2. Required fields
    required_fields = [
        ("delivery_target", "Target repository (e.g. 'owner/repo')"),
        ("base_remote", "Mainline base git remote (e.g. 'origin')"),
        ("push_remote", "Feature push git remote (e.g. 'origin')"),
        ("base_branch", "Mainline base branch (e.g. 'main')"),
        ("worktree_container", "Worktree container directory (e.g. '../project-worktrees')"),
    ]

    for key, desc in required_fields:
        val = data.get(key)
        if not val or not isinstance(val, str) or not val.strip():
            errors.append(f"Missing or empty required field '{key}' ({desc})")

    # 3. Project settings validation (optional in raw config, validated if present)
    if "workflow" in data:
        wf = data.get("workflow")
        if not isinstance(wf, str) or not wf.strip():
            errors.append("Field 'workflow' must be a non-empty string")
    if "default_workflow" in data:
        dwf = data.get("default_workflow")
        if not isinstance(dwf, str) or not dwf.strip():
            errors.append("Field 'default_workflow' must be a non-empty string")
    if "delivery_attempts_max" in data:
        delivery_attempts_max = data.get("delivery_attempts_max")
        if not isinstance(delivery_attempts_max, int) or isinstance(delivery_attempts_max, bool) or delivery_attempts_max < 0:
            errors.append("Field 'delivery_attempts_max' must be an integer >= 0")
    if "replans_max" in data:
        replans_max = data.get("replans_max")
        if not isinstance(replans_max, int) or isinstance(replans_max, bool) or replans_max < 0:
            errors.append("Field 'replans_max' must be an integer >= 0")

    # 4. Check git remotes if repo_root provided and valid git repo
    if repo_root and repo_root.exists():
        remotes = probe_git_remotes(repo_root)
        if remotes:
            base_remote = data.get("base_remote")
            if base_remote and base_remote not in remotes:
                errors.append(f"Configured base_remote '{base_remote}' does not exist in git remotes: {remotes}")
            push_remote = data.get("push_remote")
            if push_remote and push_remote not in remotes:
                errors.append(f"Configured push_remote '{push_remote}' does not exist in git remotes: {remotes}")

    return errors


def resolve_workspace_config(
    repo_dir: Path | str,
    overrides: Optional[Dict[str, Any]] = None,
    require_file: bool = False,
) -> Dict[str, Any]:
    """Parse, detect, and validate repository configuration, merging optional overrides.

    This function is the single source of truth for resolving repository configuration.
    Explicit overrides take precedence over project configuration. Missing or unconfirmed
    facts fail immediately without guessing fallback defaults like 'main' or 'local/repo'.

    Args:
        repo_dir: Path to the repository or worktree.
        overrides: Optional explicit parameter overrides (e.g. from CLI arguments).
        require_file: If True, requires .paper-craft/workspace-config.json to exist.

    Returns:
        Fully resolved configuration snapshot dictionary.

    Raises:
        ValueError: If configuration is missing, invalid, or facts cannot be confirmed.
    """
    repo_root = find_repo_root(Path(repo_dir))
    repo_checkout = str(repo_root.resolve())
    config_path = get_config_file_path(repo_root)
    file_exists = config_path.exists()

    if not file_exists and require_file:
        raise ValueError(
            f"Workspace configuration missing at {config_path}. "
            "Please run 'pc-workspace-config' to initialize."
        )

    config_data: Dict[str, Any] = {}
    if file_exists:
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config_data = json.load(f)
        except Exception as e:
            raise ValueError(
                f"Malformed JSON in workspace configuration at {config_path}: {e}. "
                "Please run 'pc-workspace-config' to reconfigure."
            ) from e
        if not isinstance(config_data, dict):
            raise ValueError(
                f"Workspace configuration at {config_path} must be a JSON object. "
                "Please run 'pc-workspace-config' to reconfigure."
            )
        errors = validate_workspace_config(config_data, repo_root)
        if errors:
            raise ValueError(
                f"Workspace configuration at {config_path} is invalid:\n  - "
                + "\n  - ".join(errors)
                + "\nPlease run 'pc-workspace-config' to reconfigure."
            )

    overrides = overrides or {}

    # 1. Base Remote
    explicit_base_remote = overrides.get("base_remote")
    if explicit_base_remote:
        base_remote = str(explicit_base_remote).strip()
    elif config_data.get("base_remote"):
        base_remote = str(config_data["base_remote"]).strip()
    else:
        remotes = probe_git_remotes(repo_root)
        if "upstream" in remotes:
            base_remote = "upstream"
        elif "origin" in remotes:
            base_remote = "origin"
        elif len(remotes) == 1:
            base_remote = remotes[0]
        else:
            raise ValueError(
                "Cannot determine base_remote: configuration missing or undetectable from repository remotes. "
                "Do not guess fallback defaults. Please run 'pc-workspace-config' or specify --base-remote explicitly."
            )

    # 2. Push Remote
    explicit_push_remote = overrides.get("push_remote")
    if explicit_push_remote:
        push_remote = str(explicit_push_remote).strip()
    elif config_data.get("push_remote"):
        push_remote = str(config_data["push_remote"]).strip()
    else:
        remotes = probe_git_remotes(repo_root)
        if "upstream" in remotes and "origin" in remotes:
            push_remote = "origin"
        else:
            push_remote = base_remote

    # 3. Delivery Target
    explicit_target = overrides.get("delivery_target")
    if explicit_target:
        delivery_target = str(explicit_target).strip()
    elif config_data.get("delivery_target"):
        delivery_target = str(config_data["delivery_target"]).strip()
    else:
        probed_target = None
        code, remote_url, _ = run_git(repo_root, "remote", "get-url", base_remote)
        if code == 0 and remote_url:
            probed_target = parse_repo_from_url(remote_url)
        if not probed_target and "origin" in probe_git_remotes(repo_root) and base_remote != "origin":
            code, remote_url, _ = run_git(repo_root, "remote", "get-url", "origin")
            if code == 0 and remote_url:
                probed_target = parse_repo_from_url(remote_url)
        if probed_target:
            delivery_target = probed_target
        else:
            raise ValueError(
                f"Cannot determine delivery_target: configuration missing or undetectable from remote '{base_remote}'. "
                "Do not guess fallback defaults like 'local/repo'. Please run 'pc-workspace-config' or specify --delivery-target explicitly."
            )

    # 4. Base Branch
    explicit_branch = overrides.get("base_branch")
    if explicit_branch:
        base_branch = str(explicit_branch).strip()
    elif config_data.get("base_branch"):
        base_branch = str(config_data["base_branch"]).strip()
    else:
        probed_b = probe_default_branch(repo_root, base_remote)
        if probed_b:
            base_branch = probed_b
        else:
            raise ValueError(
                f"Cannot determine base_branch from remote '{base_remote}'. "
                "Do not guess fallback defaults like 'main'. Please run 'pc-workspace-config' or specify --base-branch explicitly."
            )

    # 5. Worktree Container
    explicit_wc = overrides.get("worktree_container")
    worktree_container = str(explicit_wc).strip() if explicit_wc else (
        config_data.get("worktree_container") or DEFAULT_WORKTREE_CONTAINER
    )

    # 6. Project settings: workflow, delivery_attempts_max, replans_max
    explicit_wf = overrides.get("workflow")
    workflow = str(explicit_wf).strip() if explicit_wf else (
        config_data.get("workflow") or config_data.get("default_workflow") or DEFAULT_WORKFLOW
    )

    explicit_delivery_attempts_max = overrides.get("delivery_attempts_max")
    if explicit_delivery_attempts_max is not None:
        delivery_attempts_max = int(explicit_delivery_attempts_max)
    else:
        delivery_attempts_max = int(config_data.get("delivery_attempts_max", DEFAULT_DELIVERY_ATTEMPTS_MAX))

    explicit_replans_max = overrides.get("replans_max")
    if explicit_replans_max is not None:
        replans_max = int(explicit_replans_max)
    else:
        replans_max = int(config_data.get("replans_max", DEFAULT_REPLANS_MAX))

    container_path = Path(worktree_container)
    if not container_path.is_absolute():
        container_path = (repo_root / container_path).resolve()
    else:
        container_path = container_path.resolve()

    resolved = {
        "schema_version": SCHEMA_VERSION,
        "delivery_target": delivery_target,
        "base_remote": base_remote,
        "push_remote": push_remote,
        "base_branch": base_branch,
        "worktree_container": worktree_container,
        "workflow": workflow,
        "delivery_attempts_max": delivery_attempts_max,
        "replans_max": replans_max,
        "repo_checkout": repo_checkout,
        "worktree_container_resolved": str(container_path),
    }

    errors = validate_workspace_config(resolved, repo_root)
    if errors:
        raise ValueError("Resolved workspace configuration is invalid:\n  - " + "\n  - ".join(errors))

    return resolved


def cmd_init(args: argparse.Namespace) -> int:
    """Initialize or update .paper-craft/workspace-config.json."""
    repo_root = find_repo_root(Path(args.repo_dir))
    config_path = repo_root / CONFIG_REL_PATH

    if config_path.exists() and not args.force and not args.defaults:
        if not sys.stdin.isatty() or args.defaults:
            pass
        else:
            sys.stderr.write(f"Configuration already exists at {config_path}. Use --force to overwrite.\n")
            return 1

    remotes = probe_git_remotes(repo_root)

    # 1. Determine explicit base_remote before probing
    if args.base_remote:
        base_remote = args.base_remote
        if remotes and base_remote not in remotes:
            sys.stderr.write(f"Error: Specified base_remote '{base_remote}' does not exist in git remotes: {remotes}\n")
            return 1
    else:
        if "upstream" in remotes:
            base_remote = "upstream"
        elif "origin" in remotes:
            base_remote = "origin"
        elif len(remotes) == 1:
            base_remote = remotes[0]
        elif not remotes:
            sys.stderr.write("Error: No git remotes configured in repository. Cannot determine remote without explicit --base-remote.\n")
            return 1
        else:
            sys.stderr.write(f"Error: Multiple remotes configured ({remotes}) without origin or upstream. Please specify --base-remote explicitly.\n")
            return 1

    # 2. Determine explicit push_remote
    if args.push_remote:
        push_remote = args.push_remote
        if remotes and push_remote not in remotes:
            sys.stderr.write(f"Error: Specified push_remote '{push_remote}' does not exist in git remotes: {remotes}\n")
            return 1
    else:
        if "upstream" in remotes and "origin" in remotes:
            push_remote = "origin"
        else:
            push_remote = base_remote

    # 3. Determine delivery_target from explicit remote (do NOT guess fallback defaults)
    if args.delivery_target:
        delivery_target = args.delivery_target
    else:
        probed_target = None
        code, remote_url, _ = run_git(repo_root, "remote", "get-url", base_remote)
        if code == 0 and remote_url:
            probed_target = parse_repo_from_url(remote_url)
        if not probed_target and "origin" in remotes and base_remote != "origin":
            code, remote_url, _ = run_git(repo_root, "remote", "get-url", "origin")
            if code == 0 and remote_url:
                probed_target = parse_repo_from_url(remote_url)
        if not probed_target:
            sys.stderr.write(
                f"Error: Cannot determine delivery_target from remote '{base_remote}'. "
                "Facts cannot be confirmed. Please specify --delivery-target explicitly.\n"
            )
            return 1
        delivery_target = probed_target

    # 4. Determine base_branch from explicit remote (do NOT guess 'main')
    if args.base_branch:
        base_branch = args.base_branch
    else:
        probed_branch = probe_default_branch(repo_root, base_remote)
        if not probed_branch:
            sys.stderr.write(
                f"Error: Cannot determine base_branch from remote '{base_remote}'. "
                "Facts cannot be confirmed. Please specify --base-branch explicitly.\n"
            )
            return 1
        base_branch = probed_branch

    worktree_container = args.worktree_container or DEFAULT_WORKTREE_CONTAINER
    workflow = getattr(args, "workflow", None) or DEFAULT_WORKFLOW
    delivery_attempts_max = getattr(args, "delivery_attempts_max", None) or DEFAULT_DELIVERY_ATTEMPTS_MAX
    replans_max = getattr(args, "replans_max", None) or DEFAULT_REPLANS_MAX

    is_fork = base_remote != push_remote

    # Interactive confirmation if interactive and not --defaults / --yes
    if sys.stdin.isatty() and not (args.defaults or getattr(args, "yes", False)):
        try:
            print("=== Paper-craft Workspace Configuration Wizard ===")
            print(f"Repository Root:    {repo_root}")
            if is_fork:
                print("\nFork repository setup detected (distinct upstream and origin remotes):")
                print("  - delivery_target: Upstream repository for Issues, PRs, and landing (e.g. upstream-owner/repo)")
                print("  - base_remote:     Remote to fetch latest mainline code from (e.g. upstream)")
                print("  - push_remote:     Remote to push personal feature branches to (e.g. origin)")
                print("  - base_branch:     Mainline base branch on base_remote (e.g. main)")
                print("  - worktree_container: Directory container for disposable git worktrees\n")
            else:
                print("\nStandard repository setup detected (origin is canonical base and push remote).\n")

            print("delivery_target: Upstream repository for Issues, PRs, and landing (e.g. owner/repo)")
            ans = input(f"  Delivery Target [{delivery_target}]: ").strip()
            if ans:
                delivery_target = ans

            print("base_remote: Remote to fetch latest mainline code from (e.g. upstream or origin)")
            ans = input(f"  Base Remote [{base_remote}]: ").strip()
            if ans:
                base_remote = ans

            print("push_remote: Remote to push personal feature branches to (e.g. origin)")
            ans = input(f"  Push Remote [{push_remote}]: ").strip()
            if ans:
                push_remote = ans

            print("base_branch: Mainline base branch on base_remote (e.g. main)")
            ans = input(f"  Base Branch [{base_branch}]: ").strip()
            if ans:
                base_branch = ans

            print("worktree_container: Directory container for disposable git worktrees")
            ans = input(f"  Worktree Container [{worktree_container}]: ").strip()
            if ans:
                worktree_container = ans
        except (KeyboardInterrupt, EOFError):
            sys.stderr.write("\nConfiguration wizard aborted.\n")
            return 1

    config_data = {
        "schema_version": SCHEMA_VERSION,
        "delivery_target": delivery_target,
        "base_remote": base_remote,
        "push_remote": push_remote,
        "base_branch": base_branch,
        "worktree_container": worktree_container,
        "workflow": workflow,
        "delivery_attempts_max": int(delivery_attempts_max),
        "replans_max": int(replans_max),
    }

    # Validate
    errors = validate_workspace_config(config_data, repo_root)
    if errors:
        sys.stderr.write("Validation failed during initialization:\n  - " + "\n  - ".join(errors) + "\n")
        return 1

    atomic_write_json(config_path, config_data)
    print(json.dumps(config_data, indent=2, ensure_ascii=False))
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    """Show workspace configuration."""
    repo_root = find_repo_root(Path(args.repo_dir))
    config_path = get_config_file_path(repo_root)

    if not config_path.exists():
        sys.stderr.write(
            f"Error: Workspace configuration missing at {config_path}.\n"
            f"Please run 'pc-workspace-config' to initialize configuration.\n"
        )
        return 1

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        sys.stderr.write(f"Error: Corrupted workspace config at {config_path}: {e}\n")
        return 1

    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    """Validate workspace configuration."""
    repo_root = find_repo_root(Path(args.repo_dir))
    config_path = get_config_file_path(repo_root)

    if not config_path.exists():
        sys.stderr.write(
            f"Error: Workspace configuration is missing at {config_path}.\n"
            f"Please run 'pc-workspace-config' to initialize.\n"
        )
        return 1

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        sys.stderr.write(f"Error: Workspace configuration at {config_path} is invalid: {e}\n")
        return 1

    errors = validate_workspace_config(data, repo_root)
    if errors:
        sys.stderr.write(
            f"Error: Workspace configuration at {config_path} is invalid:\n  - "
            + "\n  - ".join(errors)
            + "\nPlease run 'pc-workspace-config' to reconfigure.\n"
        )
        return 1

    print(f"Workspace configuration is valid: {config_path}")
    return 0


def main() -> int:
    common_parser = argparse.ArgumentParser(add_help=False)
    common_parser.add_argument("--repo-dir", default=argparse.SUPPRESS, help="Path to Git repository root.")

    parser = argparse.ArgumentParser(
        parents=[common_parser],
        description="Workspace configuration manager for paper-craft (pc-workspace-config)."
    )

    subparsers = parser.add_subparsers(dest="subcommand")

    # Subcommands
    init_parser = subparsers.add_parser("init", parents=[common_parser], help="Initialize workspace configuration.")
    init_parser.add_argument("--delivery-target", help="Delivery target repository (owner/repo).")
    init_parser.add_argument("--base-remote", help="Mainline base git remote (e.g. origin).")
    init_parser.add_argument("--push-remote", help="Feature push git remote (e.g. origin).")
    init_parser.add_argument("--base-branch", help="Mainline base branch (e.g. main).")
    init_parser.add_argument("--worktree-container", help="Container directory for worktrees.")
    init_parser.add_argument("--workflow", default=DEFAULT_WORKFLOW, help="Default workflow name.")
    init_parser.add_argument("--delivery-attempts-max", type=int, default=DEFAULT_DELIVERY_ATTEMPTS_MAX, help="Max delivery attempts.")
    init_parser.add_argument("--replans-max", type=int, default=DEFAULT_REPLANS_MAX, help="Max replans.")
    init_parser.add_argument("--defaults", "--yes", dest="defaults", action="store_true", help="Accept defaults non-interactively.")
    init_parser.add_argument("--force", action="store_true", help="Force overwrite existing configuration.")

    show_parser = subparsers.add_parser("show", parents=[common_parser], help="Show workspace configuration.")
    validate_parser = subparsers.add_parser("validate", parents=[common_parser], help="Validate workspace configuration.")

    args = parser.parse_args()
    if not hasattr(args, "repo_dir"):
        args.repo_dir = "."

    # Determine command
    if args.subcommand == "init":
        return cmd_init(args)
    elif args.subcommand == "show":
        return cmd_show(args)
    elif args.subcommand == "validate":
        return cmd_validate(args)
    else:
        # Default action when invoked without subcommands
        repo_root = find_repo_root(Path(args.repo_dir))
        cfg_path = get_config_file_path(repo_root)
        if not cfg_path.exists():
            sys.stderr.write(
                f"Error: Workspace configuration is missing at {cfg_path}.\n"
                f"Please run 'pc-workspace-config init' to initialize.\n"
            )
            return 1
        return cmd_show(args)


if __name__ == "__main__":
    sys.exit(main())
