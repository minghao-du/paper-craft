#!/usr/bin/env python3
"""Task Input Envelope engine for pc-orchestrator workflows.

Generates, validates, saves, and loads structured JSON task input envelopes
(<receipt_root>/<step>-input.json) to decouple logical tasks from execution providers.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional, Union


class EnvelopeError(Exception):
    """Base exception for envelope operations."""

    pass


class EnvelopeValidationError(EnvelopeError, ValueError):
    """Raised when an envelope fails schema or semantic validation."""

    def __init__(self, errors: List[str]):
        self.errors = errors
        super().__init__("Invalid TaskInputEnvelope:\n  - " + "\n  - ".join(errors))


class EnvelopeCorruptedError(EnvelopeError, ValueError):
    """Raised when an envelope file cannot be parsed as JSON."""

    pass


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


def validate_envelope(data: Any) -> List[str]:
    """Validate a dictionary against TaskInputEnvelope schema rules.

    Returns a list of error strings. An empty list indicates full compliance.
    Does NOT raise exceptions, allowing caller to review all accumulated defects.
    """
    errors: List[str] = []

    if not isinstance(data, dict):
        return ["Root envelope must be a JSON object (dict)"]

    required_top_keys = [
        "schema_version",
        "task",
        "provider",
        "environment",
        "inputs",
        "contract",
        "budgets",
    ]
    for key in required_top_keys:
        if key not in data:
            errors.append(f"Missing required top-level key: '{key}'")

    # 1. schema_version
    if "schema_version" in data:
        ver = data["schema_version"]
        if ver != "1.0":
            errors.append(f"[schema_version] Unsupported schema_version '{ver}'. Expected '1.0'")

    # 2. task
    if "task" in data:
        task = data["task"]
        if not isinstance(task, dict):
            errors.append("[task] Expected JSON object (dict)")
        else:
            if "logical_stage" not in task:
                errors.append("[task.logical_stage] Expected non-empty string")
            elif not isinstance(task["logical_stage"], str) or not task["logical_stage"].strip():
                errors.append("[task.logical_stage] Expected non-empty string")

            if "step_index" not in task:
                errors.append("[task.step_index] Expected integer >= 0")
            elif (
                not isinstance(task["step_index"], int)
                or isinstance(task["step_index"], bool)
                or task["step_index"] < 0
            ):
                errors.append(f"[task.step_index] Expected integer >= 0, got {task['step_index']}")

            if "attempt" not in task:
                errors.append("[task.attempt] Expected integer >= 1")
            elif (
                not isinstance(task["attempt"], int)
                or isinstance(task["attempt"], bool)
                or task["attempt"] < 1
            ):
                errors.append(f"[task.attempt] Expected integer >= 1, got {task['attempt']}")

            if "root_issue_id" not in task:
                errors.append("[task.root_issue_id] Expected non-empty string")
            elif not isinstance(task["root_issue_id"], str) or not task["root_issue_id"].strip():
                errors.append("[task.root_issue_id] Expected non-empty string")

            if "current_issue_id" not in task:
                errors.append("[task.current_issue_id] Expected non-empty string")
            elif not isinstance(task["current_issue_id"], str) or not task["current_issue_id"].strip():
                errors.append("[task.current_issue_id] Expected non-empty string")

    # 3. provider
    if "provider" in data:
        provider = data["provider"]
        if not isinstance(provider, dict):
            errors.append("[provider] Expected JSON object (dict)")
        else:
            p_type = provider.get("type")
            if p_type not in ("skill", "script"):
                errors.append(f"[provider.type] Expected 'skill' | 'script', got '{p_type}'")

            if "target" not in provider:
                errors.append("[provider.target] Expected non-empty string")
            elif not isinstance(provider["target"], str) or not provider["target"].strip():
                errors.append("[provider.target] Expected non-empty string")

            if "args" in provider and not isinstance(provider["args"], list):
                errors.append("[provider.args] Expected list of strings")

    # 4. environment
    if "environment" in data:
        env = data["environment"]
        if not isinstance(env, dict):
            errors.append("[environment] Expected JSON object (dict)")
        else:
            if "working_directory" not in env:
                errors.append("[environment.working_directory] Expected non-empty string")
            elif not isinstance(env["working_directory"], str) or not env["working_directory"].strip():
                errors.append("[environment.working_directory] Expected non-empty string")

    # 5. inputs
    if "inputs" in data:
        inputs = data["inputs"]
        if not isinstance(inputs, dict):
            errors.append("[inputs] Expected JSON object (dict)")
        else:
            if "objective" not in inputs:
                errors.append("[inputs.objective] Expected non-empty string")
            elif not isinstance(inputs["objective"], str) or not inputs["objective"].strip():
                errors.append("[inputs.objective] Expected non-empty string")

            if "scope" in inputs and not isinstance(inputs["scope"], str):
                errors.append("[inputs.scope] Expected string")

            if "acceptance_criteria" in inputs and not isinstance(inputs["acceptance_criteria"], list):
                errors.append("[inputs.acceptance_criteria] Expected list")

            if "predecessor_receipts" in inputs and not isinstance(inputs["predecessor_receipts"], list):
                errors.append("[inputs.predecessor_receipts] Expected list")

    # 6. contract
    if "contract" in data:
        contract = data["contract"]
        if not isinstance(contract, dict):
            errors.append("[contract] Expected JSON object (dict)")
        else:
            if "receipt_path" not in contract:
                errors.append("[contract.receipt_path] Expected non-empty string")
            elif not isinstance(contract["receipt_path"], str) or not contract["receipt_path"].strip():
                errors.append("[contract.receipt_path] Expected non-empty string")

    # 7. budgets
    if "budgets" in data:
        budgets = data["budgets"]
        if not isinstance(budgets, dict):
            errors.append("[budgets] Expected JSON object (dict)")
        else:
            if "delivery_attempts_used" in budgets:
                val = budgets["delivery_attempts_used"]
                if not isinstance(val, int) or isinstance(val, bool) or val < 0:
                    errors.append(f"[budgets.delivery_attempts_used] Expected integer >= 0, got {val}")
            if "replans_used" in budgets:
                val = budgets["replans_used"]
                if not isinstance(val, int) or isinstance(val, bool) or val < 0:
                    errors.append(f"[budgets.replans_used] Expected integer >= 0, got {val}")

            for k in ("delivery_attempts_limit", "delivery_attempts_max"):
                if k in budgets:
                    val = budgets[k]
                    if not isinstance(val, int) or isinstance(val, bool) or val < 1:
                        errors.append(f"[budgets.{k}] Expected integer >= 1, got {val}")
            for k in ("replans_limit", "replans_max"):
                if k in budgets:
                    val = budgets[k]
                    if not isinstance(val, int) or isinstance(val, bool) or val < 1:
                        errors.append(f"[budgets.{k}] Expected integer >= 1, got {val}")

    return errors


def assert_valid_envelope(data: Any) -> None:
    """Validate data and raise EnvelopeValidationError if any errors exist."""
    errors = validate_envelope(data)
    if errors:
        raise EnvelopeValidationError(errors)


def create_envelope(
    *,
    logical_stage: str,
    step_index: int,
    root_issue_id: Union[str, int],
    current_issue_id: Optional[Union[str, int]] = None,
    attempt: int = 1,
    provider_type: str,
    provider_target: str,
    provider_args: Optional[List[str]] = None,
    working_directory: Union[str, Path],
    repository: str = "local/repo",
    delivery_target: Optional[str] = None,
    base_remote: Optional[str] = None,
    push_remote: Optional[str] = None,
    base_branch: str = "main",
    branch: Optional[str] = None,
    commit: Optional[str] = None,
    objective: str,
    scope: str = "",
    acceptance_criteria: Optional[List[str]] = None,
    predecessor_receipts: Optional[List[str]] = None,
    parameters: Optional[Dict[str, Any]] = None,
    worktree_container: Optional[str] = None,
    receipt_path: Union[str, Path],
    receipt_template: str = "templates/subagent-receipt.template.md",
    delivery_attempts_used: int = 0,
    delivery_attempts_max: int = 3,
    delivery_attempts_limit: Optional[int] = None,
    replans_used: int = 0,
    replans_max: int = 2,
    replans_limit: Optional[int] = None,
    schema_version: str = "1.0",
    validate: bool = True,
) -> Dict[str, Any]:
    """Assemble a standard TaskInputEnvelope dictionary."""
    root_str = str(root_issue_id)
    curr_str = str(current_issue_id) if current_issue_id is not None else root_str
    attempts_max = delivery_attempts_limit if delivery_attempts_limit is not None else delivery_attempts_max
    replan_max = replans_limit if replans_limit is not None else replans_max

    workdir_str = str(Path(working_directory).resolve()) if working_directory else ""
    receipt_str = str(Path(receipt_path).resolve()) if receipt_path else ""

    cfg_repo = None
    cfg_base_remote = None
    cfg_push_remote = None
    cfg_base_b = None
    cfg_container = None
    if workdir_str:
        try:
            w_path = Path(workdir_str)
            for cand in (
                w_path / ".paper-craft" / "workspace-config.json",
                w_path / ".paper-craft" / "workspace.json",
            ):
                if cand.exists():
                    with open(cand, "r", encoding="utf-8") as cf:
                        cfg = json.load(cf)
                        cfg_repo = cfg.get("delivery_target")
                        cfg_base_remote = cfg.get("base_remote")
                        cfg_push_remote = cfg.get("push_remote")
                        cfg_base_b = cfg.get("base_branch")
                        cfg_container = cfg.get("worktree_container")
                    break
        except Exception:
            pass

    resolved_deliv = delivery_target or (repository if repository != "local/repo" else None) or cfg_repo or "local/repo"
    repo_val = resolved_deliv
    resolved_base_remote = base_remote or cfg_base_remote or "origin"
    resolved_push_remote = push_remote or cfg_push_remote or "origin"
    base_b_val = (base_branch if base_branch != "main" else None) or cfg_base_b or base_branch or "main"
    resolved_container = worktree_container or cfg_container

    params = dict(parameters or {})
    if "delivery_target" not in params and resolved_deliv != "local/repo":
        params["delivery_target"] = resolved_deliv
    if "base_remote" not in params:
        params["base_remote"] = resolved_base_remote
    if "push_remote" not in params:
        params["push_remote"] = resolved_push_remote
    if "worktree_container" not in params and resolved_container:
        params["worktree_container"] = resolved_container

    envelope: Dict[str, Any] = {
        "schema_version": schema_version,
        "task": {
            "logical_stage": str(logical_stage),
            "step_index": int(step_index),
            "attempt": int(attempt),
            "root_issue_id": root_str,
            "current_issue_id": curr_str,
        },
        "provider": {
            "type": provider_type,
            "target": str(provider_target),
            "args": list(provider_args or []),
        },
        "environment": {
            "working_directory": workdir_str,
            "repository": repo_val,
            "delivery_target": resolved_deliv,
            "base_remote": resolved_base_remote,
            "push_remote": resolved_push_remote,
            "base_branch": base_b_val,
            "branch": branch,
            "commit": commit,
        },
        "inputs": {
            "objective": str(objective),
            "scope": str(scope or ""),
            "acceptance_criteria": list(acceptance_criteria or []),
            "predecessor_receipts": list(predecessor_receipts or []),
            "parameters": params,
        },
        "contract": {
            "receipt_path": receipt_str,
            "receipt_template": str(receipt_template or "templates/subagent-receipt.template.md"),
        },
        "budgets": {
            "delivery_attempts_used": int(delivery_attempts_used),
            "delivery_attempts_max": int(attempts_max),
            "delivery_attempts_limit": int(attempts_max),
            "replans_used": int(replans_used),
            "replans_max": int(replan_max),
            "replans_limit": int(replan_max),
        },
    }

    if validate:
        assert_valid_envelope(envelope)

    return envelope


def save_envelope(
    envelope: Dict[str, Any],
    target_path: Union[str, Path],
    validate: bool = True,
) -> Path:
    """Save envelope to target_path using atomic write semantics."""
    if validate:
        assert_valid_envelope(envelope)
    path = Path(target_path).resolve()
    atomic_write_json(path, envelope)
    return path


def load_envelope(
    envelope_path: Union[str, Path],
    validate: bool = True,
) -> Dict[str, Any]:
    """Load and parse an envelope JSON file."""
    path = Path(envelope_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Envelope file not found: {path}")

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        raise EnvelopeCorruptedError(f"Malformed JSON in envelope {path}: {e}") from e
    except Exception as e:
        raise EnvelopeCorruptedError(f"Failed to read envelope {path}: {e}") from e

    if validate:
        assert_valid_envelope(data)

    return data


def cmd_create(args: argparse.Namespace) -> None:
    """Handle 'create' CLI subcommand."""
    state_data: Dict[str, Any] = {}
    if args.from_state:
        state_path = Path(args.from_state).resolve()
        if not state_path.exists():
            sys.stderr.write(f"Error: State file not found at {state_path}\n")
            sys.exit(1)
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                state_data = json.load(f)
        except Exception as e:
            sys.stderr.write(f"Error: Failed to read state file at {state_path}: {e}\n")
            sys.exit(1)

    logical_stage = args.logical_stage or state_data.get("current_stage")
    if not logical_stage:
        sys.stderr.write("Error: --stage / --logical-stage is required\n")
        sys.exit(1)

    step_index = args.step_index
    if step_index is None:
        sys.stderr.write("Error: --step / --step-index is required\n")
        sys.exit(1)

    root_issue = args.root_issue or state_data.get("root_issue_id")
    if not root_issue:
        sys.stderr.write("Error: --root-issue is required\n")
        sys.exit(1)

    current_issue = args.current_issue or state_data.get("current_issue_id") or root_issue

    working_directory = (
        args.working_directory
        or state_data.get("context", {}).get("worktree")
        or state_data.get("context", {}).get("working_directory")
    )
    if not working_directory:
        sys.stderr.write("Error: --workdir / --working-directory is required\n")
        sys.exit(1)

    cfg_repo = None
    cfg_base_remote = None
    cfg_push_remote = None
    cfg_base = None
    cfg_container = None
    try:
        w_path = Path(working_directory).resolve()
        for cand in (
            w_path / ".paper-craft" / "workspace-config.json",
            w_path / ".paper-craft" / "workspace.json",
        ):
            if cand.exists():
                with open(cand, "r", encoding="utf-8") as cf:
                    cfg = json.load(cf)
                    cfg_repo = cfg.get("delivery_target")
                    cfg_base_remote = cfg.get("base_remote")
                    cfg_push_remote = cfg.get("push_remote")
                    cfg_base = cfg.get("base_branch")
                    cfg_container = cfg.get("worktree_container")
                break
    except Exception:
        pass

    delivery_target = (
        getattr(args, "delivery_target", None)
        or state_data.get("context", {}).get("delivery_target")
        or cfg_repo
    )
    repo_arg = args.repository
    if repo_arg == "local/repo" and (delivery_target or cfg_repo):
        repo_arg = delivery_target or cfg_repo

    base_remote = (
        getattr(args, "base_remote", None)
        or state_data.get("context", {}).get("base_remote")
        or cfg_base_remote
    )
    push_remote = (
        getattr(args, "push_remote", None)
        or state_data.get("context", {}).get("push_remote")
        or cfg_push_remote
    )
    worktree_container = (
        getattr(args, "worktree_container", None)
        or state_data.get("context", {}).get("worktree_container")
        or cfg_container
    )

    if args.base_branch and args.base_branch != "main":
        base_branch = args.base_branch
    elif state_data.get("context", {}).get("base_branch"):
        base_branch = state_data["context"]["base_branch"]
    elif cfg_base:
        base_branch = cfg_base
    else:
        base_branch = args.base_branch or "main"

    branch = args.branch or state_data.get("context", {}).get("branch")
    commit = args.commit or state_data.get("context", {}).get("commit")

    predecessors = list(args.predecessor_receipts or [])
    if not predecessors and state_data.get("completed_stages"):
        latest_completed = state_data["completed_stages"][-1]
        rec = latest_completed.get("receipt_path")
        if rec:
            predecessors.append(rec)

    delivery_used = int(state_data.get("budgets", {}).get("delivery_attempts_used", 0))
    replan_used = int(state_data.get("budgets", {}).get("replans_used", 0))

    try:
        env = create_envelope(
            logical_stage=logical_stage,
            step_index=step_index,
            attempt=args.attempt,
            root_issue_id=root_issue,
            current_issue_id=current_issue,
            provider_type=args.provider_type,
            provider_target=args.provider_target,
            provider_args=args.provider_args,
            working_directory=working_directory,
            repository=repo_arg,
            delivery_target=delivery_target,
            base_remote=base_remote,
            push_remote=push_remote,
            base_branch=base_branch,
            branch=branch,
            commit=commit,
            objective=args.objective,
            scope=args.scope,
            acceptance_criteria=args.acceptance_criteria,
            predecessor_receipts=predecessors,
            worktree_container=worktree_container,
            receipt_path=args.receipt_path,
            receipt_template=args.receipt_template,
            delivery_attempts_used=delivery_used,
            delivery_attempts_max=args.delivery_attempts_max,
            replans_used=replan_used,
            replans_max=args.replans_max,
            validate=not args.no_validate,
        )
    except EnvelopeValidationError as e:
        sys.stderr.write(f"Error: {e}\n")
        sys.exit(1)
    except Exception as e:
        sys.stderr.write(f"Error creating envelope: {e}\n")
        sys.exit(1)

    out_path = Path(args.output).resolve()
    try:
        save_envelope(env, out_path, validate=not args.no_validate)
    except Exception as e:
        sys.stderr.write(f"Error saving envelope to {out_path}: {e}\n")
        sys.exit(1)

    print(json.dumps(env, indent=2, ensure_ascii=False))


def cmd_validate(args: argparse.Namespace) -> None:
    """Handle 'validate' CLI subcommand."""
    path = Path(args.envelope_path).resolve()
    if not path.exists():
        sys.stderr.write(f"Error: Envelope file not found at {path}\n")
        sys.exit(1)

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        sys.stderr.write(f"Error: Corrupted envelope JSON at {path}: {e}\n")
        sys.exit(1)

    errors = validate_envelope(data)
    if args.json:
        print(json.dumps(errors, indent=2, ensure_ascii=False))
        if errors:
            sys.exit(1)
        return

    if errors:
        sys.stderr.write(f"Validation failed for {path}:\n  - " + "\n  - ".join(errors) + "\n")
        sys.exit(1)

    print(f"Valid envelope: {path}")


def cmd_show(args: argparse.Namespace) -> None:
    """Handle 'show' CLI subcommand."""
    path = Path(args.envelope_path).resolve()
    if not path.exists():
        sys.stderr.write(f"Error: Envelope file not found at {path}\n")
        sys.exit(1)

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        sys.stderr.write(f"Error: Corrupted envelope JSON at {path}: {e}\n")
        sys.exit(1)

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    if args.field:
        keys = args.field.split(".")
        val: Any = data
        for k in keys:
            if isinstance(val, dict) and k in val:
                val = val[k]
            else:
                sys.stderr.write(f"Error: Field '{args.field}' not found in envelope.\n")
                sys.exit(1)
        if isinstance(val, (dict, list)):
            print(json.dumps(val, indent=2, ensure_ascii=False))
        else:
            print(val)
        return

    # Compact human-readable summary
    stage = data.get("task", {}).get("logical_stage", "unknown")
    step = data.get("task", {}).get("step_index", "?")
    attempt = data.get("task", {}).get("attempt", "?")
    root_id = data.get("task", {}).get("root_issue_id", "?")
    curr_id = data.get("task", {}).get("current_issue_id", "?")
    provider = data.get("provider", {})
    p_type = provider.get("type", "unknown")
    p_target = provider.get("target", "unknown")
    env = data.get("environment", {})
    workdir = env.get("working_directory", "unknown")
    repo = env.get("repository", "")
    base_b = env.get("base_branch", "")
    branch = env.get("branch", "")
    contract = data.get("contract", {})
    receipt = contract.get("receipt_path", "")
    inputs = data.get("inputs", {})
    objective = inputs.get("objective", "")
    criteria = inputs.get("acceptance_criteria", [])
    budgets = data.get("budgets", {})
    del_used = budgets.get("delivery_attempts_used", 0)
    del_max = budgets.get("delivery_attempts_limit", budgets.get("delivery_attempts_max", 3))
    rep_used = budgets.get("replans_used", 0)
    rep_max = budgets.get("replans_limit", budgets.get("replans_max", 2))

    print(f"Envelope: {path} (v{data.get('schema_version', '1.0')})")
    print(f"Task: {stage} (step {step}, attempt {attempt}) | Root: #{root_id}, Current: #{curr_id}")
    print(f"Provider: {p_type} -> {p_target}")
    print(f"Environment: {workdir} (repo: {repo}, base: {base_b}, branch: {branch})")
    print(f"Inputs: Objective=\"{objective}\", Criteria={len(criteria)}")
    print(f"Contract: Receipt={receipt}")
    print(f"Budgets: Delivery={del_used}/{del_max}, Replans={rep_used}/{rep_max}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Task Input Envelope engine for pc-orchestrator workflows."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # create
    create_parser = subparsers.add_parser("create", help="Create and save a new task input envelope.")
    create_parser.add_argument("--output", required=True, help="Target output envelope path.")
    create_parser.add_argument("--stage", "--logical-stage", dest="logical_stage", help="Logical stage name.")
    create_parser.add_argument("--step", "--step-index", dest="step_index", type=int, help="Step index.")
    create_parser.add_argument("--attempt", type=int, default=1, help="Attempt number.")
    create_parser.add_argument("--root-issue", help="Root issue ID.")
    create_parser.add_argument("--current-issue", help="Current issue ID.")
    create_parser.add_argument("--provider-type", required=True, help="Provider type ('skill' or 'script').")
    create_parser.add_argument("--provider-target", required=True, help="Provider target (skill name or script path).")
    create_parser.add_argument(
        "--provider-arg",
        dest="provider_args",
        action="append",
        default=[],
        help="Provider argument.",
    )
    create_parser.add_argument(
        "--workdir",
        "--working-directory",
        dest="working_directory",
        help="Working directory.",
    )
    create_parser.add_argument("--repository", default="local/repo", help="Repository identifier.")
    create_parser.add_argument("--delivery-target", help="Delivery target repository (owner/repo).")
    create_parser.add_argument("--base-remote", help="Mainline base git remote (e.g. origin or upstream).")
    create_parser.add_argument("--push-remote", help="Feature push git remote (e.g. origin).")
    create_parser.add_argument("--worktree-container", help="Container directory for worktrees.")
    create_parser.add_argument("--base-branch", default="main", help="Base branch.")
    create_parser.add_argument("--branch", help="Feature branch.")
    create_parser.add_argument("--commit", help="Commit SHA.")
    create_parser.add_argument("--objective", required=True, help="Task objective.")
    create_parser.add_argument("--scope", default="", help="Task scope.")
    create_parser.add_argument(
        "--criteria",
        "--criterion",
        dest="acceptance_criteria",
        action="append",
        default=[],
        help="Acceptance criterion.",
    )
    create_parser.add_argument(
        "--predecessor-receipt",
        dest="predecessor_receipts",
        action="append",
        default=[],
        help="Predecessor receipt path.",
    )
    create_parser.add_argument("--receipt-path", required=True, help="Contract receipt path.")
    create_parser.add_argument(
        "--receipt-template",
        default="templates/subagent-receipt.template.md",
        help="Receipt template path.",
    )
    create_parser.add_argument(
        "--delivery-attempts-max",
        "--delivery-attempts-limit",
        dest="delivery_attempts_max",
        type=int,
        default=3,
        help="Max delivery attempts.",
    )
    create_parser.add_argument(
        "--replans-max",
        "--replans-limit",
        dest="replans_max",
        type=int,
        default=2,
        help="Max replans.",
    )
    create_parser.add_argument("--from-state", help="Path to state.json to load context from.")
    create_parser.add_argument("--no-validate", action="store_true", help="Skip envelope validation.")
    create_parser.set_defaults(func=cmd_create)

    # validate
    validate_parser = subparsers.add_parser("validate", help="Validate an envelope JSON file.")
    validate_parser.add_argument("envelope_path", help="Path to envelope JSON file.")
    validate_parser.add_argument("--json", action="store_true", help="Output validation result as JSON.")
    validate_parser.set_defaults(func=cmd_validate)

    # show
    show_parser = subparsers.add_parser("show", help="Display envelope contents.")
    show_parser.add_argument("envelope_path", help="Path to envelope JSON file.")
    show_parser.add_argument("--json", action="store_true", help="Output full envelope as JSON.")
    show_parser.add_argument("--field", help="Get a specific nested field (e.g. contract.receipt_path).")
    show_parser.set_defaults(func=cmd_show)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
