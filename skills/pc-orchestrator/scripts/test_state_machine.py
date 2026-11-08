#!/usr/bin/env python3
"""Unit and integration tests for state_machine.py."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT_PATH = Path(__file__).parent / "state_machine.py"


class TestStateMachine(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.receipt_root = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT_PATH), *args],
            capture_output=True,
            text=True,
        )

    def test_init_creates_state_json_with_default_schema(self):
        res = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        self.assertEqual(res.returncode, 0, res.stderr)

        state_file = self.receipt_root / "state.json"
        self.assertTrue(state_file.exists())

        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)

        self.assertEqual(state["root_issue_id"], "42")
        self.assertEqual(state["current_issue_id"], "42")
        self.assertEqual(state["workflow"], "default")
        self.assertEqual(state["current_stage"], "stage_1_plan")
        self.assertEqual(state["stage_status"], "pending")
        self.assertEqual(state["budgets"]["delivery_attempts_used"], 0)
        self.assertEqual(state["budgets"]["replans_used"], 0)
        self.assertEqual(state["completed_stages"], [])
        self.assertEqual(state["context"], {})
        self.assertIn("last_updated", state)

    def test_init_idempotency_and_collision_protection(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")

        # Idempotent call with same issue succeeds
        res_same = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        self.assertEqual(res_same.returncode, 0)

        # Collision with different issue fails without --force
        res_diff = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "99")
        self.assertEqual(res_diff.returncode, 1)
        self.assertIn("already exists", res_diff.stderr)

        # Succeeded with --force
        res_force = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "99", "--force")
        self.assertEqual(res_force.returncode, 0)

        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["root_issue_id"], "99")

    def test_transition_updates_stage_and_records_history(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")

        res_trans1 = self.run_cli(
            "transition",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_delivery",
            "--status", "succeeded",
            "--outcome", "direct",
            "--receipt", "/abs/path/01-plan.md",
            "--set", "branch=issue-42",
            "--set", "baseBranch=main",
        )
        self.assertEqual(res_trans1.returncode, 0, res_trans1.stderr)

        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)

        self.assertEqual(state["current_stage"], "stage_2_delivery")
        self.assertEqual(state["stage_status"], "succeeded")
        self.assertEqual(state["context"]["branch"], "issue-42")
        self.assertEqual(state["context"]["baseBranch"], "main")
        self.assertEqual(len(state["completed_stages"]), 1)
        self.assertEqual(state["completed_stages"][0]["stage"], "stage_1_plan")
        self.assertEqual(state["completed_stages"][0]["status"], "succeeded")
        self.assertEqual(state["completed_stages"][0]["outcome"], "direct")
        self.assertEqual(state["completed_stages"][0]["receipt_path"], "/abs/path/01-plan.md")

        # Budget increment and context update
        res_trans2 = self.run_cli(
            "transition",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_delivery",
            "--status", "in_progress",
            "--incr-budget", "delivery_attempts_used",
            "--set", "commit=abc1234",
        )
        self.assertEqual(res_trans2.returncode, 0, res_trans2.stderr)

        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)

        self.assertEqual(state["budgets"]["delivery_attempts_used"], 1)
        self.assertEqual(state["context"]["commit"], "abc1234")

    def test_show_formats_and_field_query(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        self.run_cli(
            "transition",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_delivery",
            "--status", "in_progress",
            "--set", "commit=deadbeef",
        )

        # Readable summary
        res_summary = self.run_cli("show", "--receipt-root", str(self.receipt_root))
        self.assertEqual(res_summary.returncode, 0)
        self.assertIn("Root Issue: #42", res_summary.stdout)
        self.assertIn("stage_2_delivery [in_progress]", res_summary.stdout)

        # Raw JSON
        res_json = self.run_cli("show", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(res_json.returncode, 0)
        parsed = json.loads(res_json.stdout)
        self.assertEqual(parsed["root_issue_id"], "42")

        # Single field query
        res_field = self.run_cli("show", "--receipt-root", str(self.receipt_root), "--field", "context.commit")
        self.assertEqual(res_field.returncode, 0)
        self.assertEqual(res_field.stdout.strip(), "deadbeef")

    def test_check_budget_fail_fast(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")

        # 0 / 3 OK
        res_ok = self.run_cli("check-budget", "--receipt-root", str(self.receipt_root), "--type", "delivery", "--limit", "3")
        self.assertEqual(res_ok.returncode, 0)
        self.assertIn("Budget OK", res_ok.stdout)

        # Consume 3 attempts
        for _ in range(3):
            self.run_cli(
                "transition",
                "--receipt-root", str(self.receipt_root),
                "--stage", "stage_2_delivery",
                "--status", "in_progress",
                "--incr-budget", "delivery_attempts_used",
            )

        # Exceeded -> exit code 1
        res_exceeded = self.run_cli("check-budget", "--receipt-root", str(self.receipt_root), "--type", "delivery", "--limit", "3")
        self.assertEqual(res_exceeded.returncode, 1)
        self.assertIn("Budget exceeded: delivery_attempts_used is 3, limit is 3", res_exceeded.stderr)

    def test_check_workspace_config_missing_and_valid(self):
        # 1. Missing config fails and guides user to run pc-workspace-config
        res_missing = self.run_cli("check-config", "--repo-dir", str(self.receipt_root))
        self.assertEqual(res_missing.returncode, 1)
        self.assertIn("pc-workspace-config", res_missing.stderr)
        self.assertIn("missing", res_missing.stderr.lower())

        # 2. Valid config passes
        cfg_dir = self.receipt_root / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "owner/repo",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../project-worktrees",
        }), encoding="utf-8")

        res_ok = self.run_cli("check-config", "--repo-dir", str(self.receipt_root))
        self.assertEqual(res_ok.returncode, 0)
        self.assertIn("valid", res_ok.stdout.lower())

    def test_init_with_require_config(self):
        # Without config, init with --require-config fails
        res_fail = self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "42",
            "--require-config",
            "--repo-dir", str(self.receipt_root),
        )
        self.assertEqual(res_fail.returncode, 1)
        self.assertIn("pc-workspace-config", res_fail.stderr)

        # With config, init with --require-config succeeds
        cfg_dir = self.receipt_root / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "owner/repo",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../project-worktrees",
        }), encoding="utf-8")

        res_ok = self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "42",
            "--require-config",
            "--repo-dir", str(self.receipt_root),
        )
        self.assertEqual(res_ok.returncode, 0)
        self.assertTrue((self.receipt_root / "state.json").exists())


if __name__ == "__main__":
    unittest.main()
