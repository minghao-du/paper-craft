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
from typing import Any, Dict, List, Optional, Tuple, Union
import yaml

# Import workspace config validator
_CONFIG_DIR = str(Path(__file__).resolve().parent.parent.parent / "pc-workspace-config" / "scripts")
if _CONFIG_DIR not in sys.path:
    sys.path.insert(0, _CONFIG_DIR)

try:
    from config import validate_workspace_config, resolve_workspace_config
except ImportError:
    validate_workspace_config = None
    resolve_workspace_config = None

# Import envelope utilities
_SCRIPT_DIR = str(Path(__file__).resolve().parent)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from envelope import DEFAULT_RECEIPT_TEMPLATE, validate_envelope, atomic_write_json

DEFAULT_WORKFLOW_PATH = str(Path(__file__).resolve().parent.parent / "workflows" / "default.yaml")


def load_and_validate_workflow(
    workflow_source: Optional[Union[str, Dict[str, Any], Path]] = None,
    repo_dir: Optional[Path | str] = None,
) -> Dict[str, Any]:
    """Load workflow from YAML file, string, or dictionary, and validate required schema.

    Args:
        workflow_source: None (uses default.yaml), path to YAML, YAML content string, or dict.
        repo_dir: Optional repository directory to resolve relative paths.

    Returns:
        Validated workflow snapshot dictionary.

    Raises:
        ValueError: if workflow is invalid, missing required fields, contains duplicate
            stage IDs, invalid references, or non-skill provider types.
        FileNotFoundError: if a specified workflow file does not exist.
    """
    if workflow_source is None or workflow_source == "" or workflow_source == "default":
        p = Path(DEFAULT_WORKFLOW_PATH)
        if not p.exists():
            raise FileNotFoundError(f"Default workflow YAML file not found at: {p}")
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()
        try:
            data = yaml.safe_load(content)
        except Exception as e:
            raise ValueError(f"Failed to parse default workflow YAML: {e}")
    elif isinstance(workflow_source, dict):
        data = workflow_source
    elif isinstance(workflow_source, (str, Path)):
        src_str = str(workflow_source).strip()
        # Check if it's an inline YAML string
        if "\n" in src_str or src_str.startswith("{") or (":" in src_str and not src_str.endswith((".yaml", ".yml")) and "/" not in src_str and "\\" not in src_str and not Path(src_str).exists()):
            try:
                data = yaml.safe_load(src_str)
            except Exception as e:
                raise ValueError(f"Failed to parse workflow YAML content: {e}")
        else:
            is_explicit_path = (
                src_str.endswith(".yaml")
                or src_str.endswith(".yml")
                or "/" in src_str
                or "\\" in src_str
            )
            p = Path(src_str)
            if not p.is_absolute():
                if repo_dir and (Path(repo_dir) / p).exists():
                    p = Path(repo_dir) / p
                elif not p.exists():
                    wf_dir = Path(__file__).resolve().parent.parent / "workflows"
                    if (wf_dir / f"{src_str}.yaml").exists():
                        p = wf_dir / f"{src_str}.yaml"
                    elif (wf_dir / f"{src_str}").exists():
                        p = wf_dir / f"{src_str}"
            if not p.exists():
                if is_explicit_path:
                    raise FileNotFoundError(f"Workflow file not found: {workflow_source}")
                # Bare name without explicit path: fallback to default workflow with custom name
                def_p = Path(DEFAULT_WORKFLOW_PATH)
                if not def_p.exists():
                    raise FileNotFoundError(f"Default workflow YAML file not found at: {def_p}")
                with open(def_p, "r", encoding="utf-8") as f:
                    content = f.read()
                try:
                    data = yaml.safe_load(content)
                    if isinstance(data, dict):
                        if "workflow" in data and isinstance(data["workflow"], dict):
                            data["workflow"]["name"] = src_str
                        else:
                            data["name"] = src_str
                except Exception as e:
                    raise ValueError(f"Failed to parse default workflow YAML: {e}")
            else:
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        content = f.read()
                    data = yaml.safe_load(content)
                except Exception as e:
                    raise ValueError(f"Failed to parse workflow file at {p}: {e}")
    else:
        raise TypeError(f"Invalid workflow source type: {type(workflow_source).__name__}")

    if not isinstance(data, dict):
        raise ValueError(f"Workflow definition must be a mapping/object, got {type(data).__name__}")

    # Support both root keys and root 'workflow' block
    wf = data.get("workflow", data) if isinstance(data.get("workflow"), dict) else data

    if "name" not in wf or not isinstance(wf["name"], str) or not wf["name"].strip():
        raise ValueError("Workflow definition missing required non-empty string field: 'name'")

    if "stages" not in wf or not isinstance(wf["stages"], list) or len(wf["stages"]) == 0:
        raise ValueError("Workflow definition missing required non-empty list field: 'stages'")

    seen_stage_ids: set[str] = set()
    for idx, stage in enumerate(wf["stages"]):
        if not isinstance(stage, dict):
            raise ValueError(f"Workflow stage at index {idx} must be a mapping/object")
        stage_id = stage.get("id")
        if not stage_id or not isinstance(stage_id, str) or not stage_id.strip():
            raise ValueError(f"Workflow stage at index {idx} missing required non-empty string field: 'id'")
        stage_id = stage_id.strip()
        if stage_id in seen_stage_ids:
            raise ValueError(f"Duplicate stage ID '{stage_id}' in workflow")
        seen_stage_ids.add(stage_id)

        # Validate provider: strictly skill
        if "skill" in stage and "provider" not in stage:
            stage["provider"] = {"type": "skill", "target": str(stage["skill"]).strip()}

        provider = stage.get("provider")
        if not isinstance(provider, dict):
            raise ValueError(f"Workflow stage '{stage_id}' missing required mapping: 'provider'")
        p_type = provider.get("type")
        if p_type != "skill":
            raise ValueError(
                f"Workflow stage '{stage_id}' has invalid provider type '{p_type}'. Only 'skill' provider is supported."
            )
        p_target = provider.get("target")
        if not p_target or not isinstance(p_target, str) or not p_target.strip():
            raise ValueError(f"Workflow stage '{stage_id}' has missing or empty provider 'target'")
        p_args = provider.get("args")
        if p_args is not None and (not isinstance(p_args, list) or any(not isinstance(a, str) for a in p_args)):
            raise ValueError(f"Workflow stage '{stage_id}' provider 'args' must be a list of strings")

    # Validate references
    initial_stage = wf.get("initial_stage")
    if initial_stage and str(initial_stage).strip() not in seen_stage_ids:
        raise ValueError(
            f"Workflow 'initial_stage' references unknown stage '{initial_stage}'. Defined stages: {sorted(seen_stage_ids)}"
        )

    for stage in wf["stages"]:
        for ref_key in ("next", "on_success", "on_failure", "next_stage"):
            ref_val = stage.get(ref_key)
            if ref_val and str(ref_val).strip() not in seen_stage_ids:
                raise ValueError(
                    f"Stage '{stage['id']}' {ref_key} references unknown stage '{ref_val}'"
                )
        depends_on = stage.get("depends_on") or stage.get("dependencies")
        if depends_on:
            if isinstance(depends_on, list):
                for dep in depends_on:
                    if str(dep).strip() not in seen_stage_ids:
                        raise ValueError(
                            f"Stage '{stage['id']}' dependency references unknown stage '{dep}'"
                        )
            elif isinstance(depends_on, str) and depends_on.strip() not in seen_stage_ids:
                raise ValueError(
                    f"Stage '{stage['id']}' dependency references unknown stage '{depends_on}'"
                )

    return wf


def _make_delivery_item(issue_id: str | int, delivery_attempts_max: int) -> Dict[str, Any]:
    """Create a standardized delivery sequence item dictionary.

    Args:
        issue_id: Issue identifier string or integer.
        delivery_attempts_max: Maximum delivery attempts allocated for the issue.

    Returns:
        Standardized delivery item dictionary with pending status and initialized budgets.
    """
    return {
        "issue_id": str(issue_id),
        "stage": "stage_2_work",
        "status": "pending",
        "budgets": {
            "delivery_attempts_used": 0,
            "delivery_attempts_max": delivery_attempts_max,
        },
        "landed": False,
    }


def _make_delivery_sequence(issue_ids: List[str | int], delivery_attempts_max: int) -> Dict[str, Any]:
    """Create a standardized delivery sequence container from a list of issue IDs.

    Args:
        issue_ids: List of issue IDs in planned execution order.
        delivery_attempts_max: Maximum delivery attempts per issue.

    Returns:
        Delivery sequence dictionary containing ordered items and progression state.
    """
    return {
        "items": [_make_delivery_item(cid, delivery_attempts_max) for cid in issue_ids],
        "current_index": 0,
        "completed": False,
    }


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
            if b not in seen:
                raise ValueError(
                    f"Plan dependency violation: task '{issue_id}' depends on unknown issue '{b}' not declared in plan."
                )
            if b not in resolved:
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


def check_workspace_config(
    repo_dir: Path | str,
    require_config: bool = False,
    overrides: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """Check workspace configuration existence and validity using config.py as single source."""
    if not resolve_workspace_config:
        return False, "Config module unavailable", None
    try:
        resolved = resolve_workspace_config(repo_dir, overrides=overrides, require_file=require_config)
        return True, "Workspace configuration valid", resolved
    except Exception as e:
        return False, str(e), None


def init_workflow(
    receipt_root: Optional[Path | str] = None,
    root_issue: str | int = 0,
    current_issue: Optional[str | int] = None,
    workflow: Optional[str] = None,
    initial_stage: Optional[str] = None,
    repo_dir: Path | str = ".",
    force: bool = False,
    require_config: bool = False,
    delivery_attempts_max: Optional[int] = None,
    replans_max: Optional[int] = None,
    child_issues: Optional[List[Any]] = None,
    plan: Optional[Any] = None,
    delivery_target: Optional[str] = None,
    base_remote: Optional[str] = None,
    push_remote: Optional[str] = None,
    base_branch: Optional[str] = None,
    worktree_container: Optional[str] = None,
) -> Dict[str, Any]:
    """Initialize workflow runtime state in <receipt_root>/state.json."""
    repo_path = Path(repo_dir).resolve()
    if not repo_path.exists():
        raise FileNotFoundError(f"Repository directory does not exist: {repo_path}")

    # Build overrides from explicit CLI parameters (explicit parameters take precedence)
    overrides: Dict[str, Any] = {}
    if workflow is not None:
        overrides["workflow"] = workflow
    if delivery_attempts_max is not None:
        overrides["delivery_attempts_max"] = delivery_attempts_max
    if replans_max is not None:
        overrides["replans_max"] = replans_max
    if delivery_target is not None:
        overrides["delivery_target"] = delivery_target
    if base_remote is not None:
        overrides["base_remote"] = base_remote
    if push_remote is not None:
        overrides["push_remote"] = push_remote
    if base_branch is not None:
        overrides["base_branch"] = base_branch
    if worktree_container is not None:
        overrides["worktree_container"] = worktree_container

    # Workspace configuration check: stops immediately on missing/invalid config or unconfirmed facts
    cfg_ok, cfg_msg, resolved_config = check_workspace_config(
        repo_path,
        require_config=require_config,
        overrides=overrides,
    )
    if not cfg_ok or not resolved_config:
        raise ValueError(cfg_msg)

    # Determine isolated receipt root directory
    if receipt_root is not None and str(receipt_root).strip():
        root_path = Path(receipt_root).resolve()
    else:
        container_path = Path(resolved_config["worktree_container_resolved"])
        root_path = (container_path / ".paper-craft" / "receipts" / f"issue-{root_issue}").resolve()

    # Validate isolation constraints
    if root_path == repo_path or repo_path in root_path.parents or root_path in repo_path.parents:
        raise ValueError(
            f"Receipt root '{root_path}' violates isolation constraints: cannot be within or contain repository checkout '{repo_path}'."
        )

    resolved_config["receipt_root"] = str(root_path)
    state_file = root_path / "state.json"

    target_workflow = resolved_config["workflow"]
    target_repo = resolved_config["repo_checkout"]

    # Load and validate workflow snapshot
    workflow_to_load = workflow or target_workflow
    workflow_snapshot = load_and_validate_workflow(workflow_to_load, repo_dir=repo_path)
    snapshot_name = workflow_snapshot.get("name", target_workflow)

    # Re-entrance / rerun identity check: check repository checkout and workflow identity, not just issue number
    if state_file.exists() and not force:
        with open(state_file, "r", encoding="utf-8") as f:
            existing = json.load(f)
        existing_root = str(existing.get("root_issue_id", ""))
        existing_wf = existing.get("workflow", "")
        existing_cfg = existing.get("config_snapshot", {})
        existing_repo = existing_cfg.get("repo_checkout") or existing.get("context", {}).get("repo_checkout")

        if existing_root != str(root_issue):
            raise FileExistsError(
                f"Run identity conflict: State file at {state_file} already exists for root issue {existing_root}, "
                f"cannot re-initialize with root issue {root_issue}. Use --force to overwrite."
            )
        if existing_wf != target_workflow and existing_wf != snapshot_name:
            raise ValueError(
                f"Run identity conflict: Existing run at {state_file} has workflow '{existing_wf}', "
                f"but rerun specified workflow '{target_workflow}'. Use --force to overwrite."
            )
        if existing_repo and Path(existing_repo).resolve() != Path(target_repo).resolve():
            raise ValueError(
                f"Run identity conflict: Existing run at {state_file} was initialized with repository checkout "
                f"'{existing_repo}', but rerun specified repository checkout '{target_repo}'. Use --force to overwrite."
            )
        return existing

    now = datetime.now(timezone.utc).isoformat()
    context: Dict[str, Any] = {
        "repository": resolved_config["delivery_target"],
        "delivery_target": resolved_config["delivery_target"],
        "base_branch": resolved_config["base_branch"],
        "base_remote": resolved_config["base_remote"],
        "push_remote": resolved_config["push_remote"],
        "worktree_container": resolved_config["worktree_container"],
        "repo_checkout": resolved_config["repo_checkout"],
    }

    # Resolve child issues / plan if provided
    child_ids: Optional[List[str]] = None
    if child_issues:
        child_ids = validate_plan_order(child_issues)
    elif plan:
        if isinstance(plan, str):
            plan_str = plan.strip()
            if plan_str.startswith("{") or plan_str.startswith("["):
                try:
                    plan_obj = json.loads(plan_str)
                except Exception as e:
                    raise ValueError(f"Invalid plan JSON: {e}")
            else:
                plan_file = Path(plan_str).resolve()
                if not plan_file.exists():
                    raise FileNotFoundError(f"Plan file not found: {plan_file}")
                try:
                    with open(plan_file, "r", encoding="utf-8") as f:
                        plan_obj = json.load(f)
                except Exception as e:
                    raise ValueError(f"Invalid plan file JSON: {e}")
        elif isinstance(plan, (dict, list)):
            plan_obj = plan
        else:
            raise TypeError("Plan must be a JSON object dictionary, list, JSON string, or file path.")

        tasks = plan_obj.get("tasks", []) if isinstance(plan_obj, dict) else plan_obj
        child_ids = validate_plan_order(tasks)

    resolved_current_issue = str(current_issue or (child_ids[0] if child_ids else root_issue))

    snapshot_initial = workflow_snapshot.get("initial_stage")
    stage_ids = {s["id"] for s in workflow_snapshot.get("stages", [])}
    if initial_stage:
        if stage_ids and initial_stage not in stage_ids:
            raise ValueError(f"Requested initial_stage '{initial_stage}' not found in workflow snapshot.")
        resolved_current_stage = initial_stage
    elif child_ids:
        resolved_current_stage = (
            "stage_2_work"
            if "stage_2_work" in stage_ids
            else (workflow_snapshot["stages"][0]["id"] if workflow_snapshot.get("stages") else "stage_2_work")
        )
    elif snapshot_initial and snapshot_initial in stage_ids:
        resolved_current_stage = snapshot_initial
    elif workflow_snapshot.get("stages"):
        resolved_current_stage = workflow_snapshot["stages"][0]["id"]
    else:
        resolved_current_stage = "stage_1_plan"

    delivery_sequence: Optional[Dict[str, Any]] = None
    delivery_attempts_max = resolved_config["delivery_attempts_max"]
    replans_max = resolved_config["replans_max"]
    if child_ids:
        delivery_sequence = _make_delivery_sequence(child_ids, delivery_attempts_max)
    elif initial_stage in ("stage_2_work", "issue_work") or (current_issue and str(current_issue) != str(root_issue)):
        curr = str(current_issue or root_issue)
        delivery_sequence = _make_delivery_sequence([curr], delivery_attempts_max)

    state = {
        "schema_version": "1.0",
        "root_issue_id": str(root_issue),
        "current_issue_id": resolved_current_issue,
        "workflow": snapshot_name,
        "workflow_snapshot": workflow_snapshot,
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
        "config_snapshot": resolved_config,
        "last_updated": now,
    }
    if delivery_sequence:
        state["delivery_sequence"] = delivery_sequence

    root_path.mkdir(parents=True, exist_ok=True)
    atomic_write_json(state_file, state)
    return state


def prepare_task(
    receipt_root: Path | str,
    stage: str,
    objective: str,
    provider_type: Optional[str] = None,
    provider_target: Optional[str] = None,
    provider_args: Optional[List[str]] = None,
    acceptance_criteria: Optional[List[str]] = None,
    predecessor_receipts: Optional[List[str]] = None,
    workdir: Optional[str] = None,
    scope: str = "",
    parameters: Optional[Dict[str, Any]] = None,
    attempt_intent: str = "same",
    branch: Optional[str] = None,
    commit: Optional[str] = None,
    receipt_template: Optional[str] = None,
    rework_issue: Optional[str | int] = None,
) -> Dict[str, Any]:
    """Prepare a fixed task dispatch, generate envelope, and assign receipt path."""
    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

    # Check workflow halt status
    if state.get("stage_status") == "halted" or state.get("orchestrator_decision") == "halt":
        raise RuntimeError("Cannot prepare task: Workflow is halted. Run 'resolve --decision continue' to resume first.")

    # Context & Environment
    context = state.get("context", {})
    config_snapshot = state.get("config_snapshot", {})
    resolved_workdir = str(
        workdir
        or context.get("worktree")
        or context.get("working_directory")
        or config_snapshot.get("repo_checkout")
        or Path.cwd()
    )
    resolved_branch = branch or context.get("branch")
    resolved_commit = commit or context.get("commit")

    # Workflow snapshot stage lookup and extraction
    workflow_snapshot = state.get("workflow_snapshot")
    stage_def: Optional[Dict[str, Any]] = None
    if workflow_snapshot and "stages" in workflow_snapshot:
        for s in workflow_snapshot["stages"]:
            if s.get("id") == stage or s.get("logical_task") == stage:
                stage_def = s
                break

    if stage_def is None:
        if provider_target:
            stage_def = {
                "id": stage,
                "provider": {
                    "type": provider_type or "skill",
                    "target": provider_target,
                    "args": provider_args or [],
                },
            }
        else:
            raise ValueError(
                f"Cannot prepare task: Stage '{stage}' is not defined in workflow snapshot and no provider was specified."
            )

    stage_provider = stage_def.get("provider", {})
    resolved_provider_type = provider_type or stage_provider.get("type", "skill")
    if resolved_provider_type != "skill":
        raise ValueError(f"Provider 'type' must be 'skill', received '{resolved_provider_type}'")

    resolved_provider_target = provider_target or stage_provider.get("target")
    if not resolved_provider_target:
        raise ValueError(f"Provider 'target' must be defined in stage '{stage}' or provided in prepare request.")

    resolved_provider_args = provider_args if provider_args is not None else list(stage_provider.get("args", []))

    resolved_receipt_template = (
        receipt_template
        or stage_def.get("receipt_template")
        or stage_def.get("template")
        or DEFAULT_RECEIPT_TEMPLATE
    )

    resolved_scope = scope or stage_def.get("scope", "")
    is_auxiliary = stage_def.get("auxiliary", False) or stage in ("workspace_prepare", "workspace_cleanup")
    is_replan = stage_def.get("replan", False) or stage == "scope_replan"

    resolved_predecessors = list(predecessor_receipts or [])
    receipt_root_resolved = receipt_root_path.resolve()
    for p_str in resolved_predecessors:
        if not isinstance(p_str, str) or not p_str.strip():
            raise ValueError("Predecessor receipt path must be a non-empty string.")
        p = Path(p_str).resolve()
        if not p.exists():
            raise FileNotFoundError(f"Predecessor receipt does not exist on disk: {p}")
        if p.stat().st_size == 0:
            raise ValueError(f"Predecessor receipt at {p} is empty.")
        try:
            p.relative_to(receipt_root_resolved)
            is_internal = True
        except ValueError:
            is_internal = False
        if is_internal:
            completed_receipts = {
                Path(c.get("receipt_path", "")).resolve()
                for c in state.get("completed_stages", [])
            }
            if p not in completed_receipts:
                raise ValueError(
                    f"Predecessor receipt '{p}' does not match any completed stage in this workflow run."
                )

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
            and req.get("provider", {}).get("type") == resolved_provider_type
            and req.get("provider", {}).get("target") == resolved_provider_target
            and req.get("provider", {}).get("args", []) == (resolved_provider_args or [])
            and req.get("acceptance_criteria", []) == (acceptance_criteria or [])
            and req.get("predecessors", []) == resolved_predecessors
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
                "stage": stage,
                "stage_context": stage_def,
            }
        raise RuntimeError(
            f"Cannot prepare task: Active dispatch '{active.get('dispatch_id')}' is already pending. "
            "Resolve or complete it before preparing a different task."
        )

    # Determine attempt and budget
    delivery_seq = state.get("delivery_sequence")
    curr_item = None
    active_rework = delivery_seq.get("active_rework_issue_id") if delivery_seq else None

    designated_rework = None
    if rework_issue is not None:
        designated_rework = str(rework_issue).strip()

    if designated_rework is not None:
        if delivery_seq:
            for it in delivery_seq.get("items", []):
                if str(it.get("issue_id")) == designated_rework:
                    curr_item = it
                    break
            if not curr_item and str(state.get("root_issue_id")) != designated_rework:
                raise ValueError(
                    f"Cannot attribute rework to issue '{designated_rework}': issue not found in delivery sequence. "
                    "Gaps that cannot be attributed to an existing issue must be routed to replanning; "
                    "do not guess attribution or replace plan."
                )
            if curr_item:
                delivery_seq["active_rework_issue_id"] = designated_rework
                curr_issue = designated_rework
                state["current_issue_id"] = designated_rework
            else:
                curr_issue = designated_rework
                state["current_issue_id"] = designated_rework
        elif str(state.get("root_issue_id")) == designated_rework:
            curr_issue = designated_rework
            state["current_issue_id"] = designated_rework
        else:
            raise ValueError(
                f"Cannot attribute rework to issue '{designated_rework}': issue not found in delivery sequence. "
                "Gaps that cannot be attributed to an existing issue must be routed to replanning; "
                "do not guess attribution or replace plan."
            )
    elif active_rework and delivery_seq and not is_replan:
        for it in delivery_seq.get("items", []):
            if str(it.get("issue_id")) == str(active_rework):
                curr_item = it
                break
        curr_issue = str(active_rework)
        state["current_issue_id"] = curr_issue
    elif delivery_seq and not delivery_seq.get("completed", False) and not is_replan:
        curr_idx = delivery_seq.get("current_index", 0)
        items = delivery_seq.get("items", [])
        if curr_idx < len(items):
            curr_item = items[curr_idx]
            curr_issue = curr_item["issue_id"]
            state["current_issue_id"] = curr_issue
        else:
            curr_issue = state.get("current_issue_id", state.get("root_issue_id", "0"))
    else:
        curr_issue = state.get("current_issue_id", state.get("root_issue_id", "0"))

    budgets = state.get("budgets", {})
    if is_replan:
        origin_stage = (parameters or {}).get("originating_stage")
        if not origin_stage:
            curr_st = state.get("current_stage", "stage_1_plan")
            if curr_st == "scope_replan":
                origin_stage = state.get("originating_stage_for_replan", "stage_1_plan")
            else:
                origin_stage = curr_st
                state["originating_stage_for_replan"] = origin_stage

        target_budgets = curr_item.setdefault("budgets", {}) if curr_item is not None else state.setdefault("budgets", {})
        stage_replans = target_budgets.setdefault("replans_by_stage", {})
        used_replans_stage = stage_replans.get(origin_stage, 0)
        max_replans = target_budgets.get("replans_max", budgets.get("replans_max", 2))

        if max_replans <= 0 or used_replans_stage >= max_replans:
            raise RuntimeError(
                f"Budget exceeded: replans used ({used_replans_stage}) reached maximum ({max_replans}) for issue {curr_issue} and stage {origin_stage}."
            )

        new_replans = used_replans_stage + 1
        stage_replans[origin_stage] = new_replans
        target_budgets["replans_used"] = target_budgets.get("replans_used", 0) + 1
        if curr_item is not None:
            budgets["replans_used"] = budgets.get("replans_used", 0) + 1
        state["budgets"] = budgets

        new_attempt = new_replans
        envelope_delivery_used = target_budgets.get("delivery_attempts_used", budgets.get("delivery_attempts_used", 0))
        envelope_delivery_max = target_budgets.get("delivery_attempts_max", budgets.get("delivery_attempts_max", 3))
        envelope_replan_used = new_replans
        envelope_replan_max = max_replans
    elif curr_item is not None:
        state["originating_stage_for_replan"] = None
        item_budgets = curr_item.setdefault("budgets", {})
        used_attempts = item_budgets.get("delivery_attempts_used", 0)
        max_attempts = item_budgets.get("delivery_attempts_max", budgets.get("delivery_attempts_max", 3))

        if max_attempts <= 0:
            raise RuntimeError(f"Budget exceeded: delivery attempts max ({max_attempts}) is exhausted for issue {curr_issue}.")

        if is_auxiliary:
            new_attempt = max(1, used_attempts)
        elif used_attempts == 0:
            if used_attempts >= max_attempts:
                raise RuntimeError(f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts}) for issue {curr_issue}.")
            new_attempt = 1
            item_budgets["delivery_attempts_used"] = 1
        elif attempt_intent == "new":
            if used_attempts >= max_attempts:
                raise RuntimeError(f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts}) for issue {curr_issue}.")
            new_attempt = used_attempts + 1
            item_budgets["delivery_attempts_used"] = new_attempt
        else:
            new_attempt = used_attempts

        budgets["delivery_attempts_used"] = item_budgets["delivery_attempts_used"]
        budgets["delivery_attempts_max"] = max_attempts
        state["budgets"] = budgets

        if not is_auxiliary:
            curr_item["stage"] = stage
            curr_item["status"] = "pending"

        envelope_delivery_used = item_budgets["delivery_attempts_used"]
        envelope_delivery_max = max_attempts
        envelope_replan_used = item_budgets.get("replans_used", budgets.get("replans_used", 0))
        envelope_replan_max = item_budgets.get("replans_max", budgets.get("replans_max", 2))
    else:
        used_attempts = budgets.get("delivery_attempts_used", 0)
        max_attempts = budgets.get("delivery_attempts_max", 3)

        if max_attempts <= 0:
            raise RuntimeError(
                f"Budget exceeded: delivery attempts max ({max_attempts}) is exhausted."
            )

        if is_auxiliary:
            new_attempt = max(1, used_attempts)
        elif used_attempts == 0:
            if used_attempts >= max_attempts:
                raise RuntimeError(
                    f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts})."
                )
            new_attempt = 1
            budgets["delivery_attempts_used"] = 1
        elif attempt_intent == "new":
            if used_attempts >= max_attempts:
                raise RuntimeError(
                    f"Budget exceeded: delivery attempts used ({used_attempts}) reached maximum ({max_attempts})."
                )
            new_attempt = used_attempts + 1
            budgets["delivery_attempts_used"] = new_attempt
        else:
            new_attempt = used_attempts
        state["budgets"] = budgets

        envelope_delivery_used = budgets["delivery_attempts_used"]
        envelope_delivery_max = max_attempts
        envelope_replan_used = budgets.get("replans_used", 0)
        envelope_replan_max = budgets.get("replans_max", 2)

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

    # Resolve environment and parameters from config_snapshot directly without guesswork fallbacks
    repo = (
        config_snapshot.get("delivery_target")
        or context.get("delivery_target")
        or context.get("repository")
    )
    base_branch = (
        config_snapshot.get("base_branch")
        or context.get("base_branch")
    )
    base_remote = (
        config_snapshot.get("base_remote")
        or context.get("base_remote")
    )
    push_remote = (
        config_snapshot.get("push_remote")
        or context.get("push_remote")
    )
    worktree_container = (
        config_snapshot.get("worktree_container")
        or context.get("worktree_container")
    )

    params = dict(stage_def.get("parameters", {}))
    params.update(stage_def.get("configs", {}))
    if parameters:
        params.update(parameters)
    if "delivery_target" not in params and repo:
        params["delivery_target"] = repo
    if "base_remote" not in params and base_remote:
        params["base_remote"] = base_remote
    if "push_remote" not in params and push_remote:
        params["push_remote"] = push_remote
    if "worktree_container" not in params and worktree_container:
        params["worktree_container"] = worktree_container

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
            "type": resolved_provider_type,
            "target": resolved_provider_target,
            "args": resolved_provider_args,
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
            "scope": resolved_scope,
            "acceptance_criteria": acceptance_criteria or [],
            "predecessor_receipts": resolved_predecessors,
            "parameters": params,
        },
        "contract": {
            "receipt_path": str(receipt_path),
            "receipt_template": resolved_receipt_template,
        },
        "budgets": {
            "delivery_attempts_used": envelope_delivery_used,
            "delivery_attempts_max": envelope_delivery_max,
            "replans_used": envelope_replan_used,
            "replans_max": envelope_replan_max,
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
        "stage_context": stage_def,
        "request": {
            "objective": objective,
            "provider": {
                "type": resolved_provider_type,
                "target": resolved_provider_target,
                "args": resolved_provider_args,
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
        "stage": stage,
        "stage_context": stage_def,
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

    report_dispatch_id = report_data.get("dispatch_id")
    if dispatch_id and report_dispatch_id and dispatch_id != report_dispatch_id:
        err_msg = f"dispatch_mismatch: Requested dispatch_id '{dispatch_id}' does not match report dispatch_id '{report_dispatch_id}'."
        _record_protocol_error(receipt_root_path, state, "dispatch_mismatch", err_msg)
        raise ValueError(err_msg)

    if dispatch_id and active.get("dispatch_id") != dispatch_id:
        err_msg = f"dispatch_mismatch: Active dispatch ID '{active.get('dispatch_id')}' does not match requested '{dispatch_id}'."
        _record_protocol_error(receipt_root_path, state, "dispatch_mismatch", err_msg)
        raise ValueError(err_msg)

    if report_dispatch_id and active.get("dispatch_id") != report_dispatch_id:
        err_msg = f"dispatch_mismatch: Active dispatch ID '{active.get('dispatch_id')}' does not match report dispatch_id '{report_dispatch_id}'."
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
    outcome = report_data.get("result", {}).get("outcome")
    state["stage_status"] = "needs_rework" if outcome == "rework_needed" else status
    state["last_updated"] = now
    atomic_write_json(get_state_file_path(receipt_root_path), state)

    return completed_entry


def resolve_decision(
    receipt_root: Path | str,
    decision: str,
    reason: str,
    options: Optional[List[str]] = None,
    next_stage: Optional[str] = None,
    current_issue: Optional[str | int] = None,
    plan: Optional[Any] = None,
    child_issues: Optional[List[str | int]] = None,
    mark_landed: Optional[str | int] = None,
    complete_sequence: bool = False,
) -> Dict[str, Any]:
    """Record orchestrator decisions (wait_user, continue, halt, finish, or next stage)."""
    receipt_root_path = Path(receipt_root).resolve()
    state = load_state(receipt_root_path)

    control_decisions = ("wait_user", "continue", "halt", "finish")
    if decision in control_decisions:
        action = decision
        stage_to_set = next_stage
    else:
        # Decision is an arbitrary stage name
        action = "continue"
        stage_to_set = next_stage or decision

    # Guard rules for finish
    if action == "finish":
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

    if action == "finish" and state.get("workflow", "default") == "default":
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
    record: Dict[str, Any] = {
        "decision": decision,
        "action": action,
        "reason": reason,
        "options": options or [],
        "timestamp": now,
    }

    if action == "halt":
        state["stage_status"] = "halted"
    elif action == "wait_user":
        state["stage_status"] = "blocked"
    elif action == "finish":
        state["stage_status"] = "succeeded"
        state["current_stage"] = "completed"
    elif action == "continue":
        # Resuming from wait cannot bypass unconfirmed external execution
        active = state.get("active_dispatch")
        if active and active.get("status") in ("handed_off", "running"):
            state["stage_status"] = "in_progress"
        else:
            state["stage_status"] = "pending"

    if stage_to_set:
        state["current_stage"] = stage_to_set
        state["stage_status"] = "pending"
        record["next_stage"] = stage_to_set

    # Plan decomposition / sequence registration
    resolved_child_ids: Optional[List[str]] = None
    if child_issues:
        resolved_child_ids = validate_plan_order(child_issues)
    elif plan:
        plan_data = plan
        if isinstance(plan_data, str):
            p_str = plan_data.strip()
            if p_str.startswith("{") or p_str.startswith("["):
                try:
                    plan_obj = json.loads(p_str)
                except Exception as e:
                    raise ValueError(f"Invalid plan JSON: {e}")
            else:
                p_file = Path(p_str).resolve()
                if not p_file.exists():
                    raise FileNotFoundError(f"Plan file not found: {p_file}")
                try:
                    with open(p_file, "r", encoding="utf-8") as f:
                        plan_obj = json.load(f)
                except Exception as e:
                    raise ValueError(f"Invalid plan file JSON: {e}")
        elif isinstance(plan_data, (dict, list)):
            plan_obj = plan_data
        else:
            raise TypeError("Plan must be a JSON object dictionary, list, JSON string, or file path.")
        raw_tasks = plan_obj.get("tasks", []) if isinstance(plan_obj, dict) else plan_obj
        resolved_child_ids = validate_plan_order(raw_tasks)

    if resolved_child_ids:
        delivery_attempts_max = state.get("budgets", {}).get("delivery_attempts_max", 3)
        state["delivery_sequence"] = _make_delivery_sequence(resolved_child_ids, delivery_attempts_max)
        state["current_issue_id"] = str(resolved_child_ids[0])
        state["budgets"]["delivery_attempts_used"] = 0

    if current_issue is not None:
        iss_str = str(current_issue).strip()
        state["current_issue_id"] = iss_str
        record["current_issue"] = iss_str
        if state.get("delivery_sequence"):
            if state["delivery_sequence"].get("active_rework_issue_id") != iss_str:
                state["delivery_sequence"]["active_rework_issue_id"] = None
            for idx, it in enumerate(state["delivery_sequence"].get("items", [])):
                if str(it.get("issue_id")) == iss_str:
                    state["delivery_sequence"]["current_index"] = idx
                    item_budgets = it.setdefault("budgets", {})
                    state["budgets"]["delivery_attempts_used"] = item_budgets.get("delivery_attempts_used", 0)
                    state["budgets"]["delivery_attempts_max"] = item_budgets.get(
                        "delivery_attempts_max", state.get("budgets", {}).get("delivery_attempts_max", 3)
                    )
                    break

    if mark_landed is not None:
        landed_id = str(mark_landed).strip()
        record["mark_landed"] = landed_id
        if state.get("delivery_sequence"):
            if state["delivery_sequence"].get("active_rework_issue_id") == landed_id:
                state["delivery_sequence"]["active_rework_issue_id"] = None
            for it in state["delivery_sequence"].get("items", []):
                if str(it.get("issue_id")) == landed_id:
                    it["landed"] = True
                    it["status"] = "landed"
                    it["stage"] = "landed"
                    completed_stages = state.get("completed_stages", [])
                    if completed_stages:
                        it["land_receipt_path"] = str(completed_stages[-1].get("receipt_path", ""))
                    break

    if complete_sequence:
        record["complete_sequence"] = True
        if state.get("delivery_sequence"):
            state["delivery_sequence"]["completed"] = True
            state["current_issue_id"] = str(state.get("root_issue_id", "0"))

    state.setdefault("decisions", []).append(record)
    state["orchestrator_decision"] = decision
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
        "rework_issue",
    }
    unknown = request.keys() - allowed_fields
    if unknown:
        raise ValueError(f"Unknown prepare request fields: {', '.join(sorted(unknown))}")
    for field in ("stage", "objective"):
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

    if "rework_issue" in request:
        value = request["rework_issue"]
        if value is not None:
            if not isinstance(value, (str, int)) or (isinstance(value, str) and not value.strip()):
                raise ValueError(f"Request 'rework_issue' must be a non-empty string or integer, received {value!r}")

    payload = dict(request)
    if "provider" in request and request["provider"] is not None:
        provider = request["provider"]
        if not isinstance(provider, dict):
            raise ValueError(f"Request 'provider' must be an object, received {provider!r}")
        unknown = provider.keys() - {"type", "target", "args"}
        if unknown:
            raise ValueError(f"Unknown provider fields: {', '.join(sorted(unknown))}")
        if provider.get("type") != "skill":
            raise ValueError(f"Provider 'type' must be 'skill', received {provider.get('type')!r}")
        target = provider.get("target")
        if not isinstance(target, str) or not target.strip():
            raise ValueError(f"Provider 'target' must be a non-empty string, received {target!r}")
        del payload["provider"]
        payload.update(
            provider_type=provider["type"],
            provider_target=target,
            provider_args=provider.get("args", []),
        )

    for field, value in (
        ("provider.args", payload.get("provider_args", [])),
        ("acceptance_criteria", request.get("acceptance_criteria", [])),
        ("predecessor_receipts", request.get("predecessor_receipts", [])),
    ):
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError(f"Request {field!r} must be an array of strings, received {value!r}")

    if "rework_issue" in payload and payload["rework_issue"] is not None:
        payload["rework_issue"] = str(payload["rework_issue"]).strip()
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Minimal dispatch lifecycle kernel for pc-orchestrator workflows."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # init
    p_init = subparsers.add_parser("init", help="Initialize workflow run state snapshot.")
    p_init.add_argument("--receipt-root", help="Absolute path to receipts root directory. Derived from worktree container if omitted.")
    p_init.add_argument("--root-issue", required=True, help="Root GitHub issue number.")
    p_init.add_argument("--current-issue", help="Initial current issue number (defaults to root issue).")
    p_init.add_argument("--workflow", default=None, help="Workflow name (defaults to configured workflow or 'default').")
    p_init.add_argument("--initial-stage", help="Initial stage name.")
    p_init.add_argument("--force", action="store_true", help="Force overwrite existing state file.")
    p_init.add_argument("--require-config", action="store_true", help="Require valid workspace configuration.")
    p_init.add_argument("--repo-dir", default=".", help="Repository root containing .paper-craft/")
    p_init.add_argument("--delivery-attempts-max", type=int, default=None, help="Max delivery attempts.")
    p_init.add_argument("--replans-max", type=int, default=None, help="Max replans.")
    p_init.add_argument("--child-issue", dest="child_issues", action="append", default=[], help="Child issue number in planned order.")
    p_init.add_argument("--plan", help="JSON string or file path containing plan snapshot.")
    p_init.add_argument("--delivery-target", help="Override delivery target repository (owner/repo).")
    p_init.add_argument("--base-remote", help="Override mainline base git remote (e.g. origin).")
    p_init.add_argument("--push-remote", help="Override feature push git remote (e.g. origin).")
    p_init.add_argument("--base-branch", help="Override mainline base branch (e.g. main).")
    p_init.add_argument("--worktree-container", help="Override container directory for worktrees.")

    # prepare
    p_prep = subparsers.add_parser("prepare", help="Prepare a fixed task dispatch and envelope.")
    p_prep.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    p_prep.add_argument("--request", required=True, help="Absolute path to the prepare request JSON file.")
    p_prep.add_argument("--rework-issue", help="Target issue ID for targeted rework.")

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
    p_res.add_argument("--decision", required=True, help="Orchestrator decision (wait_user, continue, halt, finish, or next stage name).")
    p_res.add_argument("--reason", required=True, help="Reason for decision.")
    p_res.add_argument("--option", dest="options", action="append", default=[], help="Options presented (for Decision Board).")
    p_res.add_argument("--next-stage", dest="next_stage", help="Next logical stage name to advance to.")
    p_res.add_argument("--current-issue", dest="current_issue", help="Current issue ID to advance delivery sequence.")
    p_res.add_argument("--plan", help="JSON string or file path containing plan snapshot to register child issues.")
    p_res.add_argument("--child-issue", dest="child_issues", action="append", default=[], help="Child issue number in planned order.")
    p_res.add_argument("--mark-landed", help="Issue ID to mark as landed in delivery sequence.")
    p_res.add_argument("--complete-sequence", action="store_true", help="Mark delivery sequence as completed.")

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
                delivery_target=args.delivery_target,
                base_remote=args.base_remote,
                push_remote=args.push_remote,
                base_branch=args.base_branch,
                worktree_container=args.worktree_container,
            )
            print(json.dumps(state, indent=2, ensure_ascii=False))
        elif args.command == "prepare":
            if not Path(args.receipt_root).is_absolute():
                raise ValueError(f"Receipt root must be absolute, received {args.receipt_root!r}")
            request = load_prepare_request(args.request)
            if args.rework_issue:
                request["rework_issue"] = args.rework_issue
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
                next_stage=args.next_stage,
                current_issue=args.current_issue,
                plan=args.plan,
                child_issues=args.child_issues or None,
                mark_landed=args.mark_landed,
                complete_sequence=args.complete_sequence,
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
