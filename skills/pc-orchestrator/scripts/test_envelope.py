#!/usr/bin/env python3
"""Unit and integration tests for Task Input Envelope engine (envelope.py)."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any, Dict
import unittest

SCRIPT_PATH = Path(__file__).resolve().parent / "envelope.py"
sys.path.insert(0, str(SCRIPT_PATH.parent))

import envelope


def build_valid_envelope_data(**overrides: Any) -> Dict[str, Any]:
    """Helper to construct a valid envelope dictionary with optional overrides."""
    base: Dict[str, Any] = {
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
            "working_directory": "/tmp/test-repo",
            "repository": "test/paper-craft",
            "base_branch": "main",
            "branch": "issue-42",
            "commit": "abcdef123456",
        },
        "inputs": {
            "objective": "Design implementation plan",
            "scope": "Milestone M1",
            "acceptance_criteria": ["Tests pass", "Documentation updated"],
            "predecessor_receipts": [],
        },
        "contract": {
            "receipt_path": "/tmp/receipts/01-plan-issue-42-try-1.md",
            "receipt_template": "templates/subagent-receipt.template.md",
        },
        "budgets": {
            "delivery_attempts_limit": 3,
            "delivery_attempts_used": 0,
            "replans_limit": 2,
            "replans_used": 0,
        },
    }
    for k, v in overrides.items():
        if isinstance(v, dict) and k in base and isinstance(base[k], dict):
            base[k].update(v)
        else:
            base[k] = v
    return base


class TestEnvelopeSchemaValidation(unittest.TestCase):
    """Direct in-memory unit tests for envelope functions and schema validation."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_create_envelope_produces_valid_structure(self) -> None:
        env = envelope.create_envelope(
            logical_stage="stage_1_plan",
            step_index=1,
            attempt=1,
            root_issue_id="42",
            current_issue_id="42",
            provider_type="skill",
            provider_target="pc-issue-plan",
            working_directory=str(self.root),
            objective="Analyze requirements",
            receipt_path=str(self.root / "01-plan.md"),
            scope="Feature 1",
            acceptance_criteria=["AC1", "AC2"],
            base_branch="main",
            branch="issue-42",
            commit="headsha",
        )
        self.assertEqual(env["schema_version"], "1.0")
        self.assertEqual(env["task"]["logical_stage"], "stage_1_plan")
        self.assertEqual(env["provider"]["type"], "skill")
        self.assertEqual(env["provider"]["target"], "pc-issue-plan")
        self.assertEqual(env["contract"]["receipt_path"], str(self.root / "01-plan.md"))
        template = Path(env["contract"]["receipt_template"])
        self.assertTrue(template.is_absolute())
        self.assertEqual(template, SCRIPT_PATH.parent.parent / "templates" / "subagent-receipt.template.md")
        self.assertTrue(template.read_text(encoding="utf-8"))

        errors = envelope.validate_envelope(env)
        self.assertEqual(errors, [])

    def test_roundtrip_save_and_load(self) -> None:
        data = build_valid_envelope_data()
        target_file = self.root / "01-input.json"

        saved_path = envelope.save_envelope(data, target_file)
        self.assertTrue(saved_path.exists())

        loaded = envelope.load_envelope(target_file)
        self.assertEqual(loaded, data)

    def test_validation_fails_on_missing_top_level_keys(self) -> None:
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
            data = build_valid_envelope_data()
            del data[key]
            errors = envelope.validate_envelope(data)
            self.assertTrue(
                any(key in err for err in errors),
                f"Expected validation error mentioning missing key '{key}', got: {errors}",
            )

    def test_validation_fails_on_invalid_provider_types(self) -> None:
        # Valid provider type: strictly 'skill'
        data = build_valid_envelope_data(provider={"type": "skill", "target": "pc-issue-plan"})
        errors = envelope.validate_envelope(data)
        self.assertEqual(errors, [], "Expected provider.type 'skill' to be valid")

        # Invalid provider types (including deprecated/removed 'script')
        for invalid_type in ("script", "docker", "container", "plugin", "", None, 123):
            data = build_valid_envelope_data(provider={"type": invalid_type, "target": "target"})
            errors = envelope.validate_envelope(data)
            self.assertTrue(
                len(errors) > 0,
                f"Expected validation error for invalid provider.type '{invalid_type}'",
            )
            self.assertTrue(
                any("provider.type" in err for err in errors),
                f"Expected error message to mention provider.type, got: {errors}",
            )

    def test_validation_fails_on_missing_or_empty_receipt_path(self) -> None:
        # Missing receipt_path
        data_missing = build_valid_envelope_data()
        del data_missing["contract"]["receipt_path"]
        errors = envelope.validate_envelope(data_missing)
        self.assertTrue(any("contract.receipt_path" in err for err in errors))

        # Empty receipt_path
        data_empty = build_valid_envelope_data(contract={"receipt_path": ""})
        errors_empty = envelope.validate_envelope(data_empty)
        self.assertTrue(any("contract.receipt_path" in err for err in errors_empty))

        # Whitespace receipt_path
        data_ws = build_valid_envelope_data(contract={"receipt_path": "   "})
        errors_ws = envelope.validate_envelope(data_ws)
        self.assertTrue(any("contract.receipt_path" in err for err in errors_ws))

    def test_validation_fails_on_invalid_task_fields(self) -> None:
        # Missing logical_stage
        d1 = build_valid_envelope_data()
        del d1["task"]["logical_stage"]
        self.assertTrue(any("task.logical_stage" in err for err in envelope.validate_envelope(d1)))

        # step_index < 0
        d2 = build_valid_envelope_data()
        d2["task"]["step_index"] = -1
        self.assertTrue(any("task.step_index" in err for err in envelope.validate_envelope(d2)))

        # attempt < 1
        d3 = build_valid_envelope_data()
        d3["task"]["attempt"] = 0
        self.assertTrue(any("task.attempt" in err for err in envelope.validate_envelope(d3)))

        # Missing root_issue_id
        d4 = build_valid_envelope_data()
        del d4["task"]["root_issue_id"]
        self.assertTrue(any("task.root_issue_id" in err for err in envelope.validate_envelope(d4)))

    def test_validation_fails_on_missing_working_directory(self) -> None:
        data = build_valid_envelope_data()
        del data["environment"]["working_directory"]
        errors = envelope.validate_envelope(data)
        self.assertTrue(any("environment.working_directory" in err for err in errors))

    def test_validation_fails_on_missing_objective(self) -> None:
        data = build_valid_envelope_data()
        del data["inputs"]["objective"]
        errors = envelope.validate_envelope(data)
        self.assertTrue(any("inputs.objective" in err for err in errors))

    def test_save_envelope_rejects_invalid_data(self) -> None:
        bad_data = build_valid_envelope_data(provider={"type": "invalid_type", "target": "foo"})
        target_file = self.root / "bad-envelope.json"
        with self.assertRaises((ValueError, envelope.EnvelopeValidationError)):
            envelope.save_envelope(bad_data, target_file)
        self.assertFalse(target_file.exists())

    def test_load_corrupted_json_handling(self) -> None:
        malformed_file = self.root / "corrupted.json"
        malformed_file.write_text("{ unclosed JSON: ", encoding="utf-8")
        with self.assertRaises(envelope.EnvelopeCorruptedError):
            envelope.load_envelope(malformed_file)

        nonexistent_file = self.root / "nonexistent.json"
        with self.assertRaises(FileNotFoundError):
            envelope.load_envelope(nonexistent_file)


class TestEnvelopeCLI(unittest.TestCase):
    """Subprocess integration tests for envelope CLI."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name).resolve()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPT_PATH), *args],
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_cli_rejects_deprecated_create_subcommand(self) -> None:
        """Verify that envelope.py CLI rejects deprecated 'create' subcommand."""
        res = self.run_cli(
            "create",
            "--output", str(self.root / "01.json"),
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("invalid choice", res.stderr.lower())

    def test_create_envelope_api_generates_valid_envelope(self) -> None:
        output_file = self.root / "01-input.json"
        receipt_file = self.root / "01-receipt.md"

        env = envelope.create_envelope(
            logical_stage="stage_1_plan",
            step_index=1,
            attempt=1,
            root_issue_id="42",
            current_issue_id="42",
            provider_type="skill",
            provider_target="pc-issue-plan",
            working_directory=str(self.root),
            objective="Decompose issue 42",
            scope="Milestone 1",
            acceptance_criteria=["Unit tests complete"],
            receipt_path=str(receipt_file),
        )
        envelope.save_envelope(env, output_file)
        self.assertTrue(output_file.exists())

        with open(output_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data["schema_version"], "1.0")
        self.assertEqual(data["task"]["logical_stage"], "stage_1_plan")
        self.assertEqual(data["provider"]["type"], "skill")
        self.assertEqual(data["contract"]["receipt_path"], str(receipt_file))
        self.assertEqual(data["inputs"]["acceptance_criteria"], ["Unit tests complete"])

        # CLI validate confirms the generated envelope
        val_res = self.run_cli("validate", str(output_file))
        self.assertEqual(val_res.returncode, 0, val_res.stderr)
        self.assertIn("Valid envelope", val_res.stdout)

    def test_create_envelope_fails_on_missing_required_arguments(self) -> None:
        with self.assertRaises(envelope.EnvelopeValidationError):
            envelope.create_envelope(
                logical_stage="",
                step_index=1,
                root_issue_id="42",
                provider_type="skill",
                provider_target="pc-issue-plan",
                working_directory=str(self.root),
                objective="Test missing stage",
                receipt_path=str(self.root / "rec.md"),
            )

    def test_create_envelope_fails_on_invalid_provider_type(self) -> None:
        with self.assertRaises(envelope.EnvelopeValidationError) as ctx:
            envelope.create_envelope(
                logical_stage="stage_1_plan",
                step_index=1,
                root_issue_id="42",
                provider_type="docker",
                provider_target="container-runner",
                working_directory=str(self.root),
                objective="Run container",
                receipt_path=str(self.root / "rec.md"),
            )
        self.assertIn("provider", str(ctx.exception).lower())

    def test_cli_validate_success_and_failures(self) -> None:
        target_file = self.root / "env.json"
        valid_data = build_valid_envelope_data()
        with open(target_file, "w", encoding="utf-8") as f:
            json.dump(valid_data, f, indent=2)

        # 1. Valid file passes
        res_ok = self.run_cli("validate", str(target_file))
        self.assertEqual(res_ok.returncode, 0, res_ok.stderr)

        # 2. Tampered invalid file fails
        del valid_data["contract"]["receipt_path"]
        with open(target_file, "w", encoding="utf-8") as f:
            json.dump(valid_data, f, indent=2)

        res_bad = self.run_cli("validate", str(target_file))
        self.assertNotEqual(res_bad.returncode, 0)
        self.assertIn("receipt_path", res_bad.stderr)

        # 3. Nonexistent file fails
        res_missing = self.run_cli("validate", str(self.root / "nonexistent.json"))
        self.assertNotEqual(res_missing.returncode, 0)
        self.assertIn("not found", res_missing.stderr.lower())

        # 4. Malformed JSON syntax fails
        malformed_file = self.root / "syntax_error.json"
        malformed_file.write_text("{ unclosed json: ", encoding="utf-8")
        res_malformed = self.run_cli("validate", str(malformed_file))
        self.assertNotEqual(res_malformed.returncode, 0)

    def test_cli_show_human_summary_json_and_field_query(self) -> None:
        target_file = self.root / "env.json"
        valid_data = build_valid_envelope_data()
        with open(target_file, "w", encoding="utf-8") as f:
            json.dump(valid_data, f, indent=2)

        # Human-readable summary
        res_summary = self.run_cli("show", str(target_file))
        self.assertEqual(res_summary.returncode, 0)
        self.assertIn("stage_1_plan", res_summary.stdout)
        self.assertIn("pc-issue-plan", res_summary.stdout)

        # Raw JSON output
        res_json = self.run_cli("show", str(target_file), "--json")
        self.assertEqual(res_json.returncode, 0)
        parsed = json.loads(res_json.stdout)
        self.assertEqual(parsed["schema_version"], "1.0")

        # Specific field query
        res_field = self.run_cli("show", str(target_file), "--field", "provider.type")
        self.assertEqual(res_field.returncode, 0)
        self.assertEqual(res_field.stdout.strip(), "skill")

        res_field_receipt = self.run_cli("show", str(target_file), "--field", "contract.receipt_path")
        self.assertEqual(res_field_receipt.returncode, 0)
        self.assertEqual(res_field_receipt.stdout.strip(), valid_data["contract"]["receipt_path"])

        # Nonexistent field query fails
        res_bad_field = self.run_cli("show", str(target_file), "--field", "invalid.field")
        self.assertNotEqual(res_bad_field.returncode, 0)
        self.assertIn("not found", res_bad_field.stderr.lower())

    def test_auto_populate_from_workspace_config(self) -> None:
        """create_envelope populates repository and base_branch from workspace config when unset."""
        cfg_dir = self.root / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "acme/paper-craft",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "trunk",
            "worktree_container": "../project-worktrees",
        }), encoding="utf-8")

        data = envelope.create_envelope(
            logical_stage="workspace_prepare",
            step_index=1,
            root_issue_id="38",
            provider_type="skill",
            provider_target="pc-workspace",
            working_directory=str(self.root),
            objective="Prepare workspace with auto config",
            receipt_path=str(self.root / "receipts" / "01.md"),
        )
        self.assertEqual(data["environment"]["repository"], "acme/paper-craft")
        self.assertEqual(data["environment"]["base_branch"], "trunk")

    def test_fork_roles_preserved_from_workspace_config(self) -> None:
        """Envelope preserves delivery_target, base_remote, push_remote from workspace config."""
        cfg_dir = self.root / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "upstream-org/upstream-repo",
            "base_remote": "upstream",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../custom-fork-worktrees",
        }), encoding="utf-8")

        data = envelope.create_envelope(
            logical_stage="workspace_prepare",
            step_index=1,
            root_issue_id="39",
            provider_type="skill",
            provider_target="pc-workspace",
            working_directory=str(self.root),
            objective="Prepare workspace with fork roles",
            receipt_path=str(self.root / "receipts" / "01.md"),
        )
        env = data["environment"]
        self.assertEqual(env["repository"], "upstream-org/upstream-repo")
        self.assertEqual(env.get("base_branch"), "main")
        self.assertNotIn("delivery_target", env)
        self.assertNotIn("base_remote", env)
        self.assertNotIn("push_remote", env)

        params = data["inputs"]["parameters"]
        self.assertEqual(params.get("delivery_target"), "upstream-org/upstream-repo")
        self.assertEqual(params.get("base_remote"), "upstream")
        self.assertEqual(params.get("push_remote"), "origin")
        self.assertEqual(params.get("worktree_container"), "../custom-fork-worktrees")

    def test_fork_roles_cli_overrides(self) -> None:
        """create_envelope accepts and preserves explicit fork role parameters."""
        data = envelope.create_envelope(
            logical_stage="workspace_prepare",
            step_index=1,
            root_issue_id="39",
            provider_type="skill",
            provider_target="pc-workspace",
            working_directory=str(self.root),
            delivery_target="explicit-upstream/repo",
            base_remote="upstream",
            push_remote="origin",
            base_branch="main",
            worktree_container="../explicit-worktrees",
            objective="Prepare workspace with explicit fork roles",
            receipt_path=str(self.root / "receipts" / "01.md"),
        )
        env = data["environment"]
        self.assertEqual(env["repository"], "explicit-upstream/repo")
        self.assertEqual(env.get("base_branch"), "main")
        self.assertNotIn("delivery_target", env)
        self.assertNotIn("base_remote", env)
        self.assertNotIn("push_remote", env)

        params = data["inputs"]["parameters"]
        self.assertEqual(params.get("delivery_target"), "explicit-upstream/repo")
        self.assertEqual(params.get("base_remote"), "upstream")
        self.assertEqual(params.get("push_remote"), "origin")
        self.assertEqual(params.get("worktree_container"), "../explicit-worktrees")

    def test_corrupted_workspace_config_raises_actionable_error(self) -> None:
        """Malformed workspace-config.json raises EnvelopeCorruptedError and halts immediately."""
        cfg_dir = self.root / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text("{ broken json", encoding="utf-8")

        # In-memory API raises EnvelopeCorruptedError
        with self.assertRaises(envelope.EnvelopeCorruptedError) as ctx:
            envelope.create_envelope(
                logical_stage="workspace_prepare",
                step_index=1,
                root_issue_id="38",
                provider_type="skill",
                provider_target="pc-workspace",
                working_directory=str(self.root),
                objective="Prepare workspace with broken config",
                receipt_path=str(self.root / "receipts" / "01.md"),
            )
        self.assertIn("Malformed JSON in workspace configuration", str(ctx.exception))
        self.assertIn("pc-workspace-config", str(ctx.exception))

    def test_explicit_base_branch_main_not_overridden_by_config(self) -> None:
        """Explicitly passed base_branch main must take precedence over config default branch."""
        cfg_dir = self.root / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "acme/repo",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "develop",
            "worktree_container": "../project-worktrees",
        }), encoding="utf-8")

        data = envelope.create_envelope(
            logical_stage="workspace_prepare",
            step_index=1,
            root_issue_id="38",
            provider_type="skill",
            provider_target="pc-workspace",
            working_directory=str(self.root),
            base_branch="main",
            objective="Prepare workspace with explicit main",
            receipt_path=str(self.root / "receipts" / "01.md"),
        )
        self.assertEqual(data["environment"]["base_branch"], "main")


if __name__ == "__main__":
    unittest.main()
