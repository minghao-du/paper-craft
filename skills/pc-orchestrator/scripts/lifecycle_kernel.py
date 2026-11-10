#!/usr/bin/env python3
"""Minimal dispatch lifecycle kernel for pc-orchestrator workflows.

Provides authoritative lifecycle management for workflow runs, dispatches,
receipt verification, and orchestrator decisions:
  - init: initialize workflow run state snapshot
  - prepare: prepare fixed task, generate envelope, allocate receipt path & step index
  - handoff: record boundary of external execution authorization
  - complete: register compact execution report and verify receipt on disk
  - resolve: record orchestrator decisions (wait_user, continue, halt, finish)
  - inspect: query current status, active dispatch, decisions, and blocking reasons
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional, Tuple

# Import workspace config validator
_CONFIG_DIR = str(Path(__file__).resolve().parent.parent.parent / "pc-workspace-config" / "scripts")
if _CONFIG_DIR not in sys.path:
    sys.path.insert(0, _CONFIG_DIR)

try:
    from config import validate_workspace_config
except ImportError:
    validate_workspace_config = None

# Import envelope utilities
_SCRIPT_DIR = str(Path(__file__).resolve().parent)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from envelope import DEFAULT_RECEIPT_TEMPLATE, validate_envelope, atomic_write_json


def is_plan_stage(stage: str) -> bool:
    return stage in ("stage_1_plan", "issue_plan")


def is_work_stage(stage: str) -> bool:
    return stage in ("stage_2_work", "issue_work")


def is_land_stage(stage: str) -> bool:
    return stage in ("stage_2_land", "issue_land")


def is_verify_stage(stage: str) -> bool:
    return stage in ("stage_3_verify", "issue_verify")


def is_auxiliary_stage(stage: str) -> bool:
    return stage in ("workspace_prepare", "workspace_cleanup")


def is_landed_outcome(result: Dict[str, Any]) -> bool:
    if not isinstance(result, dict):
        return False
    outcome = result.get("outcome")
    if outcome == "landed":
        return True
    if result.get("merged") is True and outcome not in ("rework_needed", "failed", "blocked"):
        return True
    if result.get("mergedCommit") and outcome not in ("rework_needed", "failed", "blocked"):
        return True
    return False


def is_effective_work_outcome(status: str, result: Dict[str, Any]) -> bool:
    if status != "succeeded":
        return False
    if not isinstance(result, dict):
        return False
    outcome = result.get("outcome")
    if outcome in ("rework_needed", "failed", "blocked", "out_of_scope"):
        return False
    return True


def validate_plan_order(tasks: List[Any]) -> List[str]:
    """Validate planned task sequence: non-empty, valid issue IDs, and topological dependency order.

    Returns:
        List of child issue ID strings in planned execution order.
    Raises:
        ValueError if plan is invalid, empty, cyclic, or out of order.
    """
    if not tasks:
        raise ValueError("Plan must contain at least one task.")

    ordered_ids: List[str] = []
    seen: set[str] = set()
    raw_tasks: List[Tuple[str, List[str]]] = []

    for idx, t in enumerate(tasks):
        if isinstance(t, dict):
            raw_id = t.get("number") or t.get("id") or t.get("issue_id")
            raw_blocked = t.get("blockedBy") or t.get("blocked_by") or []
        elif isinstance(t, (int, str)):
            raw_id = t
            raw_blocked = []
        else:
            raise ValueError(f"Task at index {idx} has invalid format: {t!r}")

        if raw_id is None:
            raise ValueError(f"Task at index {idx} is missing issue ID/number.")

        issue_id = str(raw_id).strip()
        if not issue_id:
            raise ValueError(f"Task at index {idx} has empty issue ID.")
        if issue_id in seen:
            raise ValueError(f"Duplicate issue ID '{issue_id}' in plan.")

        seen.add(issue_id)
        blocked_ids = [str(b).strip() for b in raw_blocked]
        raw_tasks.append((issue_id, blocked_ids))
        ordered_ids.append(issue_id)

    # Check dependencies: all blockedBy dependencies must precede the task in ordered_ids
    resolved: set[str] = set()
    for issue_id, blocked_ids in raw_tasks:
        for b in blocked_ids:
            if b == issue_id:
                raise ValueError(f"Task '{issue_id}' cannot depend on itself.")
            if b in seen and b not in resolved:
                raise ValueError(
                    f"Plan dependency violation: task '{issue_id}' depends on '{b}', which does not precede it in the plan order."
                )
        resolved.add(issue_id)

    return ordered_ids


def get_state_file_path(receipt_root: Path | str) -> Path:
    """Return canonical state file path in receipt root."""
    return Path(receipt_root).resolve() / "state.json"


def _recover_uncommitted_dispatch(receipt_root_path: Path, state: Dict[str, Any]) -> Dict[str, Any]:
    """Recover uncommitted prepare dispatch if envelope exists but state.json was interrupted."""
    if state.get("active_dispatch") is not None:
        return state

    next_idx = state.get("next_step_index", 1)
    env_file = receipt_root_path / f"{next_idx:02d}-input.json"
    if not env_file.exists():
        return state

    try:
        with open(env_file, "r", encoding="utf-8") as f:
            env_data = json.load(f)
        task = env_data.get("task", {})
        if task.get("step_index") == next_idx:
            stage = task.get("logical_stage", "")
            step_index = task.get("step_index", next_idx)
            attempt = task.get("attempt", 1)
            root_issue = str(task.get("root_issue_id", state.get("root_issue_id", "0")))
            curr_issue = str(task.get("current_issue_id", state.get("current_issue_id", root_issue)))
            dispatch_id = f"{step_index:02d}-{stage}-issue-{curr_issue}-try-{attempt}"
            contract = env_data.get("contract", {})
            receipt_path = contract.get("receipt_path", str(receipt_root_path / f"{dispatch_id}.md"))
            inputs = env_data.get("inputs", {})
            provider = env_data.get("provider", {})
            env_env = env_data.get("environment", {})

            state["active_dispatch"] = {
                "dispatch_id": dispatch_id,
                "step_index": step_index,
                "task_name": stage,
                "attempt": attempt,
                "status": "prepared",
                "authorized": False,
                "envelope_path": str(env_file),
                "receipt_path": receipt_path,
                "request": {
                    "objective": inputs.get("objective", ""),
                    "provider": {
                        "type": provider.get("type"),
                        "target": provider.get("target"),
                        "args": provider.get("args", []),
                    },
                    "logical_stage": stage,
                    "acceptance_criteria": inputs.get("acceptance_criteria", []),
                    "predecessors": inputs.get("predecessor_receipts", []),
                    "working_directory": env_env.get("working_directory", ""),
                    "branch": env_env.get("branch"),
                    "commit": env_env.get("commit"),
                },
            }
            state["next_step_index"] = step_index + 1
            budgets = state.get("budgets", {})
            if budgets.get("delivery_attempts_used", 0) < attempt:
                budgets["delivery_attempts_used"] = attempt
            state["budgets"] = budgets
            state["current_stage"] = stage
            state["stage_status"] = "pending"
            state["last_updated"] = datetime.now(timezone.utc).isoformat()
            atomic_write_json(get_state_file_path(receipt_root_path), state)
    except (json.JSONDecodeError, OSError) as err:
        sys.stderr.write(f"Warning: Failed to recover uncommitted dispatch envelope {env_file}: {err}\n")

    return state


def _record_protocol_error(receipt_root_path: Path, state: Dict[str, Any], error_type: str, message: str) -> None:
    """Record inspect-visible protocol error without overwriting last confirmed state."""
    now = datetime.now(timezone.utc).isoformat()
    state["protocol_error"] = {
        "error_type": error_type,
        "message": message,
        "timestamp": now,
    }
    state["last_updated"] = now
    atomic_write_json(get_state_file_path(receipt_root_path), state)


def load_state(receipt_root: Path | str) -> Dict[str, Any]:
    """Load state.json from receipt root, exiting or raising if not found."""
    root_path = Path(receipt_root).resolve()
    state_file = get_state_file_path(root_path)
    if not state_file.exists():
        raise FileNotFoundError(f"State file not found at {state_file}. Run 'init' first.")
    with open(state_file, "r", encoding="utf-8") as f:
        state = json.load(f)
    return _recover_uncommitted_dispatch(root_path, state)


def check_workspace_config(repo_dir: Path) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Check workspace configuration existence and validity."""
    config_file = repo_dir / ".paper-craft" / "workspace-config.json"
    if not config_file.exists():
        return False, f"Workspace configuration missing at {config_file}", None

    try:
        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return False, f"Workspace configuration corrupted at {config_file}: {e}", None

    if validate_workspace_config:
        errors = validate_workspace_config(data, repo_dir)
        if errors:
            return False, f"Invalid workspace configuration:\n  - " + "\n  - ".join(errors), None

    return True, "Workspace configuration valid", data


def init_workflow(
    receipt_root: Path | str,
    root_issue: str | int,
    current_issue: Optional[str | int] = None,
    workflow: str = "default",
    initial_stage: Optional[str] = None,
    repo_dir: Path | str = ".",
    force: bool = False,
    require_config: bool = False,
    delivery_attempts_max: int = 3,
    replans_max: int = 2,
    child_issues: Optional[List[Any]] = None,
    plan: Optional[Any] = None,
) -> Dict[str, Any]:
    """Initialize workflow runtime state in <receipt_root>/state.json."""
    root_path = Path(receipt_root).resolve()
    state_file = root_path / "state.json"
    repo_path = Path(repo_dir).resolve()

    # Workspace configuration check
    cfg_ok, cfg_msg, cfg_data = check_workspace_config(repo_path)
    if require_config and not cfg_ok:
        raise ValueError(cfg_msg)

    # Idempotency and collision check
    if state_file.exists() and not force:
        with open(state_file, "r", encoding="utf-8") as f:
            existing = json.load(f)
        if str(existing.get("root_issue_id")) == str(root_issue):
            return existing
        raise FileExistsError(
            f"State file already exists for root issue {existing.get('root_issue_id')} at {state_file}. Use --force to overwrite."
        )

    now = datetime.now(timezone.utc).isoformat()
    context: Dict[str, Any] = {}
    if cfg_ok and cfg_data:
        context["repository"] = cfg_data.get("delivery_target") or "local/repo"
        context["base_branch"] = cfg_data.get("base_branch") or "main"
        context["delivery_target"] = cfg_data.get("delivery_target")
        context["base_remote"] = cfg_data.get("base_remote")
        context["push_remote"] = cfg_data.get("push_remote")
        context["worktree_container"] = cfg_data.get("worktree_container")

    # Resolve child issues / plan if provided
    child_ids: Optional[List[str]] = None
    if child_issues:
        child_ids = validate_plan_order(child_issues)
    elif plan:
        plan_obj = json.loads(plan) if isinstance(plan, str) else plan
        tasks = plan_obj.get("tasks", []) if isinstance(plan_obj, dict) else plan_obj
        child_ids = validate_plan_order(tasks)

    resolved_current_issue = str(current_issue or (child_ids[0] if child_ids else root_issue))
    resolved_current_stage = initial_stage or ("stage_2_work" if child_ids else "stage_1_plan")

    delivery_sequence: Optional[Dict[str, Any]] = None
    if child_ids:
        items = []
        for cid in child_ids:
            items.append({
                "issue_id": cid,
                "stage": "stage_2_work",
                "status": "pending",
                "budgets": {
                    "delivery_attempts_used": 0,
                    "delivery_attempts_max": delivery_attempts_max,
                },
                "landed": False,
            })
        delivery_sequence = {
            "items": items,
            "current_index": 0,
            "completed": False,
        }
    elif initial_stage in ("stage_2_work", "issue_work") or (current_issue and str(current_issue) != str(root_issue)):
        curr = str(current_issue or root_issue)
        delivery_sequence = {
            "items": [{
                "issue_id": curr,
                "stage": "stage_2_work",
                "status": "pending",
                "budgets": {
                    "delivery_attempts_used": 0,
                    "delivery_attempts_max": delivery_attempts_max,
                },
                "landed": False,
            }],
            "current_index": 0,
            "completed": False,
        }

    state = {
        "schema_version": "1.0",
        "root_issue_id": str(root_issue),
        "current_issue_id": resolved_current_issue,
        "workflow": workflow,
        "current_stage": resolved_current_stage,
        "stage_status": "pending",
        "next_step_index": 1,
        "active_dispatch": None,
        "completed_stages": [],
        "decisions": [],
        "budgets": {
            "delivery_attempts_used": 0,
            "delivery_attempts_max": delivery_attempts_max,
            "replans_used": 0,
            "replans_max": replans_max,
        },
        "context": context,
        "last_updated": now,
    }
    if delivery_sequence:
        state["delivery_sequence"] = delivery_sequence

    atomic_write_json(state_file, state)
    return state


def prepare_task(
    receipt_root: Path | str,
    stage: str,
    objective: str,
    provider_type: str,
    provider_target: str,
    provider_args: Optional[List[str]] = None,
    acceptance_criteria: Optional[List[str]] = None,
    predecessor_receipts: Optional[List[str]] = None,
    workdir: Optional[str] = None,
    scope: str = "",
    parameters: Optional[Dict[str, Any]] = None,
    attempt_intent: str = "same",
    branch: Optional[str] = None,
    commit: Optional[str] = None,
    receipt_template: str = DEFAULT_RECEIPT_TEMPLATE,
) -> Dict[str, Any]:
    """Prepare a fixed task dispatch, generate envelope, and assign receipt path."""
    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

    # Check workflow halt status
    if state.get("stage_status") == "halted" or state.get("orchestrator_decision") == "halt":
        raise RuntimeError("Cannot prepare task: Workflow is halted. Run 'resolve --decision continue' to resume first.")

    # Context & Environment
    context = state.get("context", {})
    resolved_workdir = str(workdir or context.get("worktree") or context.get("working_directory") or Path.cwd())
    resolved_branch = branch or context.get("branch")
    resolved_commit = commit or context.get("commit")

    # Validate active dispatch
    active = state.get("active_dispatch")
    if active:
        if active.get("status") in ("handed_off", "running"):
            raise RuntimeError(
                f"Cannot prepare task: Active dispatch '{active.get('dispatch_id')}' has already been handed off to execution. "
                "Complete or resolve it first."
            )
        # Check idempotency vs conflict
        req = active.get("request", {})
        if (
            active.get("task_name") == stage
            and req.get("objective") == objective
            and req.get("provider", {}).get("type") == provider_type
            and req.get("provider", {}).get("target") == provider_target
            and req.get("provider", {}).get("args", []) == (provider_args or [])
            and req.get("acceptance_criteria", []) == (acceptance_criteria or [])
            and req.get("predecessors", []) == (predecessor_receipts or [])
            and req.get("working_directory") == resolved_workdir
            and req.get("branch") == resolved_branch
            and req.get("commit") == resolved_commit
        ):
            return {
                "dispatch_id": active["dispatch_id"],
                "step_index": active["step_index"],
                "envelope_path": active["envelope_path"],
                "receipt_path": active["receipt_path"],
                "attempt": active["attempt"],
                "status": active["status"],
            }
        raise RuntimeError(
            f"Cannot prepare task: Active dispatch '{active.get('dispatch_id')}' is already pending. "
            "Resolve or complete it before preparing a different task."
        )

    # Determine attempt and budget
    delivery_seq = state.get("delivery_sequence")
    curr_item = None
    if delivery_seq and not delivery_seq.get("completed", False) and not is_plan_stage(stage):
        curr_idx = delivery_seq.get("current_index", 0)
        items = delivery_seq.get("items", [])
        if curr_idx < len(items):
            curr_item = items[curr_idx]
            curr_issue = curr_item["issue_id"]
            state["current_issue_id"] = curr_issue
        else:
            curr_issue = state.get("current_issue_id", state.get("root_issue_id", "0"))
    elif is_plan_stage(stage):
        curr_issue = state.get("root_issue_id", "0")
    else:
        curr_issue = state.get("current_issue_id", state.get("root_issue_id", "0"))

    budgets = state.get("budgets", {})
    if curr_item is not None:
        item_budgets = curr_item.setdefault("budgets", {})
        used_attempts = item_budgets.get("delivery_attempts_used", 0)
        max_attempts = item_budgets.get("delivery_attempts_max", budgets.get("delivery_attempts_max", 3))

        if max_attempts <= 0:
            raise RuntimeError(f"Budget exceeded: delivery attempts max ({max_attempts}) is exhausted for issue {curr_issue}.")

        if is_auxiliary_stage(stage):
            new_attempt = max(1, used_attempts)
        elif used_attempts == 0:
            if used_attempts >= max_attempts:
                raise RuntimeError(f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts}) for issue {curr_issue}.")
            new_attempt = 1
            item_budgets["delivery_attempts_used"] = 1
        elif attempt_intent in ("new", "new_attempt"):
            if used_attempts >= max_attempts:
                raise RuntimeError(f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts}) for issue {curr_issue}.")
            new_attempt = used_attempts + 1
            item_budgets["delivery_attempts_used"] = new_attempt
        else:
            new_attempt = used_attempts

        budgets["delivery_attempts_used"] = item_budgets["delivery_attempts_used"]
        budgets["delivery_attempts_max"] = max_attempts
        state["budgets"] = budgets
    else:
        used_attempts = budgets.get("delivery_attempts_used", 0)
        max_attempts = budgets.get("delivery_attempts_max", 3)

        if max_attempts <= 0:
            raise RuntimeError(
                f"Budget exceeded: delivery attempts max ({max_attempts}) is exhausted."
            )

        if is_auxiliary_stage(stage):
            new_attempt = max(1, used_attempts)
        elif used_attempts == 0:
            if used_attempts >= max_attempts:
                raise RuntimeError(
                    f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts})."
                )
            new_attempt = 1
            budgets["delivery_attempts_used"] = 1
        elif attempt_intent in ("new", "new_attempt"):
            if used_attempts >= max_attempts:
                raise RuntimeError(
                    f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts})."
                )
            new_attempt = used_attempts + 1
            budgets["delivery_attempts_used"] = new_attempt
        else:
            new_attempt = used_attempts
        state["budgets"] = budgets

    # Step index
    step_index = state.get("next_step_index", 1)
    state["next_step_index"] = step_index + 1

    # Paths and names
    root_issue = state.get("root_issue_id", "0")
    dispatch_id = f"{step_index:02d}-{stage}-issue-{curr_issue}-try-{new_attempt}"
    receipt_filename = f"{dispatch_id}.md"
    receipt_path = receipt_root_path / receipt_filename
    envelope_filename = f"{step_index:02d}-input.json"
    envelope_path = receipt_root_path / envelope_filename

    # Resolve environment and parameters
    repo = context.get("repository", "local/repo")
    base_branch = context.get("base_branch", "main")

    resolved_predecessors = list(predecessor_receipts or [])
    if not resolved_predecessors and state.get("completed_stages"):
        latest_completed = state["completed_stages"][-1]
        rec = latest_completed.get("receipt_path")
        if rec:
            resolved_predecessors.append(rec)

    params = dict(parameters or {})
    if "delivery_target" not in params and context.get("delivery_target"):
        params["delivery_target"] = context["delivery_target"]
    if "base_remote" not in params and context.get("base_remote"):
        params["base_remote"] = context["base_remote"]
    if "push_remote" not in params and context.get("push_remote"):
        params["push_remote"] = context["push_remote"]
    if "worktree_container" not in params and context.get("worktree_container"):
        params["worktree_container"] = context["worktree_container"]

    if not context.get("delivery_target"):
        cfg_ok, _, cfg_data = check_workspace_config(Path(resolved_workdir))
        if cfg_ok and cfg_data:
            if repo == "local/repo" and cfg_data.get("delivery_target"):
                repo = cfg_data["delivery_target"]
            if base_branch == "main" and cfg_data.get("base_branch"):
                base_branch = cfg_data["base_branch"]
            if "delivery_target" not in params and cfg_data.get("delivery_target"):
                params["delivery_target"] = cfg_data["delivery_target"]
            if "base_remote" not in params and cfg_data.get("base_remote"):
                params["base_remote"] = cfg_data["base_remote"]
            if "push_remote" not in params and cfg_data.get("push_remote"):
                params["push_remote"] = cfg_data["push_remote"]
            if "worktree_container" not in params and cfg_data.get("worktree_container"):
                params["worktree_container"] = cfg_data["worktree_container"]

    envelope_data = {
        "schema_version": "1.0",
        "task": {
            "logical_stage": stage,
            "step_index": step_index,
            "attempt": new_attempt,
            "root_issue_id": str(root_issue),
            "current_issue_id": str(curr_issue),
        },
        "provider": {
            "type": provider_type,
            "target": provider_target,
            "args": provider_args or [],
        },
        "environment": {
            "working_directory": str(resolved_workdir),
            "repository": repo,
            "base_branch": base_branch,
            "branch": resolved_branch,
            "commit": resolved_commit,
        },
        "inputs": {
            "objective": objective,
            "scope": scope,
            "acceptance_criteria": acceptance_criteria or [],
            "predecessor_receipts": resolved_predecessors,
            "parameters": params,
        },
        "contract": {
            "receipt_path": str(receipt_path),
            "receipt_template": receipt_template,
        },
        "budgets": {
            "delivery_attempts_used": budgets["delivery_attempts_used"],
            "delivery_attempts_max": max_attempts,
            "delivery_attempts_limit": max_attempts,
            "replans_used": budgets.get("replans_used", 0),
            "replans_max": budgets.get("replans_max", 2),
            "replans_limit": budgets.get("replans_max", 2),
        },
    }

    errors = validate_envelope(envelope_data)
    if errors:
        raise ValueError("Generated envelope schema validation failed:\n  - " + "\n  - ".join(errors))

    atomic_write_json(envelope_path, envelope_data)

    state["current_stage"] = stage
    state["stage_status"] = "pending"
    state["active_dispatch"] = {
        "dispatch_id": dispatch_id,
        "step_index": step_index,
        "task_name": stage,
        "issue_id": str(curr_issue),
        "attempt": new_attempt,
        "status": "prepared",
        "authorized": False,
        "envelope_path": str(envelope_path),
        "receipt_path": str(receipt_path),
        "request": {
            "objective": objective,
            "provider": {
                "type": provider_type,
                "target": provider_target,
                "args": provider_args or [],
            },
            "logical_stage": stage,
            "acceptance_criteria": acceptance_criteria or [],
            "predecessors": resolved_predecessors,
            "working_directory": resolved_workdir,
            "branch": resolved_branch,
            "commit": resolved_commit,
        },
    }
    state["last_updated"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(get_state_file_path(receipt_root_path), state)

    return {
        "dispatch_id": dispatch_id,
        "step_index": step_index,
        "envelope_path": str(envelope_path),
        "receipt_path": str(receipt_path),
        "attempt": new_attempt,
        "status": "prepared",
    }


def handoff_dispatch(
    receipt_root: Path | str,
    dispatch_id: Optional[str] = None,
    platform_handle: Optional[str] = None,
) -> Dict[str, Any]:
    """Record boundary of external execution launch authorization."""
    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

    # Check workflow halt status
    if state.get("stage_status") == "halted" or state.get("orchestrator_decision") == "halt":
        raise RuntimeError("Cannot handoff dispatch: Workflow is halted. Run 'resolve --decision continue' to resume first.")

    active = state.get("active_dispatch")
    if not active:
        raise RuntimeError("No active dispatch found to hand off. Run 'prepare' first.")

    if dispatch_id and active.get("dispatch_id") != dispatch_id:
        raise ValueError(
            f"Active dispatch ID '{active.get('dispatch_id')}' does not match requested dispatch ID '{dispatch_id}'."
        )

    # First valid call: grants launch authorization
    if active.get("status") == "prepared" and not active.get("authorized", False):
        active["status"] = "handed_off"
        active["authorized"] = True
        if platform_handle:
            active["platform_handle"] = platform_handle
        active["handed_off_at"] = datetime.now(timezone.utc).isoformat()
        state["stage_status"] = "in_progress"
        state["last_updated"] = datetime.now(timezone.utc).isoformat()
        atomic_write_json(get_state_file_path(receipt_root_path), state)
        return {
            "authorized": True,
            "dispatch_id": active["dispatch_id"],
            "status": "handed_off",
            "platform_handle": active.get("platform_handle"),
            "envelope_path": active["envelope_path"],
            "receipt_path": active["receipt_path"],
            "message": "Execution launch authorized.",
        }

    # Subsequent call or query: does NOT grant new launch permission
    return {
        "authorized": False,
        "dispatch_id": active["dispatch_id"],
        "status": active.get("status", "unknown"),
        "platform_handle": active.get("platform_handle"),
        "envelope_path": active["envelope_path"],
        "receipt_path": active["receipt_path"],
        "message": "Dispatch was already authorized previously. New launch authorization not granted.",
    }


def complete_dispatch(
    receipt_root: Path | str,
    report: Dict[str, Any] | str,
    dispatch_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Register compact execution report and verify physical receipt on disk."""
    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

    # Parse report if str
    if isinstance(report, str):
        report_str = report.strip()
        if report_str.startswith("{"):
            try:
                report_data = json.loads(report_str)
            except Exception as e:
                err_msg = f"Invalid compact report JSON: {e}"
                _record_protocol_error(receipt_root_path, state, "invalid_json", err_msg)
                raise ValueError(err_msg)
        else:
            report_file = Path(report_str).resolve()
            if not report_file.exists():
                err_msg = f"Report file not found: {report_file}"
                _record_protocol_error(receipt_root_path, state, "report_file_missing", err_msg)
                raise FileNotFoundError(err_msg)
            try:
                with open(report_file, "r", encoding="utf-8") as f:
                    report_data = json.load(f)
            except Exception as e:
                err_msg = f"Invalid report file JSON: {e}"
                _record_protocol_error(receipt_root_path, state, "invalid_json", err_msg)
                raise ValueError(err_msg)
    elif isinstance(report, dict):
        report_data = report
    else:
        err_msg = "Report must be a JSON object dictionary or JSON string."
        _record_protocol_error(receipt_root_path, state, "invalid_report_type", err_msg)
        raise TypeError(err_msg)

    # Validate 4 required fields
    required_keys = ["execution_status", "result", "receipt_path", "summary"]
    for k in required_keys:
        if k not in report_data:
            err_msg = f"Compact execution report missing required field: '{k}'"
            _record_protocol_error(receipt_root_path, state, "missing_field", err_msg)
            raise ValueError(err_msg)

    status = report_data["execution_status"]
    if status not in ("succeeded", "failed", "blocked"):
        err_msg = f"Invalid execution_status '{status}'. Expected 'succeeded' | 'failed' | 'blocked'."
        _record_protocol_error(receipt_root_path, state, "invalid_status", err_msg)
        raise ValueError(err_msg)

    if not isinstance(report_data["result"], dict):
        err_msg = f"Field 'result' must be a JSON object (dict), got {type(report_data['result']).__name__}."
        _record_protocol_error(receipt_root_path, state, "invalid_result", err_msg)
        raise ValueError(err_msg)

    if not isinstance(report_data["receipt_path"], str) or not report_data["receipt_path"].strip():
        err_msg = "Field 'receipt_path' must be a non-empty string."
        _record_protocol_error(receipt_root_path, state, "invalid_receipt_path", err_msg)
        raise ValueError(err_msg)

    if not isinstance(report_data["summary"], str) or not report_data["summary"].strip():
        err_msg = "Field 'summary' must be a non-empty string."
        _record_protocol_error(receipt_root_path, state, "invalid_summary", err_msg)
        raise ValueError(err_msg)

    active = state.get("active_dispatch")
    completed_stages = state.get("completed_stages", [])

    # Idempotency and conflict check if already completed
    if not active:
        matching_settled = None
        report_resolved_receipt = str(Path(report_data["receipt_path"]).resolve())
        for c in reversed(completed_stages):
            if dispatch_id and c.get("dispatch_id") == dispatch_id:
                matching_settled = c
                break
            elif not dispatch_id and c.get("receipt_path") == report_resolved_receipt:
                matching_settled = c
                break

        if matching_settled:
            if (
                matching_settled.get("execution_status") == status
                and matching_settled.get("result") == report_data["result"]
            ):
                return matching_settled
            else:
                err_msg = (
                    f"Conflicting report for already settled dispatch '{matching_settled.get('dispatch_id')}': "
                    "execution_status or result differs."
                )
                _record_protocol_error(receipt_root_path, state, "report_conflict", err_msg)
                raise RuntimeError(err_msg)

        err_msg = "No active dispatch in flight to complete."
        _record_protocol_error(receipt_root_path, state, "no_active_dispatch", err_msg)
        raise RuntimeError(err_msg)

    if dispatch_id and active.get("dispatch_id") != dispatch_id:
        err_msg = f"Active dispatch ID '{active.get('dispatch_id')}' does not match requested '{dispatch_id}'."
        _record_protocol_error(receipt_root_path, state, "dispatch_mismatch", err_msg)
        raise ValueError(err_msg)

    if active.get("status") != "handed_off":
        err_msg = (
            f"Cannot complete dispatch '{active.get('dispatch_id')}': task has not been handed off to execution. "
            "Run 'handoff' first."
        )
        _record_protocol_error(receipt_root_path, state, "not_handed_off", err_msg)
        raise RuntimeError(err_msg)

    # Verify physical receipt on disk
    assigned_receipt = Path(active["receipt_path"]).resolve()
    report_receipt = Path(report_data["receipt_path"]).resolve()
    if assigned_receipt != report_receipt:
        err_msg = (
            f"Report receipt_path '{report_data['receipt_path']}' does not match assigned receipt_path '{active['receipt_path']}'."
        )
        _record_protocol_error(receipt_root_path, state, "receipt_mismatch", err_msg)
        raise ValueError(err_msg)

    if not assigned_receipt.exists():
        err_msg = f"Receipt file missing on disk at: {assigned_receipt}"
        _record_protocol_error(receipt_root_path, state, "receipt_missing", err_msg)
        raise FileNotFoundError(err_msg)

    if assigned_receipt.stat().st_size == 0:
        err_msg = f"Receipt file at {assigned_receipt} is empty (0 bytes)."
        _record_protocol_error(receipt_root_path, state, "receipt_empty", err_msg)
        raise ValueError(err_msg)

    stage_name = active["task_name"]
    outcome = report_data.get("result", {}).get("outcome")

    # If this is a planning stage decomposing into child issues, validate plan order first
    child_ids: Optional[List[str]] = None
    if is_plan_stage(stage_name) and status == "succeeded" and outcome == "decomposed":
        plan_data = report_data.get("result", {}).get("plan")
        if isinstance(plan_data, str):
            try:
                plan_data = json.loads(plan_data)
            except Exception as e:
                err_msg = f"Invalid plan JSON: {e}"
                _record_protocol_error(receipt_root_path, state, "invalid_plan", err_msg)
                raise ValueError(err_msg)
        if isinstance(plan_data, dict):
            raw_tasks = plan_data.get("tasks", [])
        elif isinstance(plan_data, list):
            raw_tasks = plan_data
        else:
            raw_tasks = report_data.get("result", {}).get("issues") or []

        try:
            child_ids = validate_plan_order(raw_tasks)
        except ValueError as e:
            _record_protocol_error(receipt_root_path, state, "invalid_plan", str(e))
            raise ValueError(str(e))

    # Record completion
    now = datetime.now(timezone.utc).isoformat()
    completed_entry = {
        "dispatch_id": active["dispatch_id"],
        "step_index": active["step_index"],
        "stage": active["task_name"],
        "attempt": active["attempt"],
        "execution_status": status,
        "result": report_data["result"],
        "receipt_path": str(assigned_receipt),
        "summary": report_data["summary"],
        "completed_at": now,
    }

    state.setdefault("completed_stages", []).append(completed_entry)
    state["active_dispatch"] = None
    state["protocol_error"] = None

    # Delivery sequence progression
    if is_plan_stage(stage_name) and status == "succeeded":
        if outcome == "decomposed":
            assert child_ids is not None
            del_max = state.get("budgets", {}).get("delivery_attempts_max", 3)
            items = []
            for cid in child_ids:
                items.append({
                    "issue_id": cid,
                    "stage": "stage_2_work",
                    "status": "pending",
                    "budgets": {
                        "delivery_attempts_used": 0,
                        "delivery_attempts_max": del_max,
                    },
                    "landed": False,
                })
            state["delivery_sequence"] = {
                "items": items,
                "current_index": 0,
                "completed": False,
            }
            state["current_issue_id"] = child_ids[0]
            state["current_stage"] = "stage_2_work"
            state["stage_status"] = "succeeded"
            state["budgets"]["delivery_attempts_used"] = 0

        elif outcome == "direct":
            root_id = str(state.get("root_issue_id", "0"))
            del_max = state.get("budgets", {}).get("delivery_attempts_max", 3)
            items = [{
                "issue_id": root_id,
                "stage": "stage_2_work",
                "status": "pending",
                "budgets": {
                    "delivery_attempts_used": 0,
                    "delivery_attempts_max": del_max,
                },
                "landed": False,
            }]
            state["delivery_sequence"] = {
                "items": items,
                "current_index": 0,
                "completed": False,
            }
            state["current_issue_id"] = root_id
            state["current_stage"] = "stage_2_work"
            state["stage_status"] = "succeeded"
            state["budgets"]["delivery_attempts_used"] = 0
        else:
            state["stage_status"] = status

    elif state.get("delivery_sequence") and not state["delivery_sequence"].get("completed", False):
        del_seq = state["delivery_sequence"]
        curr_idx = del_seq.get("current_index", 0)
        items = del_seq.get("items", [])
        if curr_idx < len(items):
            curr_item = items[curr_idx]

            if is_auxiliary_stage(stage_name):
                # Auxiliary preparation does NOT advance sequence!
                state["current_stage"] = curr_item["stage"]
                state["current_issue_id"] = curr_item["issue_id"]
                state["stage_status"] = status
            elif is_work_stage(stage_name):
                if is_effective_work_outcome(status, report_data.get("result", {})):
                    curr_item["stage"] = "stage_2_land"
                    curr_item["status"] = "in_progress"
                    curr_item["work_dispatch_id"] = active["dispatch_id"]
                    curr_item["work_receipt_path"] = str(assigned_receipt)
                    state["current_stage"] = "stage_2_land"
                    state["current_issue_id"] = curr_item["issue_id"]
                    state["stage_status"] = status
                else:
                    curr_item["status"] = "needs_rework" if outcome == "rework_needed" else ("failed" if status == "failed" else "blocked")
                    state["current_stage"] = "stage_2_work"
                    state["current_issue_id"] = curr_item["issue_id"]
                    state["stage_status"] = curr_item["status"]
            elif is_land_stage(stage_name):
                if status == "succeeded" and is_landed_outcome(report_data.get("result", {})):
                    curr_item["stage"] = "landed"
                    curr_item["status"] = "landed"
                    curr_item["landed"] = True
                    curr_item["land_dispatch_id"] = active["dispatch_id"]
                    curr_item["land_receipt_path"] = str(assigned_receipt)

                    if curr_idx + 1 < len(items):
                        del_seq["current_index"] = curr_idx + 1
                        next_item = items[curr_idx + 1]
                        state["current_issue_id"] = next_item["issue_id"]
                        state["current_stage"] = next_item["stage"]
                        state["stage_status"] = "pending"
                        next_budgets = next_item.setdefault("budgets", {})
                        state["budgets"]["delivery_attempts_used"] = next_budgets.get("delivery_attempts_used", 0)
                        state["budgets"]["delivery_attempts_max"] = next_budgets.get("delivery_attempts_max", state.get("budgets", {}).get("delivery_attempts_max", 3))
                    else:
                        del_seq["completed"] = True
                        state["current_issue_id"] = str(state.get("root_issue_id", "0"))
                        state["current_stage"] = "stage_3_verify"
                        state["stage_status"] = "succeeded"
                        state["budgets"]["delivery_attempts_used"] = 0
                else:
                    curr_item["status"] = "needs_rework" if outcome == "rework_needed" else ("failed" if status == "failed" else "blocked")
                    state["current_stage"] = "stage_2_land"
                    state["current_issue_id"] = curr_item["issue_id"]
                    state["stage_status"] = curr_item["status"]
            else:
                if outcome == "rework_needed":
                    state["stage_status"] = "needs_rework"
                else:
                    state["stage_status"] = status
    else:
        if outcome == "rework_needed":
            state["stage_status"] = "needs_rework"
        else:
            state["stage_status"] = status
    state["last_updated"] = now
    atomic_write_json(get_state_file_path(receipt_root_path), state)

    return completed_entry


def resolve_decision(
    receipt_root: Path | str,
    decision: str,
    reason: str,
    options: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Record orchestrator decisions (wait_user, continue, halt, finish)."""
    valid_decisions = ("wait_user", "continue", "halt", "finish")
    if decision not in valid_decisions:
        raise ValueError(f"Invalid decision '{decision}'. Expected one of {valid_decisions}.")

    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

    # Guard rules for finish
    if decision == "finish":
        active = state.get("active_dispatch")
        if active:
            raise RuntimeError(
                f"Cannot finish workflow: active dispatch '{active.get('dispatch_id')}' is still in flight."
            )
        if state.get("protocol_error"):
            raise RuntimeError(
                f"Cannot finish workflow: active protocol error exists: {state['protocol_error']['message']}"
            )
        completed_stages = state.get("completed_stages", [])
        if completed_stages and completed_stages[-1].get("result", {}).get("outcome") == "rework_needed":
            raise RuntimeError(
                f"Cannot finish workflow: last completed stage '{completed_stages[-1].get('stage')}' resulted in "
                "'rework_needed', which is not accepted as business pass. Rework must be routed."
            )

    if decision == "finish" and state.get("workflow", "default") == "default":
        stages = state.get("completed_stages", [])
        finalizations = [entry for entry in stages if entry.get("stage") == "issue_finalize"
                         and entry.get("execution_status") == "succeeded"
                         and entry.get("result", {}).get("scope") == "tree"]
        closure = finalizations[-1] if finalizations else {}
        evidence = closure.get("result", {})
        issues = evidence.get("issues", [])
        root = str(state["root_issue_id"])
        if (evidence.get("outcome") != "finalized" or str(evidence.get("root_issue_id")) != root
                or not isinstance(issues, list) or not issues
                or not all(isinstance(issue, dict) and issue.get("state") == "CLOSED"
                           and issue.get("repository") and issue.get("acceptance_receipt") for issue in issues)
                or not any(str(issue.get("number")) == root for issue in issues)):
            raise RuntimeError("Cannot finish workflow: verified issue-tree closure evidence is missing.")
        latest = stages[-1] if stages else {}
        result = latest.get("result", {})
        if (latest.get("stage") != "workspace_cleanup" or latest.get("execution_status") != "succeeded"
                or result.get("outcome") != "cleaned" or result.get("retained_paths") != []
                or result.get("retained_branches") != [] or evidence.get("unresolved") != []
                or latest.get("step_index", -1) <= closure.get("step_index", -1)):
            raise RuntimeError("Cannot finish workflow: delivery complete / cleanup incomplete.")
        candidates = evidence.get("candidates")
        if not isinstance(candidates, list):
            raise RuntimeError("Cannot finish workflow: reconciled cleanup inventory is missing.")
        cleanup_results = [entry.get("result", {}) for entry in stages[stages.index(closure) + 1:]
                           if entry.get("stage") == "workspace_cleanup" and entry.get("execution_status") == "succeeded"]
        paths = {path for item in cleanup_results for path in item.get("removed_paths", [])}
        branches = {(item.get("branch"), item.get("scope"), item.get("remote"))
                    for report in cleanup_results for item in report.get("removed_branches", [])}
        for candidate in candidates:
            branch = candidate.get("branch")
            if ((candidate.get("worktree") and candidate["worktree"] not in paths)
                    or (branch and ((branch, "local", None) not in branches
                                    or (branch, "remote", candidate.get("push_remote")) not in branches))):
                raise RuntimeError("Cannot finish workflow: reconciled resource lacks cleanup evidence.")
        # Any delivery or verification after closure invalidates the final reconciliation.
        if any(entry.get("stage") != "workspace_cleanup"
               for entry in stages[stages.index(closure) + 1:]):
            raise RuntimeError("Cannot finish workflow: repeat issue finalization after intervening work.")

    now = datetime.now(timezone.utc).isoformat()
    record = {
        "decision": decision,
        "reason": reason,
        "options": options or [],
        "timestamp": now,
    }

    state.setdefault("decisions", []).append(record)
    state["orchestrator_decision"] = decision

    if decision == "halt":
        state["stage_status"] = "halted"
    elif decision == "wait_user":
        state["stage_status"] = "blocked"
    elif decision == "finish":
        state["stage_status"] = "succeeded"
        state["current_stage"] = "completed"
    elif decision == "continue":
        # Resuming from wait cannot bypass unconfirmed external execution
        active = state.get("active_dispatch")
        if active and active.get("status") in ("handed_off", "running"):
            state["stage_status"] = "in_progress"
        else:
            state["stage_status"] = "pending"

    state["last_updated"] = now
    atomic_write_json(get_state_file_path(receipt_root_path), state)

    return record


def inspect_state(
    receipt_root: Path | str,
    field: Optional[str] = None,
) -> Dict[str, Any]:
    """Query current state, active dispatch, orchestrator decisions, budgets, and blocking reasons."""
    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

    budgets = state.get("budgets", {})
    used_attempts = budgets.get("delivery_attempts_used", 0)
    max_attempts = budgets.get("delivery_attempts_max", 3)
    used_replans = budgets.get("replans_used", 0)
    max_replans = budgets.get("replans_max", 2)

    active = state.get("active_dispatch")
    decisions = state.get("decisions", [])
    completed_stages = state.get("completed_stages", [])

    blocking_reasons: List[str] = []

    proto_err = state.get("protocol_error")
    if proto_err:
        blocking_reasons.append(
            f"Protocol error [{proto_err.get('error_type')}]: {proto_err.get('message')}"
        )

    if active:
        status = active.get("status")
        disp_id = active.get("dispatch_id")
        if status == "prepared":
            blocking_reasons.append(
                f"Active dispatch '{disp_id}' is prepared but not yet handed off to execution."
            )
        elif status in ("handed_off", "running"):
            blocking_reasons.append(
                f"Active dispatch '{disp_id}' was handed off and execution outcome is unconfirmed/in flight; awaiting completion report and durable receipt. Kernel will not auto-re-execute."
            )
        else:
            blocking_reasons.append(
                f"Active dispatch '{disp_id}' is pending in status '{status}'."
            )

    if used_attempts >= max_attempts:
        blocking_reasons.append(
            f"Delivery attempt budget exhausted: {used_attempts}/{max_attempts} attempts used."
        )

    if used_replans >= max_replans:
        blocking_reasons.append(
            f"Replan budget exhausted: {used_replans}/{max_replans} replans used."
        )

    stage_status = state.get("stage_status")
    if stage_status == "halted":
        last_reason = decisions[-1].get("reason", "") if decisions else "Workflow halted"
        blocking_reasons.append(f"Workflow is halted: {last_reason}")
    elif stage_status == "blocked":
        last_reason = decisions[-1].get("reason", "") if decisions else "Awaiting user input or prerequisite"
        blocking_reasons.append(f"Workflow is blocked: {last_reason}")
    elif stage_status == "needs_rework":
        last_outcome = completed_stages[-1].get("result", {}).get("outcome") if completed_stages else "rework_needed"
        blocking_reasons.append(
            f"Stage produced outcome '{last_outcome}'; awaiting orchestrator rework routing, not accepted as business pass."
        )

    info = {
        "workflow": state.get("workflow", "default"),
        "root_issue_id": state.get("root_issue_id"),
        "current_issue_id": state.get("current_issue_id"),
        "current_stage": state.get("current_stage"),
        "stage_status": stage_status,
        "active_dispatch": active,
        "last_decision": decisions[-1] if decisions else None,
        "protocol_error": proto_err,
        "budgets": budgets,
        "completed_stages_count": len(completed_stages),
        "blocking_reasons": blocking_reasons,
        "last_updated": state.get("last_updated"),
    }
    if state.get("delivery_sequence"):
        info["delivery_sequence"] = state["delivery_sequence"]

    if field:
        val: Any = state
        for part in field.split("."):
            if isinstance(val, dict) and part in val:
                val = val[part]
            else:
                raise KeyError(f"Field '{field}' not found in state.")
        return val

    return info


def load_prepare_request(request_path: str) -> Dict[str, Any]:
    """Validate an absolute JSON request file and return prepare_task keyword arguments.

    Validation happens before loading workflow state, which can perform crash recovery.
    Provider arguments are preserved as individual string tokens.
    """
    path = Path(request_path)
    if not path.is_absolute():
        raise ValueError(f"Request path must be absolute, received {request_path!r}")
    with path.open("r", encoding="utf-8") as request_file:
        request = json.load(request_file)
    if not isinstance(request, dict):
        raise ValueError(f"Prepare request must be a JSON object, received {request!r}")

    allowed_fields = {
        "stage", "objective", "provider", "acceptance_criteria", "predecessor_receipts",
        "workdir", "scope", "attempt_intent", "branch", "commit", "receipt_template",
    }
    unknown = request.keys() - allowed_fields
    if unknown:
        raise ValueError(f"Unknown prepare request fields: {', '.join(sorted(unknown))}")
    for field in ("stage", "objective", "provider"):
        if field not in request:
            raise ValueError(f"Prepare request missing required field {field!r}")
    for field in ("stage", "objective", "workdir", "scope", "branch", "commit", "receipt_template"):
        if field in request:
            value = request[field]
            if not isinstance(value, str) or (field != "scope" and not value.strip()):
                expected = "a string" if field == "scope" else "a non-empty string"
                raise ValueError(f"Request {field!r} must be {expected}, received {value!r}")
    if "attempt_intent" in request and request["attempt_intent"] not in ("same", "new"):
        raise ValueError(f"Request 'attempt_intent' must be 'same' or 'new', received {request['attempt_intent']!r}")

    provider = request["provider"]
    if not isinstance(provider, dict):
        raise ValueError(f"Request 'provider' must be an object, received {provider!r}")
    unknown = provider.keys() - {"type", "target", "args"}
    if unknown:
        raise ValueError(f"Unknown provider fields: {', '.join(sorted(unknown))}")
    if provider.get("type") not in ("skill", "script"):
        raise ValueError(f"Provider 'type' must be 'skill' or 'script', received {provider.get('type')!r}")
    target = provider.get("target")
    if not isinstance(target, str) or not target.strip():
        raise ValueError(f"Provider 'target' must be a non-empty string, received {target!r}")
    for field, value in (
        ("provider.args", provider.get("args", [])),
        ("acceptance_criteria", request.get("acceptance_criteria", [])),
        ("predecessor_receipts", request.get("predecessor_receipts", [])),
    ):
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError(f"Request {field!r} must be an array of strings, received {value!r}")

    payload = dict(request)
    del payload["provider"]
    payload.update(provider_type=provider["type"], provider_target=target, provider_args=provider.get("args", []))
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Minimal dispatch lifecycle kernel for pc-orchestrator workflows."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # init
    p_init = subparsers.add_parser("init", help="Initialize workflow run state snapshot.")
    p_init.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_init.add_argument("--root-issue", required=True, help="Root GitHub issue number.")
    p_init.add_argument("--current-issue", help="Initial current issue number (defaults to root issue).")
    p_init.add_argument("--workflow", default="default", help="Workflow name (defaults to 'default').")
    p_init.add_argument("--initial-stage", help="Initial stage name.")
    p_init.add_argument("--force", action="store_true", help="Force overwrite existing state file.")
    p_init.add_argument("--require-config", action="store_true", help="Require valid workspace configuration.")
    p_init.add_argument("--repo-dir", default=".", help="Repository root containing .paper-craft/")
    p_init.add_argument("--delivery-attempts-max", type=int, default=3, help="Max delivery attempts.")
    p_init.add_argument("--replans-max", type=int, default=2, help="Max replans.")
    p_init.add_argument("--child-issue", dest="child_issues", action="append", default=[], help="Child issue number in planned order.")
    p_init.add_argument("--plan", help="JSON string or file path containing plan snapshot.")

    # prepare
    p_prep = subparsers.add_parser("prepare", help="Prepare a fixed task dispatch and envelope.")
    p_prep.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_prep.add_argument("--request", required=True, help="Absolute path to the prepare request JSON file.")

    # handoff
    p_hand = subparsers.add_parser("handoff", help="Record execution handoff boundary.")
    p_hand.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_hand.add_argument("--dispatch-id", help="Active dispatch ID to authorize.")
    p_hand.add_argument("--platform-handle", help="Platform handle/identifier (e.g. process ID or conversation ID).")

    # complete
    p_comp = subparsers.add_parser("complete", help="Register compact execution report and verify receipt on disk.")
    p_comp.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_comp.add_argument("--report", required=True, help="Compact execution report JSON string or file path.")
    p_comp.add_argument("--dispatch-id", help="Dispatch ID to complete.")

    # resolve
    p_res = subparsers.add_parser("resolve", help="Record orchestrator decision.")
    p_res.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_res.add_argument("--decision", required=True, choices=["wait_user", "continue", "halt", "finish"], help="Orchestrator decision.")
    p_res.add_argument("--reason", required=True, help="Reason for decision.")
    p_res.add_argument("--option", dest="options", action="append", default=[], help="Options presented (for Decision Board).")

    # inspect
    p_insp = subparsers.add_parser("inspect", help="Query current state, dispatch, decisions, and blocking reasons.")
    p_insp.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_insp.add_argument("--json", action="store_true", help="Output machine-readable JSON.")
    p_insp.add_argument("--field", help="Get a specific nested field from state.")

    args = parser.parse_args()

    try:
        if args.command == "init":
            state = init_workflow(
                receipt_root=args.receipt_root,
                root_issue=args.root_issue,
                current_issue=args.current_issue,
                workflow=args.workflow,
                initial_stage=args.initial_stage,
                repo_dir=args.repo_dir,
                force=args.force,
                require_config=args.require_config,
                delivery_attempts_max=args.delivery_attempts_max,
                replans_max=args.replans_max,
                child_issues=args.child_issues or None,
                plan=args.plan,
            )
            print(json.dumps(state, indent=2, ensure_ascii=False))
        elif args.command == "prepare":
            if not Path(args.receipt_root).is_absolute():
                raise ValueError(f"Receipt root must be absolute, received {args.receipt_root!r}")
            request = load_prepare_request(args.request)
            disp = prepare_task(receipt_root=args.receipt_root, **request)
            print(json.dumps(disp, indent=2, ensure_ascii=False))
        elif args.command == "handoff":
            res = handoff_dispatch(
                receipt_root=args.receipt_root,
                dispatch_id=args.dispatch_id,
                platform_handle=args.platform_handle,
            )
            print(json.dumps(res, indent=2, ensure_ascii=False))
        elif args.command == "complete":
            res = complete_dispatch(
                receipt_root=args.receipt_root,
                report=args.report,
                dispatch_id=args.dispatch_id,
            )
            print(json.dumps(res, indent=2, ensure_ascii=False))
        elif args.command == "resolve":
            res = resolve_decision(
                receipt_root=args.receipt_root,
                decision=args.decision,
                reason=args.reason,
                options=args.options,
            )
            print(json.dumps(res, indent=2, ensure_ascii=False))
        elif args.command == "inspect":
            res = inspect_state(
                receipt_root=args.receipt_root,
                field=args.field,
            )
            if args.json or isinstance(res, (dict, list)):
                print(json.dumps(res, indent=2, ensure_ascii=False))
            else:
                print(res)
    except Exception as e:
        sys.stderr.write(f"Error: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
