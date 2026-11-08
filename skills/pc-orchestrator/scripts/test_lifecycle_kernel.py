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
        template = Path(env_data["contract"]["receipt_template"])
        self.assertTrue(template.is_absolute())
        self.assertEqual(template, SCRIPT_PATH.parent.parent / "templates" / "subagent-receipt.template.md")
        self.assertTrue(template.read_text(encoding="utf-8"))

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

        # Conflicting call with different workdir while previous dispatch is active
        res_workdir_conflict = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 41",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
            "--workdir", str(self.receipt_root / "different-workdir"),
        )
        self.assertNotEqual(res_workdir_conflict.returncode, 0)
        self.assertIn("active dispatch", res_workdir_conflict.stderr.lower())

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

    def test_duplicate_and_conflicting_complete(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        prep_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        prep = json.loads(prep_res.stdout)
        receipt_path = Path(prep["receipt_path"])
        dispatch_id = prep["dispatch_id"]
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))

        with open(receipt_path, "w", encoding="utf-8") as f:
            f.write("# Stage 1 Plan\nOutcome: planned\n")

        report = {
            "execution_status": "succeeded",
            "result": {"outcome": "planned"},
            "receipt_path": str(receipt_path),
            "summary": "Plan created",
        }
        res1 = self.run_cli(
            "complete",
            "--receipt-root", str(self.receipt_root),
            "--report", json.dumps(report),
            "--dispatch-id", dispatch_id,
        )
        self.assertEqual(res1.returncode, 0, res1.stderr)
        first_comp = json.loads(res1.stdout)

        # 1. Duplicate complete call with identical report and dispatch_id
        res2 = self.run_cli(
            "complete",
            "--receipt-root", str(self.receipt_root),
            "--report", json.dumps(report),
            "--dispatch-id", dispatch_id,
        )
        self.assertEqual(res2.returncode, 0, res2.stderr)
        dup_comp = json.loads(res2.stdout)
        self.assertEqual(first_comp["dispatch_id"], dup_comp["dispatch_id"])

        # Check completed_stages count is still 1
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(len(state["completed_stages"]), 1)
        self.assertEqual(state["budgets"]["delivery_attempts_used"], 1)

        # 2. Conflicting complete call for already settled dispatch is rejected
        conflicting_report = dict(report)
        conflicting_report["execution_status"] = "failed"
        res3 = self.run_cli(
            "complete",
            "--receipt-root", str(self.receipt_root),
            "--report", json.dumps(conflicting_report),
            "--dispatch-id", dispatch_id,
        )
        self.assertNotEqual(res3.returncode, 0)
        self.assertIn("conflict", res3.stderr.lower())

        # State not overwritten
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["completed_stages"][0]["execution_status"], "succeeded")

    def test_budget_exhaustion_strictly_rejects_new_attempts_and_zero_max(self):
        # Zero max attempts should immediately reject
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "42",
            "--delivery-attempts-max", "0",
            "--force",
        )
        res0 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.assertNotEqual(res0.returncode, 0)
        self.assertIn("budget exceeded", res0.stderr.lower())

        # Max 2 attempts: attempt 1 used, attempt 2 used, attempt 3 rejected
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "42",
            "--delivery-attempts-max", "2",
            "--force",
        )
        # Attempt 1
        p1 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.assertEqual(p1.returncode, 0, p1.stderr)
        d1 = json.loads(p1.stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        with open(d1["receipt_path"], "w", encoding="utf-8") as f:
            f.write("# Receipt\nOutcome: rework_needed\n")
        self.run_cli(
            "complete",
            "--receipt-root", str(self.receipt_root),
            "--report", json.dumps({
                "execution_status": "succeeded",
                "result": {"outcome": "rework_needed"},
                "receipt_path": d1["receipt_path"],
                "summary": "Plan needs rework",
            }),
        )

        # Attempt 2 with attempt-intent new
        p2 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Re-plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
            "--attempt-intent", "new",
        )
        self.assertEqual(p2.returncode, 0, p2.stderr)
        d2 = json.loads(p2.stdout)
        self.assertEqual(d2["attempt"], 2)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        with open(d2["receipt_path"], "w", encoding="utf-8") as f:
            f.write("# Receipt 2\nOutcome: rework_needed\n")
        self.run_cli(
            "complete",
            "--receipt-root", str(self.receipt_root),
            "--report", json.dumps({
                "execution_status": "succeeded",
                "result": {"outcome": "rework_needed"},
                "receipt_path": d2["receipt_path"],
                "summary": "Re-plan still needs rework",
            }),
        )

        # Attempt 3 with attempt-intent new must be rejected
        p3 = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Re-plan issue 42 third time",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
            "--attempt-intent", "new",
        )
        self.assertNotEqual(p3.returncode, 0)
        self.assertIn("budget exceeded", p3.stderr.lower())

    def test_report_protocol_errors_record_inspect_visible_blockers(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        prep_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        prep = json.loads(prep_res.stdout)
        assigned_receipt = Path(prep["receipt_path"])
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))

        # 1. Malformed report (missing 'summary')
        bad_rep1 = {
            "execution_status": "succeeded",
            "result": {"outcome": "planned"},
            "receipt_path": str(assigned_receipt),
        }
        res1 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(bad_rep1))
        self.assertNotEqual(res1.returncode, 0)

        # Inspect must show protocol error blocking reason
        insp1 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertTrue(any("summary" in r.lower() or "protocol error" in r.lower() for r in insp1["blocking_reasons"]))
        self.assertIsNotNone(insp1["active_dispatch"])

        # 2. Receipt path mismatch
        bad_rep2 = {
            "execution_status": "succeeded",
            "result": {"outcome": "planned"},
            "receipt_path": str(self.receipt_root / "wrong-receipt.md"),
            "summary": "Mismatched receipt path",
        }
        res2 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(bad_rep2))
        self.assertNotEqual(res2.returncode, 0)
        insp2 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertTrue(any("mismatch" in r.lower() or "protocol error" in r.lower() for r in insp2["blocking_reasons"]))

        # 3. Receipt missing on disk
        valid_rep = {
            "execution_status": "succeeded",
            "result": {"outcome": "planned"},
            "receipt_path": str(assigned_receipt),
            "summary": "Plan ready",
        }
        res3 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(valid_rep))
        self.assertNotEqual(res3.returncode, 0)
        insp3 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertTrue(any("missing" in r.lower() or "protocol error" in r.lower() for r in insp3["blocking_reasons"]))

        # 4. Receipt file is empty (0 bytes)
        assigned_receipt.touch()
        self.assertEqual(assigned_receipt.stat().st_size, 0)
        res4 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(valid_rep))
        self.assertNotEqual(res4.returncode, 0)
        insp4 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertTrue(any("empty" in r.lower() or "protocol error" in r.lower() for r in insp4["blocking_reasons"]))

        # 5. Provide valid non-empty receipt and complete: clears error
        with open(assigned_receipt, "w", encoding="utf-8") as f:
            f.write("# Plan Receipt\nOutcome: planned\n")
        res5 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(valid_rep))
        self.assertEqual(res5.returncode, 0, res5.stderr)
        insp5 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertIsNone(insp5["active_dispatch"])
        self.assertEqual(insp5["blocking_reasons"], [])

    def test_rework_needed_outcome_recorded_as_specialist_result_not_business_acceptance(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        prep_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_work",
            "--objective", "Implement feature",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-work",
        )
        prep = json.loads(prep_res.stdout)
        receipt_path = Path(prep["receipt_path"])
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))

        with open(receipt_path, "w", encoding="utf-8") as f:
            f.write("# Receipt\nOutcome: rework_needed\nFindings: tests failed in edge case\n")

        rep = {
            "execution_status": "succeeded",
            "result": {"outcome": "rework_needed", "findings": "tests failed in edge case"},
            "receipt_path": str(receipt_path),
            "summary": "Specialist completed evaluation with rework_needed",
        }
        comp_res = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep))
        self.assertEqual(comp_res.returncode, 0, comp_res.stderr)
        comp_data = json.loads(comp_res.stdout)
        self.assertEqual(comp_data["execution_status"], "succeeded")
        self.assertEqual(comp_data["result"]["outcome"], "rework_needed")

        # In state: stage_status is not 'succeeded'
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertNotEqual(state["stage_status"], "succeeded")
        self.assertEqual(state["stage_status"], "needs_rework")

        # Calling resolve finish MUST be rejected because rework_needed is not business acceptance
        res_finish = self.run_cli(
            "resolve",
            "--receipt-root", str(self.receipt_root),
            "--decision", "finish",
            "--reason", "Attempting premature finish with rework_needed",
        )
        self.assertNotEqual(res_finish.returncode, 0)
        self.assertIn("rework_needed", res_finish.stderr.lower())

    def test_prepare_interrupted_commit_point_recovery(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")

        # Simulate interrupted prepare: envelope 01-input.json was generated and written,
        # but state.json was not yet committed.
        env_path = self.receipt_root / "01-input.json"
        receipt_path = self.receipt_root / "01-stage_1_plan-issue-42-try-1.md"
        envelope_data = {
            "schema_version": "1.0",
            "task": {
                "logical_stage": "stage_1_plan",
                "step_index": 1,
                "attempt": 1,
                "root_issue_id": "42",
                "current_issue_id": "42",
            },
            "provider": {
                "type": "skill",
                "target": "pc-issue-plan",
                "args": [],
            },
            "environment": {
                "working_directory": str(Path.cwd()),
                "repository": "local/repo",
                "base_branch": "main",
                "branch": None,
                "commit": None,
            },
            "inputs": {
                "objective": "Plan issue 42 after crash",
                "scope": "",
                "acceptance_criteria": ["Plan approved"],
                "predecessor_receipts": [],
                "parameters": {},
            },
            "contract": {
                "receipt_path": str(receipt_path),
                "receipt_template": "templates/subagent-receipt.template.md",
            },
            "budgets": {
                "delivery_attempts_used": 1,
                "delivery_attempts_max": 3,
                "replans_used": 0,
                "replans_max": 2,
            },
        }
        with open(env_path, "w", encoding="utf-8") as f:
            json.dump(envelope_data, f, indent=2)

        # Calling prepare with a conflicting task while an uncommitted envelope exists MUST fail
        # and MUST NOT overwrite the uncommitted envelope
        conf_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_work",
            "--objective", "Conflicting work",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-work",
        )
        self.assertNotEqual(conf_res.returncode, 0)
        with open(env_path, "r", encoding="utf-8") as f:
            persisted_env = json.load(f)
        self.assertEqual(persisted_env["task"]["logical_stage"], "stage_1_plan")

        # Call prepare with identical task: should recover from uncommitted envelope
        prep_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42 after crash",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
            "--criteria", "Plan approved",
        )
        self.assertEqual(prep_res.returncode, 0, prep_res.stderr)
        prep = json.loads(prep_res.stdout)
        self.assertEqual(prep["step_index"], 1)
        self.assertEqual(prep["attempt"], 1)
        self.assertEqual(prep["envelope_path"], str(env_path))

        # Check state: committed properly without double-incrementing step_index or budgets
        with open(self.receipt_root / "state.json", "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["next_step_index"], 2)
        self.assertEqual(state["budgets"]["delivery_attempts_used"], 1)
        self.assertIsNotNone(state.get("active_dispatch"))
        self.assertEqual(state["active_dispatch"]["step_index"], 1)

    def test_unconfirmed_handed_off_dispatch_across_reload_refuses_auto_retry(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        prep_res = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        prep = json.loads(prep_res.stdout)
        receipt_path = Path(prep["receipt_path"])

        # Handoff
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))

        # Inspect shows in-flight unconfirmed execution
        insp = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp["active_dispatch"]["status"], "handed_off")
        self.assertTrue(any("unconfirmed" in r.lower() or "in flight" in r.lower() for r in insp["blocking_reasons"]))

        # Prepare refuses auto-retry
        p_again = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.assertNotEqual(p_again.returncode, 0)
        self.assertIn("already been handed off", p_again.stderr.lower())

        # Duplicate handoff refuses new authorization
        h_again = json.loads(self.run_cli("handoff", "--receipt-root", str(self.receipt_root)).stdout)
        self.assertFalse(h_again["authorized"])

        # Existence of receipt on disk alone does NOT settle the dispatch
        with open(receipt_path, "w", encoding="utf-8") as f:
            f.write("# Receipt\nOutcome: planned\n")
        insp2 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertIsNotNone(insp2["active_dispatch"])
        self.assertEqual(insp2["completed_stages_count"], 0)

    def test_decisions_persist_across_reload_and_continue_cannot_bypass_unconfirmed_execution(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_1_plan",
            "--objective", "Plan issue 42",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-plan",
        )
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))

        # 1. Resolve wait_user
        res1 = self.run_cli(
            "resolve",
            "--receipt-root", str(self.receipt_root),
            "--decision", "wait_user",
            "--reason", "Awaiting human review of architectural trade-offs",
        )
        self.assertEqual(res1.returncode, 0, res1.stderr)

        # Inspect confirms blocked and wait_user decision persisted
        insp1 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp1["stage_status"], "blocked")
        self.assertEqual(insp1["last_decision"]["decision"], "wait_user")
        self.assertTrue(any("blocked" in r.lower() for r in insp1["blocking_reasons"]))

        # 2. Resolve continue cannot bypass in-flight execution
        res2 = self.run_cli(
            "resolve",
            "--receipt-root", str(self.receipt_root),
            "--decision", "continue",
            "--reason", "Human approved continuation",
        )
        self.assertEqual(res2.returncode, 0, res2.stderr)
        insp2 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        # Active dispatch is still in-flight handed_off, stage_status reverts to in_progress
        self.assertIsNotNone(insp2["active_dispatch"])
        self.assertEqual(insp2["stage_status"], "in_progress")
        self.assertTrue(any("in flight" in r.lower() or "unconfirmed" in r.lower() for r in insp2["blocking_reasons"]))

        # Premature finish while dispatch is in flight must fail
        res_finish = self.run_cli(
            "resolve",
            "--receipt-root", str(self.receipt_root),
            "--decision", "finish",
            "--reason", "Try to finish with in-flight task",
        )
        self.assertNotEqual(res_finish.returncode, 0)
        self.assertIn("in flight", res_finish.stderr.lower())

        # 3. Halt persists and blocks new actions
        res3 = self.run_cli(
            "resolve",
            "--receipt-root", str(self.receipt_root),
            "--decision", "halt",
            "--reason", "Emergency stop due to external blocker",
        )
        self.assertEqual(res3.returncode, 0, res3.stderr)
        insp3 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp3["stage_status"], "halted")

        # Halted workflow rejects new prepare or handoff
        res_prep = self.run_cli(
            "prepare",
            "--receipt-root", str(self.receipt_root),
            "--stage", "stage_2_work",
            "--objective", "Work",
            "--provider-type", "skill",
            "--provider-target", "pc-issue-work",
        )
        self.assertNotEqual(res_prep.returncode, 0)
        self.assertIn("halted", res_prep.stderr.lower())


if __name__ == "__main__":
    unittest.main()
