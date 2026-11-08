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

try:
    from envelope import validate_envelope, atomic_write_json
except ImportError:
    def atomic_write_json(file_path: Path, data: Dict[str, Any]) -> None:
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
        return []


def get_state_file_path(receipt_root: Path | str) -> Path:
    """Return canonical state file path in receipt root."""
    return Path(receipt_root).resolve() / "state.json"


def load_state(receipt_root: Path | str) -> Dict[str, Any]:
    """Load state.json from receipt root, exiting or raising if not found."""
    state_file = get_state_file_path(receipt_root)
    if not state_file.exists():
        raise FileNotFoundError(f"State file not found at {state_file}. Run 'init' first.")
    with open(state_file, "r", encoding="utf-8") as f:
        return json.load(f)


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

    state = {
        "schema_version": "1.0",
        "root_issue_id": str(root_issue),
        "current_issue_id": str(current_issue or root_issue),
        "workflow": workflow,
        "current_stage": initial_stage,
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
    receipt_template: str = "templates/subagent-receipt.template.md",
) -> Dict[str, Any]:
    """Prepare a fixed task dispatch, generate envelope, and assign receipt path."""
    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

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
    budgets = state.get("budgets", {})
    used_attempts = budgets.get("delivery_attempts_used", 0)
    max_attempts = budgets.get("delivery_attempts_max", 3)

    if used_attempts == 0:
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
    curr_issue = state.get("current_issue_id", root_issue)
    dispatch_id = f"{step_index:02d}-{stage}-issue-{curr_issue}-try-{new_attempt}"
    receipt_filename = f"{dispatch_id}.md"
    receipt_path = receipt_root_path / receipt_filename
    envelope_filename = f"{step_index:02d}-input.json"
    envelope_path = receipt_root_path / envelope_filename

    # Context & Environment
    context = state.get("context", {})
    resolved_workdir = workdir or context.get("worktree") or context.get("working_directory") or str(Path.cwd())
    repo = context.get("repository", "local/repo")
    base_branch = context.get("base_branch", "main")
    resolved_branch = branch or context.get("branch")
    resolved_commit = commit or context.get("commit")

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
            "predecessor_receipts": predecessor_receipts or [],
            "parameters": parameters or {},
        },
        "contract": {
            "receipt_path": str(receipt_path),
            "receipt_template": receipt_template,
        },
        "budgets": {
            "delivery_attempts_used": budgets["delivery_attempts_used"],
            "delivery_attempts_max": max_attempts,
            "replans_used": budgets.get("replans_used", 0),
            "replans_max": budgets.get("replans_max", 2),
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
            "predecessors": predecessor_receipts or [],
            "working_directory": str(resolved_workdir),
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
                raise ValueError(f"Invalid compact report JSON: {e}")
        else:
            report_file = Path(report_str).resolve()
            if not report_file.exists():
                raise FileNotFoundError(f"Report file not found: {report_file}")
            with open(report_file, "r", encoding="utf-8") as f:
                report_data = json.load(f)
    elif isinstance(report, dict):
        report_data = report
    else:
        raise TypeError("Report must be a JSON object dictionary or JSON string.")

    # Validate 4 required fields
    required_keys = ["execution_status", "result", "receipt_path", "summary"]
    for k in required_keys:
        if k not in report_data:
            raise ValueError(f"Compact execution report missing required field: '{k}'")

    status = report_data["execution_status"]
    if status not in ("succeeded", "failed", "blocked"):
        raise ValueError(
            f"Invalid execution_status '{status}'. Expected 'succeeded' | 'failed' | 'blocked'."
        )

    if not isinstance(report_data["result"], dict):
        raise ValueError(f"Field 'result' must be a JSON object (dict), got {type(report_data['result']).__name__}.")

    if not isinstance(report_data["receipt_path"], str) or not report_data["receipt_path"].strip():
        raise ValueError("Field 'receipt_path' must be a non-empty string.")

    if not isinstance(report_data["summary"], str) or not report_data["summary"].strip():
        raise ValueError("Field 'summary' must be a non-empty string.")

    active = state.get("active_dispatch")
    completed_stages = state.get("completed_stages", [])

    # Idempotency check if already completed
    if not active:
        if completed_stages:
            last = completed_stages[-1]
            if (
                last.get("receipt_path") == str(Path(report_data["receipt_path"]).resolve())
                and last.get("execution_status") == status
                and last.get("result") == report_data["result"]
            ):
                return last
        raise RuntimeError("No active dispatch in flight to complete.")

    if dispatch_id and active.get("dispatch_id") != dispatch_id:
        raise ValueError(
            f"Active dispatch ID '{active.get('dispatch_id')}' does not match requested '{dispatch_id}'."
        )

    if active.get("status") != "handed_off":
        raise RuntimeError(
            f"Cannot complete dispatch '{active.get('dispatch_id')}': task has not been handed off to execution. "
            "Run 'handoff' first."
        )

    # Verify physical receipt on disk
    assigned_receipt = Path(active["receipt_path"]).resolve()
    report_receipt = Path(report_data["receipt_path"]).resolve()
    if assigned_receipt != report_receipt:
        raise ValueError(
            f"Report receipt_path '{report_data['receipt_path']}' does not match assigned receipt_path '{active['receipt_path']}'."
        )

    if not assigned_receipt.exists():
        raise FileNotFoundError(f"Receipt file missing on disk at: {assigned_receipt}")

    if assigned_receipt.stat().st_size == 0:
        raise ValueError(f"Receipt file at {assigned_receipt} is empty (0 bytes).")

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
    elif decision == "continue":
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

    if active:
        status = active.get("status")
        disp_id = active.get("dispatch_id")
        if status == "prepared":
            blocking_reasons.append(
                f"Active dispatch '{disp_id}' is prepared but not yet handed off to execution."
            )
        elif status in ("handed_off", "running"):
            blocking_reasons.append(
                f"Active dispatch '{disp_id}' is in flight; awaiting completion report and durable receipt."
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

    info = {
        "workflow": state.get("workflow", "default"),
        "root_issue_id": state.get("root_issue_id"),
        "current_issue_id": state.get("current_issue_id"),
        "current_stage": state.get("current_stage"),
        "stage_status": stage_status,
        "active_dispatch": active,
        "last_decision": decisions[-1] if decisions else None,
        "budgets": budgets,
        "completed_stages_count": len(completed_stages),
        "blocking_reasons": blocking_reasons,
        "last_updated": state.get("last_updated"),
    }

    if field:
        val: Any = state
        for part in field.split("."):
            if isinstance(val, dict) and part in val:
                val = val[part]
            else:
                raise KeyError(f"Field '{field}' not found in state.")
        return val

    return info


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

    # prepare
    p_prep = subparsers.add_parser("prepare", help="Prepare a fixed task dispatch and envelope.")
    p_prep.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_prep.add_argument("--stage", "--task-name", dest="stage", required=True, help="Logical stage/task name.")
    p_prep.add_argument("--objective", required=True, help="Task objective.")
    p_prep.add_argument("--provider-type", required=True, choices=["skill", "script"], help="Provider type.")
    p_prep.add_argument("--provider-target", required=True, help="Provider target (skill name or script path).")
    p_prep.add_argument(
        "--provider-arg",
        dest="provider_args",
        action="append",
        default=[],
        help="Provider argument.",
    )
    p_prep.add_argument(
        "--criteria",
        "--criterion",
        dest="acceptance_criteria",
        action="append",
        default=[],
        help="Acceptance criterion.",
    )
    p_prep.add_argument(
        "--predecessor-receipt",
        dest="predecessor_receipts",
        action="append",
        default=[],
        help="Predecessor receipt path.",
    )
    p_prep.add_argument("--workdir", help="Working directory.")
    p_prep.add_argument("--scope", default="", help="Task scope.")
    p_prep.add_argument("--attempt-intent", default="same", choices=["same", "new", "same_attempt", "new_attempt"], help="Attempt intent.")
    p_prep.add_argument("--branch", help="Feature branch override.")
    p_prep.add_argument("--commit", help="Commit SHA override.")
    p_prep.add_argument("--receipt-template", default="templates/subagent-receipt.template.md", help="Receipt template path.")

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
            )
            print(json.dumps(state, indent=2, ensure_ascii=False))
        elif args.command == "prepare":
            disp = prepare_task(
                receipt_root=args.receipt_root,
                stage=args.stage,
                objective=args.objective,
                provider_type=args.provider_type,
                provider_target=args.provider_target,
                provider_args=args.provider_args,
                acceptance_criteria=args.acceptance_criteria,
                predecessor_receipts=args.predecessor_receipts,
                workdir=args.workdir,
                scope=args.scope,
                attempt_intent=args.attempt_intent,
                branch=args.branch,
                commit=args.commit,
                receipt_template=args.receipt_template,
            )
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
