#!/usr/bin/env python3
"""Unit and integration tests for pc-orchestrator dispatch lifecycle kernel (lifecycle_kernel.py)."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT_PATH = Path(__file__).resolve().parent / "lifecycle_kernel.py"


class TestLifecycleKernel(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.receipt_root = Path(self.temp_dir.name).resolve()

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT_PATH), *args],
            capture_output=True,
            text=True,
        )

    def test_init_creates_state_json_with_expected_schema(self):
        res = self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "41",
        )
        self.assertEqual(res.returncode, 0, res.stderr)

        state_file = self.receipt_root / "state.json"
        self.assertTrue(state_file.exists())

        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)

        self.assertEqual(state["root_issue_id"], "41")
        self.assertEqual(state["current_issue_id"], "41")
        self.assertEqual(state["workflow"], "default")
        self.assertEqual(state["stage_status"], "pending")
        self.assertIsNone(state.get("active_dispatch"))
        self.assertEqual(state["completed_stages"], [])
        self.assertEqual(state["decisions"], [])
        self.assertEqual(state["budgets"]["delivery_attempts_used"], 0)
        self.assertEqual(state["budgets"]["delivery_attempts_max"], 3)
        self.assertEqual(state["budgets"]["replans_used"], 0)
        self.assertEqual(state["budgets"]["replans_max"], 2)
        self.assertIn("last_updated", state)
        self.assertIn("context", state)

    def test_init_idempotency_and_collision_protection(self):
        res1 = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")
        self.assertEqual(res1.returncode, 0, res1.stderr)

        # Same root issue re-init succeeds
        res2 = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")
        self.assertEqual(res2.returncode, 0, res2.stderr)

        # Different root issue without --force fails
        res3 = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "99")
        self.assertNotEqual(res3.returncode, 0)
        self.assertIn("already exists", res3.stderr.lower())

        # Different root issue with --force succeeds
        res4 = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "99", "--force")
        self.assertEqual(res4.returncode, 0, res4.stderr)
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["root_issue_id"], "99")

    def test_prepare_allocates_step_and_generates_envelope_and_receipt_path(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
            "--criteria", "Plan created",
            "--criteria", "Tests budgeted",
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        data = json.loads(res.stdout)
        self.assertEqual(data["step_index"], 1)
        self.assertEqual(data["attempt"], 1)
        self.assertEqual(data["status"], "prepared")
        self.assertTrue(data["dispatch_id"].startswith("01-stage_1_plan-issue-41-try-1"))

        expected_envelope = self.receipt_root / "01-input.json"
        expected_receipt = self.receipt_root / "01-stage_1_plan-issue-41-try-1.md"
        self.assertEqual(data["envelope_path"], str(expected_envelope))
        self.assertEqual(data["receipt_path"], str(expected_receipt))
        self.assertTrue(expected_envelope.exists())

        with open(expected_envelope, "r", encoding="utf-8") as f:
            env_data = json.load(f)
        self.assertEqual(env_data["schema_version"], "1.0")
        self.assertEqual(env_data["task"]["step_index"], 1)
        self.assertEqual(env_data["task"]["logical_stage"], "stage_1_plan")
        self.assertEqual(env_data["provider"]["type"], "skill")
        self.assertEqual(env_data["provider"]["target"], "pc-issue-plan")
        self.assertEqual(env_data["inputs"]["acceptance_criteria"], ["Plan created", "Tests budgeted"])
        self.assertEqual(env_data["contract"]["receipt_path"], str(expected_receipt))

        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["budgets"]["delivery_attempts_used"], 1)
        self.assertIsNotNone(state.get("active_dispatch"))
        self.assertEqual(state["active_dispatch"]["dispatch_id"], data["dispatch_id"])

    def test_prepare_idempotency_and_conflict_rejection(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # First call
        res1 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.assertEqual(res1.returncode, 0, res1.stderr)
        d1 = json.loads(res1.stdout)

        # Idempotent re-call with same parameters
        res2 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.assertEqual(res2.returncode, 0, res2.stderr)
        d2 = json.loads(res2.stdout)
        self.assertEqual(d1["dispatch_id"], d2["dispatch_id"])
        self.assertEqual(d1["step_index"], d2["step_index"])

        # Conflicting call with different stage while previous dispatch is active
        res3 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_work",
            "--objective", "Implement issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-work",
        )
        self.assertNotEqual(res3.returncode, 0)
        self.assertIn("active dispatch", res3.stderr.lower())

    def test_prepare_budget_exhaustion(self):
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "41",
            "--delivery-attempts-max", "1",
        )
        # First task (attempt 1) consumes the only attempt
        res1 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.assertEqual(res1.returncode, 0, res1.stderr)

        # Simulating completing or cancelling to clear active dispatch
        state_file = self.receipt_root / "state.json"
        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        state["active_dispatch"] = None
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(state, f)

        # Attempting a second attempt with --attempt-intent new should be rejected
        res2 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Re-plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
            "--attempt-intent", "new",
        )
        self.assertNotEqual(res2.returncode, 0)
        self.assertIn("budget exceeded", res2.stderr.lower())

    def test_handoff_authorization_boundary(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # Handoff with no active dispatch fails
        res0 = self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        self.assertNotEqual(res0.returncode, 0)
        self.assertIn("no active dispatch", res0.stderr.lower())

        # Prepare a task
        prep_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.assertEqual(prep_res.returncode, 0, prep_res.stderr)
        prep_data = json.loads(prep_res.stdout)
        dispatch_id = prep_data["dispatch_id"]

        # First handoff: grants launch authorization
        res1 = self.run_cli(
            "handoff",
            "--receipt-root", str(self.receipt_root),
            "--dispatch-id", dispatch_id,
            "--platform-handle", "subagent-conv-12345",
        )
        self.assertEqual(res1.returncode, 0, res1.stderr)
        d1 = json.loads(res1.stdout)
        self.assertTrue(d1["authorized"])
        self.assertEqual(d1["status"], "handed_off")
        self.assertEqual(d1["platform_handle"], "subagent-conv-12345")

        # State check
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["active_dispatch"]["status"], "handed_off")
        self.assertTrue(state["active_dispatch"]["authorized"])
        self.assertEqual(state["active_dispatch"]["platform_handle"], "subagent-conv-12345")

        # Second handoff: MUST NOT grant authorization
        res2 = self.run_cli(
            "handoff",
            "--receipt-root", str(self.receipt_root),
            "--dispatch-id", dispatch_id,
        )
        self.assertEqual(res2.returncode, 0, res2.stderr)
        d2 = json.loads(res2.stdout)
        self.assertFalse(d2["authorized"])
        self.assertIn("already", d2.get("message", "").lower())

    def test_complete_requires_handoff_and_existing_nonempty_receipt(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        prep_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        prep = json.loads(prep_res.stdout)
        receipt_path = Path(prep["receipt_path"])

        # 1. Complete before handoff must fail
        report = {
            "execution_status": "succeeded",
            "result": {"outcome": "planned"},
            "receipt_path": str(receipt_path),
            "summary": "Plan created",
        }
        res1 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(report))
        self.assertNotEqual(res1.returncode, 0)
        self.assertIn("not been handed off", res1.stderr.lower())

        # Now handoff
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))

        # 2. Complete when receipt file does not exist on disk must fail
        res2 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(report))
        self.assertNotEqual(res2.returncode, 0)
        self.assertIn("receipt file missing", res2.stderr.lower())

        # 3. Complete when receipt file exists but is 0 bytes must fail
        receipt_path.touch()
        self.assertEqual(receipt_path.stat().st_size, 0)
        res3 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(report))
        self.assertNotEqual(res3.returncode, 0)
        self.assertIn("empty", res3.stderr.lower())

        # 4. Complete with valid non-empty receipt succeeds
        with open(receipt_path, "w", encoding="utf-8") as f:
            f.write("# Receipt\nOutcome: rework_needed\n")

        report["result"] = {"outcome": "rework_needed"}
        res4 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(report))
        self.assertEqual(res4.returncode, 0, res4.stderr)
        c_data = json.loads(res4.stdout)
        self.assertEqual(c_data["execution_status"], "succeeded")
        self.assertEqual(c_data["result"]["outcome"], "rework_needed")

        # Verify state
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertIsNone(state.get("active_dispatch"))
        self.assertEqual(len(state["completed_stages"]), 1)
        self.assertEqual(state["completed_stages"][0]["execution_status"], "succeeded")
        self.assertEqual(state["completed_stages"][0]["result"]["outcome"], "rework_needed")

    def test_resolve_records_orchestrator_decision(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # Resolve halt with reason and options
        res = self.run_cli(
            "resolve",
            "--receipt-root", str(self.receipt_root),
            "--decision", "halt",
            "--reason", "Human steering required for plan revision",
            "--option", "Approve alternative plan",
            "--option", "Abort workflow",
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        d = json.loads(res.stdout)
        self.assertEqual(d["decision"], "halt")
        self.assertEqual(d["reason"], "Human steering required for plan revision")
        self.assertEqual(len(d["options"]), 2)

        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["stage_status"], "halted")
        self.assertEqual(state["orchestrator_decision"], "halt")
        self.assertEqual(len(state["decisions"]), 1)
        self.assertEqual(state["decisions"][0]["decision"], "halt")

    def test_inspect_reports_state_active_dispatch_and_blocking_reasons(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # Before any prepare: inspect shows no active dispatch and no blocking reasons
        res1 = self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(res1.returncode, 0, res1.stderr)
        info1 = json.loads(res1.stdout)
        self.assertIsNone(info1["active_dispatch"])
        self.assertEqual(info1["blocking_reasons"], [])

        # Prepare a task: inspect shows active dispatch and blocking reason
        self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        res2 = self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(res2.returncode, 0, res2.stderr)
        info2 = json.loads(res2.stdout)
        self.assertIsNotNone(info2["active_dispatch"])
        self.assertTrue(len(info2["blocking_reasons"]) > 0)
        self.assertIn("not yet handed off", info2["blocking_reasons"][0].lower())

    def test_normal_closed_loop_multiple_dispatches_single_delivery_attempt(self):
        # 1. init
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # 2. prepare task 1 (stage_1_plan)
        p1_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
            "--criteria", "Plan drafted",
        )
        self.assertEqual(p1_res.returncode, 0, p1_res.stderr)
        p1 = json.loads(p1_res.stdout)
        self.assertEqual(p1["step_index"], 1)
        self.assertEqual(p1["attempt"], 1)
        self.assertEqual(p1["status"], "prepared")
        dispatch_id_1 = p1["dispatch_id"]
        receipt_1 = Path(p1["receipt_path"])
        envelope_1 = Path(p1["envelope_path"])
        self.assertTrue(envelope_1.exists())

        # 3. handoff task 1
        h1_res = self.run_cli("handoff", "--receipt-root", str(self.receipt_root), "--dispatch-id", dispatch_id_1)
        self.assertEqual(h1_res.returncode, 0, h1_res.stderr)
        self.assertTrue(json.loads(h1_res.stdout)["authorized"])

        # 4. Mock receipt 1
        with open(receipt_1, "w", encoding="utf-8") as f:
            f.write("# Stage 1 Plan Receipt\nOutcome: planned\n")

        # 5. complete task 1
        rep1 = {
            "execution_status": "succeeded",
            "result": {"outcome": "planned", "stages": 2},
            "receipt_path": str(receipt_1),
            "summary": "Plan created successfully",
        }
        c1_res = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep1))
        self.assertEqual(c1_res.returncode, 0, c1_res.stderr)

        # Verify budget after task 1
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["budgets"]["delivery_attempts_used"], 1)
        self.assertIsNone(state.get("active_dispatch"))

        # 6. prepare task 2 (stage_2_work) within same attempt (--attempt-intent same)
        p2_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_work",
            "--objective", "Implement issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-work",
            "--attempt-intent", "same",
            "--criteria", "Tests pass",
        )
        self.assertEqual(p2_res.returncode, 0, p2_res.stderr)
        p2 = json.loads(p2_res.stdout)
        self.assertEqual(p2["step_index"], 2)
        self.assertEqual(p2["attempt"], 1)
        dispatch_id_2 = p2["dispatch_id"]
        receipt_2 = Path(p2["receipt_path"])
        envelope_2 = Path(p2["envelope_path"])
        self.assertTrue(envelope_2.exists())

        # Verify independent dispatch identity
        self.assertNotEqual(dispatch_id_1, dispatch_id_2)
        self.assertNotEqual(str(receipt_1), str(receipt_2))
        self.assertNotEqual(str(envelope_1), str(envelope_2))

        # Check delivery budget is STILL 1 (counted only once for the attempt)
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["budgets"]["delivery_attempts_used"], 1)

        # 7. handoff task 2
        h2_res = self.run_cli("handoff", "--receipt-root", str(self.receipt_root), "--dispatch-id", dispatch_id_2)
        self.assertEqual(h2_res.returncode, 0, h2_res.stderr)
        self.assertTrue(json.loads(h2_res.stdout)["authorized"])

        # 8. Mock receipt 2
        with open(receipt_2, "w", encoding="utf-8") as f:
            f.write("# Stage 2 Work Receipt\nOutcome: implemented\nCommit: 1a2b3c4d\n")

        # 9. complete task 2
        rep2 = {
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "1a2b3c4d"},
            "receipt_path": str(receipt_2),
            "summary": "Implementation done",
        }
        c2_res = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep2))
        self.assertEqual(c2_res.returncode, 0, c2_res.stderr)

        # 10. resolve finish
        r_res = self.run_cli(
            "resolve",
            "--receipt-root", str(self.receipt_root),
            "--decision", "finish",
            "--reason", "All workflow stages completed and verified",
        )
        self.assertEqual(r_res.returncode, 0, r_res.stderr)

        # 11. inspect final state
        i_res = self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(i_res.returncode, 0, i_res.stderr)
        final_info = json.loads(i_res.stdout)
        self.assertIsNone(final_info["active_dispatch"])
        self.assertEqual(final_info["completed_stages_count"], 2)
        self.assertEqual(final_info["stage_status"], "succeeded")
        self.assertEqual(final_info["budgets"]["delivery_attempts_used"], 1)
        self.assertEqual(final_info["blocking_reasons"], [])


if __name__ == "__main__":
    unittest.main()
