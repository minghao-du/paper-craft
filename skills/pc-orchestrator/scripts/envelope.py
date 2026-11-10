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

# Import workspace config resolver
_CONFIG_DIR = str(Path(__file__).resolve().parent.parent.parent / "pc-workspace-config" / "scripts")
if _CONFIG_DIR not in sys.path:
    sys.path.insert(0, _CONFIG_DIR)

try:
    from config import resolve_workspace_config, load_workspace_config
except ImportError:
    resolve_workspace_config = None
    load_workspace_config = None


# Absolute path to the receipt template bundled with this skill.
DEFAULT_RECEIPT_TEMPLATE = str(
    Path(__file__).resolve().parent.parent / "templates" / "subagent-receipt.template.md"
)


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
            if p_type != "skill":
                errors.append(f"[provider.type] Expected 'skill', got '{p_type}'")

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

            if "delivery_attempts_max" in budgets:
                val = budgets["delivery_attempts_max"]
                if not isinstance(val, int) or isinstance(val, bool) or val < 1:
                    errors.append(f"[budgets.delivery_attempts_max] Expected integer >= 1, got {val}")
            if "replans_max" in budgets:
                val = budgets["replans_max"]
                if not isinstance(val, int) or isinstance(val, bool) or val < 1:
                    errors.append(f"[budgets.replans_max] Expected integer >= 1, got {val}")

    return errors


def assert_valid_envelope(data: Any) -> None:
    """Validate data and raise EnvelopeValidationError if any errors exist."""
    errors = validate_envelope(data)
    if errors:
        raise EnvelopeValidationError(errors)


def load_workspace_config_from_dir(workdir: Path) -> Optional[Dict[str, Any]]:
    """Load and parse workspace configuration JSON if present.

    Raises EnvelopeCorruptedError if the configuration file is corrupted or malformed.
    Returns None if the file does not exist.
    """
    config_file = workdir / ".paper-craft" / "workspace-config.json"
    if not config_file.exists():
        return None
    try:
        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        raise EnvelopeCorruptedError(
            f"Malformed JSON in workspace configuration at {config_file}: {e}. "
            "Please run 'pc-workspace-config' to reconfigure."
        ) from e
    except Exception as e:
        raise EnvelopeCorruptedError(
            f"Failed to read workspace configuration at {config_file}: {e}. "
            "Please run 'pc-workspace-config' to reconfigure."
        ) from e

    if not isinstance(data, dict):
        raise EnvelopeCorruptedError(
            f"Workspace configuration at {config_file} must be a JSON object. "
            "Please run 'pc-workspace-config' to reconfigure."
        )
    return data


def create_envelope(
    *,
    logical_stage: str,
    step_index: int,
    root_issue_id: Union[str, int],
    current_issue_id: Optional[Union[str, int]] = None,
    attempt: int = 1,
    provider_type: str = "skill",
    provider_target: str,
    provider_args: Optional[List[str]] = None,
    working_directory: Union[str, Path],
    repository: str = "local/repo",
    delivery_target: Optional[str] = None,
    base_remote: Optional[str] = None,
    push_remote: Optional[str] = None,
    base_branch: Optional[str] = None,
    branch: Optional[str] = None,
    commit: Optional[str] = None,
    objective: str,
    scope: str = "",
    acceptance_criteria: Optional[List[str]] = None,
    predecessor_receipts: Optional[List[str]] = None,
    parameters: Optional[Dict[str, Any]] = None,
    worktree_container: Optional[str] = None,
    receipt_path: Union[str, Path],
    receipt_template: str = DEFAULT_RECEIPT_TEMPLATE,
    delivery_attempts_used: int = 0,
    delivery_attempts_max: int = 3,
    replans_used: int = 0,
    replans_max: int = 2,
    schema_version: str = "1.0",
    validate: bool = True,
    config_snapshot: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Assemble a standard TaskInputEnvelope dictionary."""
    root_str = str(root_issue_id)
    curr_str = str(current_issue_id) if current_issue_id is not None else root_str
    attempts_max = delivery_attempts_max
    replan_max = replans_max

    workdir_str = str(Path(working_directory).resolve()) if working_directory else ""
    receipt_str = str(Path(receipt_path).resolve()) if receipt_path else ""

    config = None
    if config_snapshot:
        config = config_snapshot
    elif workdir_str:
        cfg_file = Path(workdir_str) / ".paper-craft" / "workspace-config.json"
        if cfg_file.exists():
            if resolve_workspace_config:
                try:
                    config = resolve_workspace_config(workdir_str)
                except ValueError as e:
                    raise EnvelopeCorruptedError(str(e)) from e
            else:
                config = load_workspace_config_from_dir(Path(workdir_str))

    config_delivery_target = config.get("delivery_target") if config else None
    config_base_remote = config.get("base_remote") if config else None
    config_push_remote = config.get("push_remote") if config else None
    config_base_branch = config.get("base_branch") if config else None
    config_worktree_container = config.get("worktree_container") if config else None

    resolved_delivery_target = (
        delivery_target
        or (repository if repository != "local/repo" else None)
        or config_delivery_target
        or "local/repo"
    )
    resolved_repository = resolved_delivery_target
    resolved_base_remote = base_remote or config_base_remote or "origin"
    resolved_push_remote = push_remote or config_push_remote or "origin"
    if base_branch is not None:
        resolved_base_branch = base_branch
    else:
        resolved_base_branch = config_base_branch or "main"
    resolved_worktree_container = worktree_container or config_worktree_container

    params = dict(parameters or {})
    if "delivery_target" not in params and resolved_delivery_target != "local/repo":
        params["delivery_target"] = resolved_delivery_target
    if "base_remote" not in params:
        params["base_remote"] = resolved_base_remote
    if "push_remote" not in params:
        params["push_remote"] = resolved_push_remote
    if "worktree_container" not in params and resolved_worktree_container:
        params["worktree_container"] = resolved_worktree_container

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
            "repository": resolved_repository,
            "base_branch": resolved_base_branch,
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
            "receipt_template": str(receipt_template or DEFAULT_RECEIPT_TEMPLATE),
        },
        "budgets": {
            "delivery_attempts_used": int(delivery_attempts_used),
            "delivery_attempts_max": int(attempts_max),
            "replans_used": int(replans_used),
            "replans_max": int(replan_max),
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
    base_branch = env.get("base_branch", "")
    branch = env.get("branch", "")
    contract = data.get("contract", {})
    receipt = contract.get("receipt_path", "")
    inputs = data.get("inputs", {})
    objective = inputs.get("objective", "")
    criteria = inputs.get("acceptance_criteria", [])
    budgets = data.get("budgets", {})
    del_used = budgets.get("delivery_attempts_used", 0)
    del_max = budgets.get("delivery_attempts_max", 3)
    rep_used = budgets.get("replans_used", 0)
    rep_max = budgets.get("replans_max", 2)

    print(f"Envelope: {path} (v{data.get('schema_version', '1.0')})")
    print(f"Task: {stage} (step {step}, attempt {attempt}) | Root: #{root_id}, Current: #{curr_id}")
    print(f"Provider: {p_type} -> {p_target}")
    print(f"Environment: {workdir} (repo: {repo}, base: {base_branch}, branch: {branch})")
    print(f"Inputs: Objective=\"{objective}\", Criteria={len(criteria)}")
    print(f"Contract: Receipt={receipt}")
    print(f"Budgets: Delivery={del_used}/{del_max}, Replans={rep_used}/{rep_max}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Task Input Envelope engine for pc-orchestrator workflows."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

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
