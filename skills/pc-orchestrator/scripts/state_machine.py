#!/usr/bin/env python3
"""Lightweight, deterministic state machine controller for pc-orchestrator workflows."""

from datetime import datetime, timezone
import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict, Tuple


def check_workspace_config(repo_dir: Path) -> Tuple[bool, str]:
    """Check workspace configuration existence and validity."""
    config_file = repo_dir / ".paper-craft" / "workspace-config.json"
    legacy_file = repo_dir / ".paper-craft" / "workspace.json"
    target_file = config_file if config_file.exists() else legacy_file

    if not target_file.exists():
        return False, (
            f"Error: Workspace configuration is missing at {config_file}.\n"
            f"Please run 'pc-workspace-config' to initialize the workspace before starting pc-orchestrator."
        )

    try:
        with open(target_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return False, (
            f"Error: Workspace configuration at {target_file} is corrupted: {e}.\n"
            f"Please run 'pc-workspace-config' to reconfigure."
        )

    if not isinstance(data, dict):
        return False, "Error: Workspace configuration must be a JSON object."

    if data.get("schema_version") != "1.0":
        return False, f"Error: Unsupported schema_version '{data.get('schema_version')}'. Expected '1.0'."

    for field in ("delivery_target", "base_remote", "push_remote", "base_branch", "worktree_container"):
        val = data.get(field)
        if not val or not isinstance(val, str) or not val.strip():
            return False, f"Error: Configuration field '{field}' is missing or empty. Please run 'pc-workspace-config' to reconfigure."

    return True, f"Workspace configuration is valid: {target_file}"


def get_state_file_path(receipt_root: str) -> Path:
    root = Path(receipt_root).resolve()
    # Fallback to workflow-state.json if it already exists, otherwise canonical state.json
    legacy_file = root / "workflow-state.json"
    canonical_file = root / "state.json"
    if legacy_file.exists() and not canonical_file.exists():
        return legacy_file
    return canonical_file


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


def load_state(receipt_root: str) -> Dict[str, Any]:
    state_file = get_state_file_path(receipt_root)
    if not state_file.exists():
        sys.stderr.write(f"Error: State file not found at {state_file}. Run 'init' first.\n")
        sys.exit(1)
    try:
        with open(state_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        sys.stderr.write(f"Error: Corrupted state file at {state_file}: {e}\n")
        sys.exit(1)


def cmd_init(args: argparse.Namespace) -> None:
    if getattr(args, "require_config", False):
        repo_dir = Path(getattr(args, "repo_dir", ".")).resolve()
        ok, msg = check_workspace_config(repo_dir)
        if not ok:
            sys.stderr.write(msg + "\n")
            sys.exit(1)

    state_file = get_state_file_path(args.receipt_root)
    if state_file.exists() and not args.force:
        existing = load_state(args.receipt_root)
        if str(existing.get("root_issue_id")) == str(args.root_issue):
            print(json.dumps(existing, indent=2, ensure_ascii=False))
            return
        sys.stderr.write(
            f"Error: State file already exists for root issue {existing.get('root_issue_id')} at {state_file}. Use --force to overwrite.\n"
        )
        sys.exit(1)

    now = datetime.now(timezone.utc).isoformat()
    initial_state = {
        "root_issue_id": str(args.root_issue),
        "current_issue_id": str(args.current_issue or args.root_issue),
        "workflow": args.workflow or "default",
        "current_stage": args.initial_stage or "stage_1_plan",
        "stage_status": "pending",
        "completed_stages": [],
        "budgets": {
            "delivery_attempts_used": 0,
            "replans_used": 0,
        },
        "context": {},
        "last_updated": now,
    }
    atomic_write_json(state_file, initial_state)
    print(json.dumps(initial_state, indent=2, ensure_ascii=False))


def cmd_transition(args: argparse.Namespace) -> None:
    state = load_state(args.receipt_root)

    prev_stage = state.get("current_stage")
    now = datetime.now(timezone.utc).isoformat()

    if args.current_issue:
        state["current_issue_id"] = str(args.current_issue)

    if "context" not in state:
        state["context"] = {}

    if args.set:
        for item in args.set:
            if "=" not in item:
                sys.stderr.write(f"Error: Invalid --set format '{item}'. Expected key=value.\n")
                sys.exit(1)
            key, val = item.split("=", 1)
            state["context"][key.strip()] = val.strip()

    if "budgets" not in state:
        state["budgets"] = {"delivery_attempts_used": 0, "replans_used": 0}

    if args.incr_budget:
        budget_key = args.incr_budget
        if budget_key not in state["budgets"]:
            state["budgets"][budget_key] = 0
        state["budgets"][budget_key] += 1

    # Record completed stages if concluding or advancing
    record_history = False
    if args.outcome or args.receipt or args.status in ("succeeded", "failed", "blocked", "halted"):
        record_history = True

    if record_history:
        commit = state.get("context", {}).get("commit") or state.get("context", {}).get("merged_commit")
        history_entry = {
            "stage": prev_stage,
            "status": args.status,
            "outcome": args.outcome or None,
            "receipt_path": args.receipt or None,
            "commit": commit,
            "timestamp": now,
        }
        if "completed_stages" not in state:
            state["completed_stages"] = state.get("history", [])
        state["completed_stages"].append(history_entry)

    state["current_stage"] = args.stage
    state["stage_status"] = args.status
    state["last_updated"] = now

    state_file = get_state_file_path(args.receipt_root)
    atomic_write_json(state_file, state)
    print(json.dumps(state, indent=2, ensure_ascii=False))


def cmd_show(args: argparse.Namespace) -> None:
    state = load_state(args.receipt_root)
    if args.json:
        print(json.dumps(state, indent=2, ensure_ascii=False))
        return

    if args.field:
        keys = args.field.split(".")
        val: Any = state
        for k in keys:
            if isinstance(val, dict) and k in val:
                val = val[k]
            else:
                sys.stderr.write(f"Error: Field '{args.field}' not found in state.\n")
                sys.exit(1)
        if isinstance(val, (dict, list)):
            print(json.dumps(val, indent=2, ensure_ascii=False))
        else:
            print(val)
        return

    # Compact readable summary
    completed = state.get("completed_stages") or state.get("history", [])
    history_count = len(completed)
    print(f"Workflow: {state.get('workflow')}")
    print(f"Root Issue: #{state.get('root_issue_id')} | Current Issue: #{state.get('current_issue_id')}")
    print(f"Current Stage: {state.get('current_stage')} [{state.get('stage_status')}]")
    print(f"Budgets: Delivery attempts={state.get('budgets', {}).get('delivery_attempts_used', 0)}, Replans={state.get('budgets', {}).get('replans_used', 0)}")
    print(f"Completed stages: {history_count}")
    print(f"Last updated: {state.get('last_updated')}")
    if state.get("context"):
        print(f"Context: {json.dumps(state.get('context'), ensure_ascii=False)}")


def cmd_check_budget(args: argparse.Namespace) -> None:
    state = load_state(args.receipt_root)
    b_type = args.type.lower()
    if b_type in ("delivery", "delivery_attempts", "delivery_attempts_used"):
        key = "delivery_attempts_used"
    elif b_type in ("replan", "replans", "replans_used"):
        key = "replans_used"
    else:
        sys.stderr.write(f"Error: Unknown budget type '{args.type}'. Allowed: delivery, replan.\n")
        sys.exit(1)

    used = state.get("budgets", {}).get(key, 0)
    limit = args.limit

    if used >= limit:
        sys.stderr.write(
            f"Budget exceeded: {key} is {used}, limit is {limit}. Halt and present Blocker Decision Board.\n"
        )
        sys.exit(1)

    print(f"Budget OK: {key} is {used}/{limit}.")


def cmd_check_config(args: argparse.Namespace) -> None:
    repo_dir = Path(getattr(args, "repo_dir", ".")).resolve()
    ok, msg = check_workspace_config(repo_dir)
    if not ok:
        sys.stderr.write(msg + "\n")
        sys.exit(1)
    if getattr(args, "json", False):
        config_file = repo_dir / ".paper-craft" / "workspace-config.json"
        legacy_file = repo_dir / ".paper-craft" / "workspace.json"
        target_file = config_file if config_file.exists() else legacy_file
        with open(target_file, "r", encoding="utf-8") as f:
            print(f.read().strip())
    else:
        print(msg)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Deterministic state machine controller for pc-orchestrator workflows."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # init
    init_parser = subparsers.add_parser("init", help="Initialize workflow state snapshot.")
    init_parser.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    init_parser.add_argument("--root-issue", required=True, help="Root GitHub issue number.")
    init_parser.add_argument("--current-issue", help="Initial current issue number (defaults to root issue).")
    init_parser.add_argument("--workflow", default="default", help="Workflow name (defaults to 'default').")
    init_parser.add_argument("--initial-stage", default="stage_1_plan", help="Initial stage name.")
    init_parser.add_argument("--force", action="store_true", help="Force overwrite existing state file.")
    init_parser.add_argument("--require-config", action="store_true", help="Require valid workspace configuration.")
    init_parser.add_argument("--repo-dir", default=".", help="Repository root containing .paper-craft/")
    init_parser.set_defaults(func=cmd_init)

    # check-config
    cfg_parser = subparsers.add_parser("check-config", help="Check workspace configuration existence and validity.")
    cfg_parser.add_argument("--repo-dir", default=".", help="Path to repository root.")
    cfg_parser.add_argument("--json", action="store_true", help="Output config JSON if valid.")
    cfg_parser.set_defaults(func=cmd_check_config)

    # transition
    trans_parser = subparsers.add_parser("transition", help="Transition workflow to next stage or status.")
    trans_parser.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    trans_parser.add_argument("--stage", required=True, help="Target stage name.")
    trans_parser.add_argument("--status", required=True, choices=["pending", "in_progress", "succeeded", "failed", "blocked", "halted"], help="Stage status.")
    trans_parser.add_argument("--outcome", help="Professional outcome (e.g. direct, decomposed, landed, verified).")
    trans_parser.add_argument("--receipt", help="Absolute path to stage receipt file.")
    trans_parser.add_argument("--current-issue", help="Update current issue ID.")
    trans_parser.add_argument("--set", action="append", help="Set context key=value (can be used multiple times).")
    trans_parser.add_argument("--incr-budget", choices=["delivery_attempts_used", "replans_used"], help="Increment a budget counter.")
    trans_parser.set_defaults(func=cmd_transition)

    # show
    show_parser = subparsers.add_parser("show", help="Display workflow state.")
    show_parser.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    show_parser.add_argument("--json", action="store_true", help="Output full state as JSON.")
    show_parser.add_argument("--field", help="Get a specific nested field (e.g. context.commit).")
    show_parser.set_defaults(func=cmd_show)

    # check-budget
    budget_parser = subparsers.add_parser("check-budget", help="Check if budget limit is exceeded.")
    budget_parser.add_argument("--receipt-root", required=True, help="Absolute path to receipts root directory.")
    budget_parser.add_argument("--type", required=True, help="Budget type: 'delivery' or 'replan'.")
    budget_parser.add_argument("--limit", type=int, required=True, help="Budget limit threshold.")
    budget_parser.set_defaults(func=cmd_check_budget)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
