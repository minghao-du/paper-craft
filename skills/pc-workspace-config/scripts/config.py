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
LEGACY_CONFIG_REL_PATH = Path(".paper-craft") / "workspace.json"
DEFAULT_WORKTREE_CONTAINER = "../project-worktrees"


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


def get_config_file_path(repo_root: Path, check_legacy: bool = True) -> Path:
    """Get path to workspace configuration file."""
    primary = repo_root / CONFIG_REL_PATH
    if check_legacy and not primary.exists():
        legacy = repo_root / LEGACY_CONFIG_REL_PATH
        if legacy.exists():
            return legacy
    return primary


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


def probe_default_branch(repo_root: Path, remote: str = "origin") -> str:
    """Probe default branch from remote symbolic ref or branch list."""
    # Try git symbolic-ref refs/remotes/<remote>/HEAD
    code, stdout, _ = run_git(repo_root, "symbolic-ref", f"refs/remotes/{remote}/HEAD")
    if code == 0 and stdout:
        # e.g. refs/remotes/origin/main
        return stdout.split("/")[-1]

    # Try gh repo view if available
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

    # Try local branch names: main, master
    code, stdout, _ = run_git(repo_root, "branch", "--format=%(refname:short)")
    if code == 0 and stdout:
        branches = [b.strip() for b in stdout.splitlines() if b.strip()]
        if "main" in branches:
            return "main"
        if "master" in branches:
            return "master"
        if branches:
            return branches[0]

    return "main"


def load_workspace_config(repo_root: Path) -> Optional[Dict[str, Any]]:
    """Load and parse workspace configuration JSON if present."""
    config_path = get_config_file_path(repo_root)
    if not config_path.exists():
        return None
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        raise ValueError(f"Failed to parse workspace config at {config_path}: {e}") from e


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

    # 3. Check git remotes if repo_root provided and valid git repo
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


def cmd_init(args: argparse.Namespace) -> int:
    """Initialize or update .paper-craft/workspace-config.json."""
    repo_root = find_repo_root(Path(args.repo_dir))
    config_path = repo_root / CONFIG_REL_PATH

    if config_path.exists() and not args.force and not args.defaults:
        # Prompt if existing and interactive
        if not sys.stdin.isatty() or args.defaults:
            pass
        else:
            sys.stderr.write(f"Configuration already exists at {config_path}. Use --force to overwrite.\n")
            return 1

    remotes = probe_git_remotes(repo_root)
    is_fork = "upstream" in remotes

    if is_fork:
        default_base_remote = "upstream"
        default_push_remote = "origin" if "origin" in remotes else "upstream"
        target_probe_remote = "upstream"
    else:
        default_base_remote = "origin" if "origin" in remotes else (remotes[0] if remotes else "origin")
        default_push_remote = default_base_remote
        target_probe_remote = default_base_remote

    # Probe delivery target from primary target remote
    probed_target = None
    if target_probe_remote in remotes:
        code, remote_url, _ = run_git(repo_root, "remote", "get-url", target_probe_remote)
        if code == 0 and remote_url:
            probed_target = parse_repo_from_url(remote_url)

    if not probed_target and "origin" in remotes:
        code, remote_url, _ = run_git(repo_root, "remote", "get-url", "origin")
        if code == 0 and remote_url:
            probed_target = parse_repo_from_url(remote_url)

    # Fallback for delivery target
    if not probed_target:
        probed_target = f"local/{repo_root.name}"

    probed_branch = probe_default_branch(repo_root, default_base_remote)

    # Resolve values with priority: explicit CLI arg > probed > default
    delivery_target = args.delivery_target or probed_target
    base_remote = args.base_remote or default_base_remote
    push_remote = args.push_remote or default_push_remote
    base_branch = args.base_branch or probed_branch
    worktree_container = args.worktree_container or DEFAULT_WORKTREE_CONTAINER

    # Interactive confirmation if interactive and not --defaults / --yes
    if sys.stdin.isatty() and not (args.defaults or getattr(args, "yes", False)):
        try:
            print("=== Paper-craft Workspace Configuration Wizard ===")
            print(f"Repository Root:    {repo_root}")
            if is_fork:
                print("Fork repository setup detected (distinct upstream and origin remotes).")
            ans = input(f"Delivery Target [{delivery_target}]: ").strip()
            if ans:
                delivery_target = ans

            ans = input(f"Base Remote [{base_remote}]: ").strip()
            if ans:
                base_remote = ans

            ans = input(f"Push Remote [{push_remote}]: ").strip()
            if ans:
                push_remote = ans

            ans = input(f"Base Branch [{base_branch}]: ").strip()
            if ans:
                base_branch = ans

            ans = input(f"Worktree Container [{worktree_container}]: ").strip()
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
    common_parser.add_argument("--repo-dir", default=".", help="Path to Git repository root.")

    parser = argparse.ArgumentParser(
        parents=[common_parser],
        description="Workspace configuration manager for paper-craft (pc-workspace-config)."
    )

    # Flag-based alternatives
    parser.add_argument("--init", dest="action_init", action="store_true", help="Initialize workspace configuration.")
    parser.add_argument("--show", dest="action_show", action="store_true", help="Display workspace configuration.")
    parser.add_argument("--validate", dest="action_validate", action="store_true", help="Validate workspace configuration.")

    # Parameters for init
    parser.add_argument("--delivery-target", help="Delivery target repository (owner/repo).")
    parser.add_argument("--base-remote", help="Mainline base git remote (e.g. origin).")
    parser.add_argument("--push-remote", help="Feature push git remote (e.g. origin).")
    parser.add_argument("--base-branch", help="Mainline base branch (e.g. main).")
    parser.add_argument("--worktree-container", help="Container directory for worktrees.")
    parser.add_argument("--defaults", "--yes", dest="defaults", action="store_true", help="Accept defaults non-interactively.")
    parser.add_argument("--force", action="store_true", help="Force overwrite existing configuration.")

    subparsers = parser.add_subparsers(dest="subcommand")

    # Subcommands
    init_parser = subparsers.add_parser("init", parents=[common_parser], help="Initialize workspace configuration.")
    init_parser.add_argument("--delivery-target", help="Delivery target repository (owner/repo).")
    init_parser.add_argument("--base-remote", help="Mainline base git remote (e.g. origin).")
    init_parser.add_argument("--push-remote", help="Feature push git remote (e.g. origin).")
    init_parser.add_argument("--base-branch", help="Mainline base branch (e.g. main).")
    init_parser.add_argument("--worktree-container", help="Container directory for worktrees.")
    init_parser.add_argument("--defaults", "--yes", dest="defaults", action="store_true", help="Accept defaults non-interactively.")
    init_parser.add_argument("--force", action="store_true", help="Force overwrite existing configuration.")

    show_parser = subparsers.add_parser("show", parents=[common_parser], help="Show workspace configuration.")
    validate_parser = subparsers.add_parser("validate", parents=[common_parser], help="Validate workspace configuration.")

    args = parser.parse_args()

    # Determine command
    if args.subcommand == "init" or args.action_init:
        return cmd_init(args)
    elif args.subcommand == "show" or args.action_show:
        return cmd_show(args)
    elif args.subcommand == "validate" or args.action_validate:
        return cmd_validate(args)
    else:
        # Default action when invoked without subcommands: if config missing, prompt init, else show
        repo_root = find_repo_root(Path(args.repo_dir))
        cfg_path = get_config_file_path(repo_root)
        if not cfg_path.exists():
            return cmd_init(args)
        else:
            return cmd_show(args)


if __name__ == "__main__":
    sys.exit(main())
