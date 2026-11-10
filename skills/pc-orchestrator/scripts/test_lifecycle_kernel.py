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

    def prepare(self, request):
        request_path = self.receipt_root / "prepare-request.json"
        request_path.write_text(json.dumps(request), encoding="utf-8")
        return self.run_cli(
            "prepare", "--receipt-root", str(self.receipt_root),
            "--request", str(request_path),
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

    def test_init_with_require_config(self):
        repo_dir = self.receipt_root / "repo"
        repo_dir.mkdir(parents=True, exist_ok=True)
        receipts = self.receipt_root / "receipts"
        receipts.mkdir(parents=True, exist_ok=True)

        # Without config, init with --require-config fails and provides clear guidance
        res_fail = self.run_cli(
            "init",
            "--receipt-root", str(receipts),
            "--root-issue", "42",
            "--require-config",
            "--repo-dir", str(repo_dir),
        )
        self.assertEqual(res_fail.returncode, 1)
        self.assertIn("pc-workspace-config", res_fail.stderr)

        # With valid config, init with --require-config succeeds and populates context
        cfg_dir = repo_dir / ".paper-craft"
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
            "--receipt-root", str(receipts),
            "--root-issue", "42",
            "--require-config",
            "--repo-dir", str(repo_dir),
        )
        self.assertEqual(res_ok.returncode, 0, res_ok.stderr)
        state_file = receipts / "state.json"
        self.assertTrue(state_file.exists())
        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        self.assertEqual(state["context"].get("delivery_target"), "owner/repo")
        self.assertEqual(state["context"].get("base_remote"), "origin")

    def test_prepare_allocates_step_and_generates_envelope_and_receipt_path(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        provider_args = ["--repo-dir", "/tmp/repo with spaces", "--workdir", "--", "", "--key=a=b", "quote'\"与换行\n"]
        objective = "--objective-like text\nwith 'quotes' and 中文"
        res = self.prepare({
            "stage": "stage_1_plan",
            "objective": objective,
            "provider": {"type": "skill", "target": "pc-issue-plan", "args": provider_args},
            "acceptance_criteria": ["Plan created", "--criterion-like text"],
            "scope": "--scope-like text",
        })
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
        self.assertEqual(env_data["provider"]["args"], provider_args)
        self.assertEqual(env_data["inputs"]["objective"], objective)
        self.assertEqual(env_data["inputs"]["scope"], "--scope-like text")
        self.assertEqual(env_data["inputs"]["acceptance_criteria"], ["Plan created", "--criterion-like text"])
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

    def test_invalid_prepare_request_leaves_state_and_orphan_envelope_unchanged(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")
        state_path = self.receipt_root / "state.json"
        initial_state = state_path.read_bytes()
        valid = {
            "stage": "stage_1_plan", "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }
        prepared = self.prepare(valid)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        # Leave an envelope awaiting recovery to detect premature workflow state loading.
        state_path.write_bytes(initial_state)
        envelope_path = self.receipt_root / "01-input.json"
        initial_envelope = envelope_path.read_bytes()
        invalid_requests = [
            None, [], {},
            {**valid, "stage": " "},
            {**valid, "objective": 41},
            {**valid, "provider": None},
            {**valid, "provider": {"type": "engine", "target": "operation"}},
            {**valid, "provider": {"type": "skill"}},
            {**valid, "provider": {**valid["provider"], "args": "--repo-dir"}},
            {**valid, "provider": {**valid["provider"], "args": ["--repo-dir", None]}},
            {**valid, "provider": {**valid["provider"], "extra": True}},
            {**valid, "acceptance_criteria": [1]},
            {**valid, "predecessor_receipts": None},
            {**valid, "workdir": ""},
            {**valid, "scope": False},
            {**valid, "attempt_intent": "new_attempt"},
            {**valid, "branch": None},
            {**valid, "commit": 1},
            {**valid, "receipt_template": []},
            {**valid, "parameters": {}},
            {**valid, "step_index": 99},
        ]
        for request in invalid_requests:
            with self.subTest(request=request):
                result = self.prepare(request)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Error:", result.stderr)
                self.assertEqual(state_path.read_bytes(), initial_state)
                self.assertEqual(envelope_path.read_bytes(), initial_envelope)
                self.assertEqual(
                    sorted(path.name for path in self.receipt_root.iterdir()),
                    ["01-input.json", "prepare-request.json", "state.json"],
                )

        request_path = self.receipt_root / "prepare-request.json"
        request_path.write_text("{broken JSON", encoding="utf-8")
        for request_arg, receipt_arg in (
            (str(request_path), str(self.receipt_root)),
            (str(self.receipt_root / "missing.json"), str(self.receipt_root)),
            ("relative-request.json", str(self.receipt_root)),
            (str(request_path), "relative-receipts"),
        ):
            with self.subTest(request_path=request_arg, receipt_root=receipt_arg):
                result = self.run_cli("prepare", "--receipt-root", receipt_arg, "--request", request_arg)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state_path.read_bytes(), initial_state)
                self.assertEqual(envelope_path.read_bytes(), initial_envelope)

    def test_prepare_idempotency_and_conflict_rejection(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # First call
        res1 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        self.assertEqual(res1.returncode, 0, res1.stderr)
        d1 = json.loads(res1.stdout)

        # Idempotent re-call with same parameters
        res2 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        self.assertEqual(res2.returncode, 0, res2.stderr)
        d2 = json.loads(res2.stdout)
        self.assertEqual(d1["dispatch_id"], d2["dispatch_id"])
        self.assertEqual(d1["step_index"], d2["step_index"])

        # Conflicting call with different stage while previous dispatch is active
        res3 = self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement issue 41",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        })
        self.assertNotEqual(res3.returncode, 0)
        self.assertIn("active dispatch", res3.stderr.lower())

        # Conflicting call with different workdir while previous dispatch is active
        res_workdir_conflict = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "workdir": str(self.receipt_root / "different-workdir"),
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        res1 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        self.assertEqual(res1.returncode, 0, res1.stderr)

        # Simulating completing or cancelling to clear active dispatch
        state_file = self.receipt_root / "state.json"
        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        state["active_dispatch"] = None
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(state, f)

        # Attempting a second attempt with attempt_intent=new should be rejected
        res2 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Re-plan issue 41",
            "attempt_intent": "new",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        self.assertNotEqual(res2.returncode, 0)
        self.assertIn("budget exceeded", res2.stderr.lower())

    def test_handoff_authorization_boundary(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # Handoff with no active dispatch fails
        res0 = self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        self.assertNotEqual(res0.returncode, 0)
        self.assertIn("no active dispatch", res0.stderr.lower())

        # Prepare a task
        prep_res = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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

        prep_res = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        res2 = self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(res2.returncode, 0, res2.stderr)
        info2 = json.loads(res2.stdout)
        self.assertIsNotNone(info2["active_dispatch"])
        self.assertTrue(len(info2["blocking_reasons"]) > 0)
        self.assertIn("not yet handed off", info2["blocking_reasons"][0].lower())

    def test_inspect_reports_budget_exhaustion(self):
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "41",
            "--delivery-attempts-max", "3",
            "--replans-max", "2",
        )

        # Initially 0/3 delivery attempts, 0/2 replans: no budget blocking reasons
        res0 = self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(res0.returncode, 0)
        info0 = json.loads(res0.stdout)
        self.assertFalse(any("budget exhausted" in r.lower() for r in info0["blocking_reasons"]))

        # Exhaust delivery attempt budget in state
        state_file = self.receipt_root / "state.json"
        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        state["budgets"]["delivery_attempts_used"] = 3
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(state, f)

        res1 = self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(res1.returncode, 0)
        info1 = json.loads(res1.stdout)
        self.assertTrue(any("delivery attempt budget exhausted" in r.lower() for r in info1["blocking_reasons"]))

        # Also exhaust replan budget
        state["budgets"]["replans_used"] = 2
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(state, f)

        res2 = self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json")
        self.assertEqual(res2.returncode, 0)
        info2 = json.loads(res2.stdout)
        self.assertTrue(any("delivery attempt budget exhausted" in r.lower() for r in info2["blocking_reasons"]))
        self.assertTrue(any("replan budget exhausted" in r.lower() for r in info2["blocking_reasons"]))

    def test_normal_closed_loop_multiple_dispatches_single_delivery_attempt(self):
        # 1. init
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "41")

        # 2. prepare task 1 (stage_1_plan)
        p1_res = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 41",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
            "acceptance_criteria": ["Plan drafted"],
        })
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

        # 6. prepare task 2 (stage_2_work) within same attempt (attempt_intent=same)
        p2_res = self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement issue 41",
            "attempt_intent": "same",
            "provider": {"type": "skill", "target": "pc-issue-work"},
            "acceptance_criteria": ["Tests pass"],
        })
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

        # An implementation receipt cannot bypass issue closure or cleanup.
        premature = self.run_cli("resolve", "--receipt-root", str(self.receipt_root),
                                 "--decision", "finish", "--reason", "Premature")
        self.assertNotEqual(premature.returncode, 0)
        self.assertIn("closure evidence", premature.stderr)
        results = [
            ("issue_finalize", {"outcome": "finalized", "scope": "tree", "root_issue_id": "41",
                                "issues": [{"repository": "test/repo", "number": 41, "state": "CLOSED",
                                            "acceptance_receipt": str(receipt_2)}], "unresolved": [], "candidates": []}),
            ("workspace_cleanup", {"outcome": "incomplete", "retained_paths": [],
                                   "retained_branches": [{"branch": "issue-41", "reason": "New commit"}]}),
            ("workspace_cleanup", {"outcome": "cleaned", "retained_paths": [], "retained_branches": []}),
        ]
        for stage, result in results:
            prepared = self.prepare({"stage": stage, "objective": "Finalize accepted delivery",
                                     "provider": {"type": "skill", "target": "pc-workspace"}})
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            dispatch = json.loads(prepared.stdout)
            self.run_cli("handoff", "--receipt-root", str(self.receipt_root),
                         "--dispatch-id", dispatch["dispatch_id"])
            Path(dispatch["receipt_path"]).write_text("# Finalization evidence\n")
            completed = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report",
                                    json.dumps({"execution_status": "succeeded", "result": result,
                                                "receipt_path": dispatch["receipt_path"], "summary": "Read back state"}))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            if result["outcome"] != "cleaned":
                blocked = self.run_cli("resolve", "--receipt-root", str(self.receipt_root),
                                       "--decision", "finish", "--reason", "Cleanup pending")
                self.assertNotEqual(blocked.returncode, 0)
                self.assertIn("cleanup incomplete", blocked.stderr)

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
        self.assertEqual(final_info["completed_stages_count"], 5)
        self.assertEqual(final_info["stage_status"], "succeeded")
        self.assertEqual(final_info["budgets"]["delivery_attempts_used"], 1)
        self.assertEqual(final_info["blocking_reasons"], [])

    def test_duplicate_and_conflicting_complete(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        prep_res = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        res0 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        p1 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        p2 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Re-plan issue 42",
            "attempt_intent": "new",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        p3 = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Re-plan issue 42 third time",
            "attempt_intent": "new",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        self.assertNotEqual(p3.returncode, 0)
        self.assertIn("budget exceeded", p3.stderr.lower())

    def test_report_protocol_errors_record_inspect_visible_blockers(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "42")
        prep_res = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        prep_res = self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement feature",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        })
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
        conf_res = self.prepare({
            "stage": "stage_2_work",
            "objective": "Conflicting work",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        })
        self.assertNotEqual(conf_res.returncode, 0)
        with open(env_path, "r", encoding="utf-8") as f:
            persisted_env = json.load(f)
        self.assertEqual(persisted_env["task"]["logical_stage"], "stage_1_plan")

        # Call prepare with identical task: should recover from uncommitted envelope
        prep_res = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42 after crash",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
            "acceptance_criteria": ["Plan approved"],
        })
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
        prep_res = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        prep = json.loads(prep_res.stdout)
        receipt_path = Path(prep["receipt_path"])

        # Handoff
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))

        # Inspect shows in-flight unconfirmed execution
        insp = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp["active_dispatch"]["status"], "handed_off")
        self.assertTrue(any("unconfirmed" in r.lower() or "in flight" in r.lower() for r in insp["blocking_reasons"]))

        # Prepare refuses auto-retry
        p_again = self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 42",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
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
        res_prep = self.prepare({
            "stage": "stage_2_work",
            "objective": "Work",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        })
        self.assertNotEqual(res_prep.returncode, 0)
        self.assertIn("halted", res_prep.stderr.lower())

    def test_ordered_delivery_sequence_child_issues_work_to_land_and_return_to_parent(self):
        # 1. init with root issue 44
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "44")

        # 2. plan stage decomposing into two child issues (101, 102)
        p1 = json.loads(self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 44",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p1["receipt_path"]).write_text("# Plan receipt", encoding="utf-8")
        rep_plan = {
            "execution_status": "succeeded",
            "result": {
                "outcome": "decomposed",
                "plan": {
                    "goal": "Deliver issue 44",
                    "tasks": [
                        {"number": 101, "title": "Sub Issue A", "blockedBy": []},
                        {"number": 102, "title": "Sub Issue B", "blockedBy": [101]},
                    ],
                },
            },
            "receipt_path": p1["receipt_path"],
            "summary": "Decomposed into sub-issues 101 and 102",
        }
        c_plan = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_plan))
        self.assertEqual(c_plan.returncode, 0, c_plan.stderr)

        # Verify state after plan: current_issue_id is 101, current_stage is stage_2_work, budget is 0 used
        insp = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp["current_issue_id"], "101")
        self.assertEqual(insp["current_stage"], "stage_2_work")
        self.assertEqual(insp["budgets"]["delivery_attempts_used"], 0)

        # 3. Auxiliary workspace_prepare does not advance delivery sequence
        p_aux = json.loads(self.prepare({
            "stage": "workspace_prepare",
            "objective": "Prepare workspace for 101",
            "provider": {"type": "skill", "target": "pc-workspace"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_aux["receipt_path"]).write_text("# Prep receipt", encoding="utf-8")
        rep_aux = {
            "execution_status": "succeeded",
            "result": {"outcome": "prepared"},
            "receipt_path": p_aux["receipt_path"],
            "summary": "Workspace prepared",
        }
        c_aux = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_aux))
        self.assertEqual(c_aux.returncode, 0, c_aux.stderr)

        insp_aux = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_aux["current_issue_id"], "101")
        self.assertEqual(insp_aux["current_stage"], "stage_2_work")

        # 4. Failed work does not advance sequence
        p_w1_fail = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement 101",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_w1_fail["receipt_path"]).write_text("# Work receipt fail", encoding="utf-8")
        rep_w1_fail = {
            "execution_status": "failed",
            "result": {"outcome": "failed", "error": "build error"},
            "receipt_path": p_w1_fail["receipt_path"],
            "summary": "Build failed",
        }
        c_w1_fail = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_w1_fail))
        self.assertEqual(c_w1_fail.returncode, 0, c_w1_fail.stderr)

        insp_w1_fail = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_w1_fail["current_issue_id"], "101")
        self.assertEqual(insp_w1_fail["current_stage"], "stage_2_work")
        self.assertEqual(insp_w1_fail["stage_status"], "failed")

        # 5. Successful work advances to stage_2_land
        p_w1 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement 101 retry",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_w1["receipt_path"]).write_text("# Work receipt pass", encoding="utf-8")
        rep_w1 = {
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c101"},
            "receipt_path": p_w1["receipt_path"],
            "summary": "Implemented 101",
        }
        c_w1 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_w1))
        self.assertEqual(c_w1.returncode, 0, c_w1.stderr)

        insp_w1 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_w1["current_issue_id"], "101")
        self.assertEqual(insp_w1["current_stage"], "stage_2_land")

        # 6. Non-landed result in land does not advance to issue 102
        p_l1_fail = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 101",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_l1_fail["receipt_path"]).write_text("# Land receipt rework", encoding="utf-8")
        rep_l1_fail = {
            "execution_status": "succeeded",
            "result": {"outcome": "rework_needed", "findings": "CI failed"},
            "receipt_path": p_l1_fail["receipt_path"],
            "summary": "CI failed on PR",
        }
        c_l1_fail = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_l1_fail))
        self.assertEqual(c_l1_fail.returncode, 0, c_l1_fail.stderr)

        insp_l1_fail = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_l1_fail["current_issue_id"], "101")
        self.assertEqual(insp_l1_fail["current_stage"], "stage_2_land")

        # 7. Landed result advances to issue 102 with independent initial budget
        p_l1 = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 101 retry",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_l1["receipt_path"]).write_text("# Land receipt landed", encoding="utf-8")
        rep_l1 = {
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m101"},
            "receipt_path": p_l1["receipt_path"],
            "summary": "PR landed",
        }
        c_l1 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_l1))
        self.assertEqual(c_l1.returncode, 0, c_l1.stderr)

        insp_l1 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_l1["current_issue_id"], "102")
        self.assertEqual(insp_l1["current_stage"], "stage_2_work")
        # Issue 102 has independent initial budget (0 used)
        self.assertEqual(insp_l1["budgets"]["delivery_attempts_used"], 0)

        # 8. Issue 102 workspace_prepare does not advance
        p_aux2 = json.loads(self.prepare({
            "stage": "workspace_prepare",
            "objective": "Prepare workspace for 102",
            "provider": {"type": "skill", "target": "pc-workspace"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_aux2["receipt_path"]).write_text("# Prep receipt 2", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "prepared"},
            "receipt_path": p_aux2["receipt_path"],
            "summary": "Workspace 102 prepared",
        }))

        insp_aux2 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_aux2["current_issue_id"], "102")
        self.assertEqual(insp_aux2["current_stage"], "stage_2_work")

        # 9. Issue 102 work succeeds -> stage_2_land
        p_w2 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement 102",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_w2["receipt_path"]).write_text("# Work receipt 2", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c102"},
            "receipt_path": p_w2["receipt_path"],
            "summary": "Implemented 102",
        }))

        insp_w2 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_w2["current_issue_id"], "102")
        self.assertEqual(insp_w2["current_stage"], "stage_2_land")

        # 10. Issue 102 land succeeds -> returns to parent 44 at stage_3_verify
        p_l2 = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 102",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_l2["receipt_path"]).write_text("# Land receipt 2", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m102"},
            "receipt_path": p_l2["receipt_path"],
            "summary": "PR 102 landed",
        }))

        insp_final = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_final["current_issue_id"], "44")
        self.assertEqual(insp_final["current_stage"], "stage_3_verify")

    def test_direct_root_issue_reuses_single_item_delivery_sequence(self):
        # 1. init with root issue 50
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "50")

        # 2. plan completes with direct outcome
        p1 = json.loads(self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan issue 50",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p1["receipt_path"]).write_text("# Plan direct", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "direct", "summary": "Atomic execution"},
            "receipt_path": p1["receipt_path"],
            "summary": "Direct execution chosen",
        }))

        insp = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp["current_issue_id"], "50")
        self.assertEqual(insp["current_stage"], "stage_2_work")
        self.assertEqual(insp["budgets"]["delivery_attempts_used"], 0)

        # 3. Work stage completes -> stage_2_land
        pw = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement issue 50",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(pw["receipt_path"]).write_text("# Work receipt", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c50"},
            "receipt_path": pw["receipt_path"],
            "summary": "Implemented 50",
        }))

        insp_w = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_w["current_issue_id"], "50")
        self.assertEqual(insp_w["current_stage"], "stage_2_land")

        # 4. Land stage completes -> stage_3_verify
        pl = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land issue 50",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(pl["receipt_path"]).write_text("# Land receipt", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m50"},
            "receipt_path": pl["receipt_path"],
            "summary": "Landed 50",
        }))

        insp_final = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_final["current_issue_id"], "50")
        self.assertEqual(insp_final["current_stage"], "stage_3_verify")

    def test_duplicate_completion_and_reopen_run_idempotency(self):
        # Setup run at issue 101 stage_2_land
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "44")
        p1 = json.loads(self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p1["receipt_path"]).write_text("# Plan", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {
                "outcome": "decomposed",
                "plan": {"tasks": [{"number": 101}, {"number": 102}]},
            },
            "receipt_path": p1["receipt_path"],
            "summary": "Planned",
        }))

        pw = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Work 101",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(pw["receipt_path"]).write_text("# Work", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented"},
            "receipt_path": pw["receipt_path"],
            "summary": "Done work",
        }))

        pl = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 101",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(pl["receipt_path"]).write_text("# Land", encoding="utf-8")
        land_rep = {
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m101"},
            "receipt_path": pl["receipt_path"],
            "summary": "Done land",
        }
        res_comp1 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(land_rep))
        self.assertEqual(res_comp1.returncode, 0)

        insp1 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp1["current_issue_id"], "102")
        self.assertEqual(insp1["current_stage"], "stage_2_work")

        # Re-submitting identical complete report must not advance sequence again
        res_comp2 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(land_rep))
        self.assertEqual(res_comp2.returncode, 0)
        insp2 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp2["current_issue_id"], "102")
        self.assertEqual(insp2["current_stage"], "stage_2_work")

        # Re-opening run preserves state, issue attribution, and budget
        reopen_res = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "44")
        self.assertEqual(reopen_res.returncode, 0)
        insp3 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp3["current_issue_id"], "102")
        self.assertEqual(insp3["current_stage"], "stage_2_work")
        self.assertEqual(insp3["budgets"]["delivery_attempts_used"], 0)

        # Unconfirmed dispatch does not auto re-execute
        pw2 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Work 102",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        # Now dispatch is in-flight handed_off
        insp_flight = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertIsNotNone(insp_flight["active_dispatch"])
        self.assertEqual(insp_flight["active_dispatch"]["status"], "handed_off")
        self.assertTrue(any("unconfirmed" in r.lower() or "in flight" in r.lower() for r in insp_flight["blocking_reasons"]))

        # Calling handoff again does not grant new authorization
        h_again = json.loads(self.run_cli("handoff", "--receipt-root", str(self.receipt_root)).stdout)
        self.assertFalse(h_again["authorized"])

    def test_plan_order_validation_rejects_cycles_and_forward_dependencies(self):
        self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "44")
        p1 = json.loads(self.prepare({
            "stage": "stage_1_plan",
            "objective": "Plan",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p1["receipt_path"]).write_text("# Plan", encoding="utf-8")

        # Forward dependency: 101 depends on 102 which is scheduled after 101
        rep_forward = {
            "execution_status": "succeeded",
            "result": {
                "outcome": "decomposed",
                "plan": {
                    "tasks": [
                        {"number": 101, "blockedBy": [102]},
                        {"number": 102, "blockedBy": []},
                    ],
                },
            },
            "receipt_path": p1["receipt_path"],
            "summary": "Invalid plan",
        }
        res_forward = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_forward))
        self.assertNotEqual(res_forward.returncode, 0)
        self.assertIn("dependency", res_forward.stderr.lower())

        # Self dependency
        rep_self = {
            "execution_status": "succeeded",
            "result": {
                "outcome": "decomposed",
                "plan": {
                    "tasks": [
                        {"number": 101, "blockedBy": [101]},
                    ],
                },
            },
            "receipt_path": p1["receipt_path"],
            "summary": "Invalid plan",
        }
        res_self = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_self))
        self.assertNotEqual(res_self.returncode, 0)
        self.assertIn("itself", res_self.stderr.lower())

        # Unknown dependency: 101 depends on 999 which is not in the plan
        rep_unknown = {
            "execution_status": "succeeded",
            "result": {
                "outcome": "decomposed",
                "plan": {
                    "tasks": [
                        {"number": 101, "blockedBy": [999]},
                        {"number": 102, "blockedBy": []},
                    ],
                },
            },
            "receipt_path": p1["receipt_path"],
            "summary": "Invalid plan",
        }
        res_unknown = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps(rep_unknown))
        self.assertNotEqual(res_unknown.returncode, 0)
        self.assertIn("unknown issue", res_unknown.stderr.lower())

    def test_retry_under_independent_budget_failure_stays_on_issue_and_exhaustion_blocks(self):
        # 1. Initialize with 2 child issues: 101, 102; delivery-attempts-max = 2
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "44",
            "--child-issue", "101",
            "--child-issue", "102",
            "--delivery-attempts-max", "2",
        )

        # 2. Issue 101 attempt 1: prepare work, handoff, complete with failure
        p1 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement issue 101 attempt 1",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.assertEqual(p1["attempt"], 1)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p1["receipt_path"]).write_text("# Work receipt 101 try 1\nFailed", encoding="utf-8")

        res_fail1 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "failed",
            "result": {"outcome": "failed", "error": "Build failed"},
            "receipt_path": p1["receipt_path"],
            "summary": "101 failed attempt 1",
        }))
        self.assertEqual(res_fail1.returncode, 0)

        # Verify A failure does NOT advance sequence to B (102); stays on 101
        insp1 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp1["current_issue_id"], "101")
        self.assertEqual(insp1["current_stage"], "stage_2_work")
        self.assertEqual(insp1["stage_status"], "failed")

        items1 = insp1["delivery_sequence"]["items"]
        self.assertEqual(items1[0]["budgets"]["delivery_attempts_used"], 1)
        self.assertEqual(items1[1]["budgets"]["delivery_attempts_used"], 0)

        # 3. Explicit retry on 101: prepare with attempt_intent="new"
        p2 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement issue 101 attempt 2",
            "attempt_intent": "new",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.assertEqual(p2["attempt"], 2)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p2["receipt_path"]).write_text("# Work receipt 101 try 2\nRework needed", encoding="utf-8")

        res_fail2 = self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "rework_needed", "error": "Tests still failing"},
            "receipt_path": p2["receipt_path"],
            "summary": "101 needs rework on attempt 2",
        }))
        self.assertEqual(res_fail2.returncode, 0)

        # 4. Check state: 101 consumed 2 attempts; 102 still has 0 consumed
        insp2 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp2["current_issue_id"], "101")
        items2 = insp2["delivery_sequence"]["items"]
        self.assertEqual(items2[0]["budgets"]["delivery_attempts_used"], 2)
        self.assertEqual(items2[1]["budgets"]["delivery_attempts_used"], 0)

        # 5. Switching target / reload / recovery does not reset 101's budget
        reopen = self.run_cli("init", "--receipt-root", str(self.receipt_root), "--root-issue", "44")
        self.assertEqual(reopen.returncode, 0)
        insp_reload = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_reload["current_issue_id"], "101")
        self.assertEqual(insp_reload["delivery_sequence"]["items"][0]["budgets"]["delivery_attempts_used"], 2)
        self.assertEqual(insp_reload["delivery_sequence"]["items"][1]["budgets"]["delivery_attempts_used"], 0)

        # 6. Budget exhaustion: attempt 3 with attempt_intent="new" must be rejected
        res_exhaust = self.prepare({
            "stage": "stage_2_work",
            "objective": "Implement issue 101 attempt 3",
            "attempt_intent": "new",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        })
        self.assertNotEqual(res_exhaust.returncode, 0)
        self.assertIn("budget exceeded", res_exhaust.stderr.lower())

        insp_blocked = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertTrue(any("budget exhausted" in b.lower() for b in insp_blocked["blocking_reasons"]))

    def test_targeted_rework_after_delivery_routes_back_to_parent_verify_without_rerunning_others(self):
        # 1. Initialize with 2 child issues: 101, 102; delivery-attempts-max = 3
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "44",
            "--child-issue", "101",
            "--child-issue", "102",
            "--delivery-attempts-max", "3",
        )

        # Deliver 101 (work -> land)
        p_w101 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Work 101",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.assertEqual(p_w101["attempt"], 1)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_w101["receipt_path"]).write_text("# Work 101", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c101"},
            "receipt_path": p_w101["receipt_path"],
            "summary": "Implemented 101",
        }))

        p_l101 = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 101",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.assertEqual(p_l101["attempt"], 1)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_l101["receipt_path"]).write_text("# Land 101", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m101"},
            "receipt_path": p_l101["receipt_path"],
            "summary": "Landed 101",
        }))

        # Deliver 102 (work -> land)
        p_w102 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Work 102",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.assertEqual(p_w102["attempt"], 1)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_w102["receipt_path"]).write_text("# Work 102", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c102"},
            "receipt_path": p_w102["receipt_path"],
            "summary": "Implemented 102",
        }))

        p_l102 = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 102",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.assertEqual(p_l102["attempt"], 1)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_l102["receipt_path"]).write_text("# Land 102", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m102"},
            "receipt_path": p_l102["receipt_path"],
            "summary": "Landed 102",
        }))

        # Both landed! State is now at stage_3_verify for root issue 44
        insp_verify = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_verify["current_issue_id"], "44")
        self.assertEqual(insp_verify["current_stage"], "stage_3_verify")
        self.assertTrue(insp_verify["delivery_sequence"]["completed"])

        # 2. Stage 3 Verify completes with rework_needed
        p_v = json.loads(self.prepare({
            "stage": "stage_3_verify",
            "objective": "Verify integrated root 44",
            "provider": {"type": "skill", "target": "pc-issue-verify"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_v["receipt_path"]).write_text("# Verify receipt\nIssue 101 needs fix", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "rework_needed", "rework_target": "101"},
            "receipt_path": p_v["receipt_path"],
            "summary": "Integrated test reveals defect in 101",
        }))

        # 3. Targeted rework on Issue 101: prepare stage_2_work with rework_issue="101" and attempt_intent="new"
        p_rw_work = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Rework issue 101 defect",
            "rework_issue": "101",
            "attempt_intent": "new",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        # Attempt must be 2, retaining previous attempt history
        self.assertEqual(p_rw_work["attempt"], 2)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_rw_work["receipt_path"]).write_text("# Rework 101", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c101-fix"},
            "receipt_path": p_rw_work["receipt_path"],
            "summary": "Fixed 101 defect",
        }))

        # Next stage is stage_2_land for 101; paired work/land attempt remains 2
        p_rw_land = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land reworked issue 101",
            "attempt_intent": "same",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.assertEqual(p_rw_land["attempt"], 2)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_rw_land["receipt_path"]).write_text("# Rework Land 101", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m101-fix"},
            "receipt_path": p_rw_land["receipt_path"],
            "summary": "Landed 101 fix",
        }))

        # 4. After 101 rework lands:
        # Must return directly to stage_3_verify for root issue 44!
        insp_post_rework = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertEqual(insp_post_rework["current_issue_id"], "44")
        self.assertEqual(insp_post_rework["current_stage"], "stage_3_verify")
        self.assertEqual(insp_post_rework["stage_status"], "succeeded")

        # 5. Issue 102 (B) must NOT have re-run; its budget and records are intact
        items_post = insp_post_rework["delivery_sequence"]["items"]
        self.assertEqual(items_post[0]["issue_id"], "101")
        self.assertEqual(items_post[0]["budgets"]["delivery_attempts_used"], 2)
        self.assertEqual(items_post[0]["landed"], True)
        self.assertEqual(items_post[0]["land_receipt_path"], str(Path(p_rw_land["receipt_path"]).resolve()))

        self.assertEqual(items_post[1]["issue_id"], "102")
        self.assertEqual(items_post[1]["budgets"]["delivery_attempts_used"], 1)
        self.assertEqual(items_post[1]["landed"], True)
        self.assertEqual(items_post[1]["land_receipt_path"], str(Path(p_l102["receipt_path"]).resolve()))

    def test_unattributable_rework_rejected_and_routes_to_independent_replan(self):
        # 1. Initialize with 2 child issues: 101, 102; delivery-attempts-max = 3, replans-max = 2
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "44",
            "--child-issue", "101",
            "--child-issue", "102",
            "--delivery-attempts-max", "3",
            "--replans-max", "2",
        )

        # 2. Attempt to attribute rework to non-existent issue 999 must be rejected
        res_unknown = self.prepare({
            "stage": "stage_2_work",
            "objective": "Rework non-existent issue 999",
            "rework_issue": "999",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        })
        self.assertNotEqual(res_unknown.returncode, 0)
        self.assertIn("cannot attribute rework", res_unknown.stderr.lower())
        self.assertIn("replanning", res_unknown.stderr.lower())

        # 3. Route unattributable gap to scope_replan: uses replan budget, not delivery budget
        p_replan1 = json.loads(self.prepare({
            "stage": "scope_replan",
            "objective": "Replan scope boundaries for unaccounted gap",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }).stdout)
        self.assertEqual(p_replan1["attempt"], 1)

        insp_replan1 = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        # Replan used is 1, delivery attempts used is still 0!
        self.assertEqual(insp_replan1["budgets"]["replans_used"], 1)
        self.assertEqual(insp_replan1["budgets"]["delivery_attempts_used"], 0)
        self.assertEqual(insp_replan1["delivery_sequence"]["items"][0]["budgets"]["delivery_attempts_used"], 0)

        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_replan1["receipt_path"]).write_text("# Scope replan 1", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "revised_plan"},
            "receipt_path": p_replan1["receipt_path"],
            "summary": "Revised plan",
        }))

        # Replan 2
        p_replan2 = json.loads(self.prepare({
            "stage": "scope_replan",
            "objective": "Replan scope boundaries again",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }).stdout)
        self.assertEqual(p_replan2["attempt"], 2)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_replan2["receipt_path"]).write_text("# Scope replan 2", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "decision_required"},
            "receipt_path": p_replan2["receipt_path"],
            "summary": "Decision required",
        }))

        # Replan 3 exceeds max (2) and is rejected
        res_replan3 = self.prepare({
            "stage": "scope_replan",
            "objective": "Replan scope boundaries 3rd time",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        })
        self.assertNotEqual(res_replan3.returncode, 0)
        self.assertIn("budget exceeded", res_replan3.stderr.lower())
        self.assertIn("replan", res_replan3.stderr.lower())

    def test_init_with_plan_file_path(self):
        plan_file = self.receipt_root / "plan-snapshot.json"
        plan_file.write_text(json.dumps({
            "tasks": [
                {"number": 201, "blockedBy": []},
                {"number": 202, "blockedBy": [201]},
            ],
        }), encoding="utf-8")
        res = self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "44",
            "--plan", str(plan_file),
        )
        self.assertEqual(res.returncode, 0)
        state = json.loads(res.stdout)
        self.assertIn("delivery_sequence", state)
        self.assertEqual(state["current_issue_id"], "201")
        self.assertEqual(state["current_stage"], "stage_2_work")
        items = state["delivery_sequence"]["items"]
        self.assertEqual([it["issue_id"] for it in items], ["201", "202"])

    def test_targeted_rework_during_delivery_resumes_pending_child_issue(self):
        # 1. Initialize with 2 child issues: 101, 102; delivery-attempts-max = 3
        self.run_cli(
            "init",
            "--receipt-root", str(self.receipt_root),
            "--root-issue", "44",
            "--child-issue", "101",
            "--child-issue", "102",
            "--delivery-attempts-max", "3",
        )

        # Work 101 succeeds
        p_w101 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Work 101",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_w101["receipt_path"]).write_text("# Work 101", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c101"},
            "receipt_path": p_w101["receipt_path"],
            "summary": "Implemented 101",
        }))

        # Land 101 fails with rework_needed
        p_l101 = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 101",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_l101["receipt_path"]).write_text("# Land 101 review requested fixes", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "rework_needed"},
            "receipt_path": p_l101["receipt_path"],
            "summary": "Needs rework before landing",
        }))

        # 2. Targeted rework on 101
        p_rw_w = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Rework 101",
            "rework_issue": "101",
            "attempt_intent": "new",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.assertEqual(p_rw_w["attempt"], 2)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_rw_w["receipt_path"]).write_text("# Rework 101", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c101-rw"},
            "receipt_path": p_rw_w["receipt_path"],
            "summary": "Reworked 101",
        }))

        # Land rework for 101 succeeds
        p_rw_l = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land rework 101",
            "rework_issue": "101",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.assertEqual(p_rw_l["attempt"], 2)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_rw_l["receipt_path"]).write_text("# Land rework 101", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m101-rw"},
            "receipt_path": p_rw_l["receipt_path"],
            "summary": "Landed rework 101",
        }))

        # Inspect state: subsequent issue 102 is still pending! Sequence is NOT completed.
        insp = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        del_seq = insp["delivery_sequence"]
        self.assertIsNone(del_seq.get("active_rework_issue_id"))
        self.assertFalse(del_seq["completed"])
        self.assertEqual(del_seq["current_index"], 1)
        self.assertEqual(insp["current_issue_id"], "102")
        self.assertEqual(insp["current_stage"], "stage_2_work")

        # Now deliver remaining issue 102
        p_w102 = json.loads(self.prepare({
            "stage": "stage_2_work",
            "objective": "Work 102",
            "provider": {"type": "skill", "target": "pc-issue-work"},
        }).stdout)
        self.assertEqual(p_w102["attempt"], 1)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_w102["receipt_path"]).write_text("# Work 102", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "implemented", "commit": "c102"},
            "receipt_path": p_w102["receipt_path"],
            "summary": "Implemented 102",
        }))

        p_l102 = json.loads(self.prepare({
            "stage": "stage_2_land",
            "objective": "Land 102",
            "provider": {"type": "skill", "target": "pc-pr-land"},
        }).stdout)
        self.assertEqual(p_l102["attempt"], 1)
        self.run_cli("handoff", "--receipt-root", str(self.receipt_root))
        Path(p_l102["receipt_path"]).write_text("# Land 102", encoding="utf-8")
        self.run_cli("complete", "--receipt-root", str(self.receipt_root), "--report", json.dumps({
            "execution_status": "succeeded",
            "result": {"outcome": "landed", "mergedCommit": "m102"},
            "receipt_path": p_l102["receipt_path"],
            "summary": "Landed 102",
        }))

        # Now all child issues are delivered! Sequence is completed, routes to stage_3_verify
        insp_done = json.loads(self.run_cli("inspect", "--receipt-root", str(self.receipt_root), "--json").stdout)
        self.assertTrue(insp_done["delivery_sequence"]["completed"])
        self.assertEqual(insp_done["current_issue_id"], "44")
        self.assertEqual(insp_done["current_stage"], "stage_3_verify")

    def test_init_derives_isolated_receipt_root_and_saves_snapshot(self):
        """Init derives isolated receipt root from worktree_container and saves full config snapshot."""
        repo_dir = Path(self.temp_dir.name) / "my-repo"
        repo_dir.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:my-org/my-proj.git"], cwd=repo_dir, check=True, capture_output=True)

        cfg_dir = repo_dir / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "my-org/my-proj",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../custom-worktrees",
            "workflow": "custom-flow",
            "delivery_attempts_max": 4,
            "replans_max": 3,
        }), encoding="utf-8")

        res = self.run_cli(
            "init",
            "--root-issue", "49",
            "--repo-dir", str(repo_dir),
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        state_data = json.loads(res.stdout)

        # Derived receipt root must be under worktree_container
        expected_container = (repo_dir / "../custom-worktrees").resolve()
        expected_receipt_root = expected_container / ".paper-craft" / "receipts" / "issue-49"
        self.assertEqual(Path(state_data["config_snapshot"]["receipt_root"]).resolve(), expected_receipt_root)
        self.assertTrue((expected_receipt_root / "state.json").exists())

        # Check snapshot contents and workflow defaults
        self.assertEqual(state_data["workflow"], "custom-flow")
        self.assertEqual(state_data["budgets"]["delivery_attempts_max"], 4)
        self.assertEqual(state_data["budgets"]["replans_max"], 3)
        self.assertEqual(state_data["config_snapshot"]["repo_checkout"], str(repo_dir.resolve()))

    def test_recovery_consumes_config_snapshot_without_drift(self):
        """Prepare and recovery consume config snapshot, unaffected by source config edits or cwd changes."""
        repo_dir = Path(self.temp_dir.name) / "drift-repo"
        repo_dir.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:drift-org/drift-repo.git"], cwd=repo_dir, check=True, capture_output=True)

        cfg_dir = repo_dir / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        cfg_file = cfg_dir / "workspace-config.json"
        cfg_file.write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "drift-org/drift-repo",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../drift-worktrees",
        }), encoding="utf-8")

        receipt_root = Path(self.temp_dir.name) / "receipts-drift"
        res_init = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--repo-dir", str(repo_dir),
        )
        self.assertEqual(res_init.returncode, 0, res_init.stderr)

        # Mutate the source config file afterwards
        cfg_file.write_text("{ corrupted invalid json", encoding="utf-8")

        # Prepare a task: should consume saved config snapshot without reading the corrupted config file
        req_path = receipt_root / "prepare-req.json"
        req_path.write_text(json.dumps({
            "stage": "stage_1_plan",
            "objective": "Plan issue 49",
            "provider": {"type": "skill", "target": "pc-issue-plan"},
        }), encoding="utf-8")

        # Invoke prepare from a completely different directory
        res_prep = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), "prepare", "--receipt-root", str(receipt_root), "--request", str(req_path)],
            cwd=tempfile.gettempdir(),
            capture_output=True,
            text=True,
        )
        self.assertEqual(res_prep.returncode, 0, f"Prepare failed:\n{res_prep.stderr}\n{res_prep.stdout}")
        prep_data = json.loads(res_prep.stdout)
        env_path = Path(prep_data["envelope_path"])
        self.assertTrue(env_path.exists())

        env_data = json.loads(env_path.read_text(encoding="utf-8"))
        self.assertEqual(env_data["environment"]["repository"], "drift-org/drift-repo")
        self.assertEqual(env_data["environment"]["working_directory"], str(repo_dir.resolve()))

    def test_missing_or_invalid_config_stops_immediately_without_state(self):
        """Missing or invalid configuration stops immediately without creating runnable state."""
        empty_dir = Path(self.temp_dir.name) / "empty-dir"
        empty_dir.mkdir()
        receipt_root = Path(self.temp_dir.name) / "no-config-receipts"

        # Missing config
        res = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--repo-dir", str(empty_dir),
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse((receipt_root / "state.json").exists())

        # Invalid config
        bad_dir = Path(self.temp_dir.name) / "bad-dir"
        bad_cfg_dir = bad_dir / ".paper-craft"
        bad_cfg_dir.mkdir(parents=True)
        (bad_cfg_dir / "workspace-config.json").write_text("{ not json", encoding="utf-8")

        res_bad = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--repo-dir", str(bad_dir),
        )
        self.assertNotEqual(res_bad.returncode, 0)
        self.assertFalse((receipt_root / "state.json").exists())

    def test_run_identity_conflicts(self):
        """Run identity conflicts (different root issue, workflow, or repo checkout) fail explicitly."""
        repo_dir = Path(self.temp_dir.name) / "repo-a"
        repo_dir.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:org/repo-a.git"], cwd=repo_dir, check=True, capture_output=True)
        cfg_dir = repo_dir / ".paper-craft"
        cfg_dir.mkdir()
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "org/repo-a",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../worktrees",
            "workflow": "workflow-alpha",
        }), encoding="utf-8")

        receipt_root = Path(self.temp_dir.name) / "receipts-ident"
        res1 = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--repo-dir", str(repo_dir),
        )
        self.assertEqual(res1.returncode, 0)

        # 1. Matching identity re-entrance succeeds idempotently
        res_same = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--repo-dir", str(repo_dir),
        )
        self.assertEqual(res_same.returncode, 0)

        # 2. Conflicting root issue fails
        res_diff_issue = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "50",
            "--repo-dir", str(repo_dir),
        )
        self.assertNotEqual(res_diff_issue.returncode, 0)
        self.assertIn("Run identity conflict", res_diff_issue.stderr)

        # 3. Conflicting workflow fails
        res_diff_wf = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--workflow", "workflow-beta",
            "--repo-dir", str(repo_dir),
        )
        self.assertNotEqual(res_diff_wf.returncode, 0)
        self.assertIn("Run identity conflict", res_diff_wf.stderr)

        # 4. Conflicting repo checkout fails
        repo_b = Path(self.temp_dir.name) / "repo-b"
        repo_b.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main"], cwd=repo_b, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:org/repo-b.git"], cwd=repo_b, check=True, capture_output=True)
        cfg_b = repo_b / ".paper-craft"
        cfg_b.mkdir()
        (cfg_b / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "org/repo-b",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../worktrees",
            "workflow": "workflow-alpha",
        }), encoding="utf-8")

        res_diff_repo = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--repo-dir", str(repo_b),
        )
        self.assertNotEqual(res_diff_repo.returncode, 0)
        self.assertIn("Run identity conflict", res_diff_repo.stderr)

    def test_isolation_constraints(self):
        """Receipt root residing inside the repository checkout violates isolation constraints."""
        repo_dir = Path(self.temp_dir.name) / "repo-iso"
        repo_dir.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:org/repo-iso.git"], cwd=repo_dir, check=True, capture_output=True)
        cfg_dir = repo_dir / ".paper-craft"
        cfg_dir.mkdir()
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "org/repo-iso",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "inside-worktrees",
        }), encoding="utf-8")

        # Derived receipt root inside repo violates isolation
        res_iso = self.run_cli(
            "init",
            "--root-issue", "49",
            "--repo-dir", str(repo_dir),
        )
        self.assertNotEqual(res_iso.returncode, 0)
        self.assertIn("violates isolation constraints", res_iso.stderr)

    def test_explicit_cli_parameters_override_project_config(self):
        """Explicit CLI parameters take precedence over workspace project config."""
        repo_dir = Path(self.temp_dir.name) / "repo-override"
        repo_dir.mkdir()
        subprocess.run(["git", "init", "--initial-branch=main"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "remote", "add", "origin", "git@github.com:org/repo-override.git"], cwd=repo_dir, check=True, capture_output=True)
        cfg_dir = repo_dir / ".paper-craft"
        cfg_dir.mkdir()
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "org/repo-override",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../worktrees",
            "workflow": "workflow-config",
            "delivery_attempts_max": 2,
            "replans_max": 1,
        }), encoding="utf-8")

        receipt_root = Path(self.temp_dir.name) / "receipts-override"
        res = self.run_cli(
            "init",
            "--receipt-root", str(receipt_root),
            "--root-issue", "49",
            "--repo-dir", str(repo_dir),
            "--workflow", "workflow-cli-override",
            "--delivery-attempts-max", "7",
            "--replans-max", "6",
            "--delivery-target", "org/custom-target",
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        state_data = json.loads(res.stdout)
        self.assertEqual(state_data["workflow"], "workflow-cli-override")
        self.assertEqual(state_data["budgets"]["delivery_attempts_max"], 7)
        self.assertEqual(state_data["budgets"]["replans_max"], 6)
        self.assertEqual(state_data["config_snapshot"]["delivery_target"], "org/custom-target")



if __name__ == "__main__":
    unittest.main()
