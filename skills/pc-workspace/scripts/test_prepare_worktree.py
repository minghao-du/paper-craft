#!/usr/bin/env python3
"""Exercise workspace preparation against local Git repositories through its CLI."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).resolve().with_name("prepare-worktree.py")


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "checkout"
        self.source.mkdir()
        self.git(self.root, "init", "--bare", "--initial-branch=main", "origin.git")
        self.git(self.source, "init", "--initial-branch=main")
        self.git(self.source, "config", "user.name", "Workspace Test")
        self.git(self.source, "config", "user.email", "workspace@example.invalid")
        self.git(self.source, "config", "commit.gpgsign", "false")
        self.git(self.source, "config", "core.hooksPath", "/dev/null")
        (self.source / "source.txt").write_text("initial\n")
        self.git(self.source, "add", "source.txt")
        self.git(self.source, "commit", "-m", "Initial")
        self.git(self.source, "remote", "add", "origin", str(self.root / "origin.git"))
        self.git(self.source, "push", "origin", "main")
        self.initial = self.git(self.source, "rev-parse", "HEAD")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text('#!/bin/sh\nprintf \'%s\\n\' \'{"nameWithOwner":"test/repo","defaultBranchRef":{"name":"main"}}\'\n')
        gh.chmod(0o755)
        self.env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"])

    def git(self, directory, *args):
        result = subprocess.run(["git", *args], cwd=directory, capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def prepare(self, *args, success=True):
        result = subprocess.run([sys.executable, str(HELPER), "--repo-dir", str(self.source), *args],
                                cwd=self.root, env=self.env, capture_output=True, text=True, timeout=15)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            return result.stderr
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        return data.get("result", data)

    def create_envelope_file(self, envelope_path: Path, **overrides) -> Path:
        """Helper to create a valid TaskInputEnvelope JSON file."""
        target_worktree = self.root / "checkout-worktrees" / f"issue-{overrides.get('issue', 42)}"
        receipt_path = self.root / "receipts" / f"01-workspace-prepare-issue-{overrides.get('issue', 42)}.md"
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        envelope_path.parent.mkdir(parents=True, exist_ok=True)

        data = {
            "schema_version": "1.0",
            "task": {
                "logical_stage": overrides.get("logical_stage", "workspace_prepare"),
                "step_index": overrides.get("step_index", 1),
                "attempt": overrides.get("attempt", 1),
                "root_issue_id": str(overrides.get("root_issue_id", overrides.get("issue", "42"))),
                "current_issue_id": str(overrides.get("current_issue_id", overrides.get("issue", "42"))),
            },
            "provider": {
                "type": "script",
                "target": "skills/pc-workspace/scripts/prepare-worktree.py",
                "args": [],
            },
            "environment": {
                "working_directory": str(overrides.get("repo_dir", self.source)),
                "repository": "test/repo",
                "base_branch": overrides.get("base", "main"),
                "branch": overrides.get("branch", f"issue-{overrides.get('issue', 42)}"),
                "commit": overrides.get("commit"),
            },
            "inputs": {
                "objective": overrides.get("objective", "Prepare workspace for issue"),
                "scope": "workspace",
                "acceptance_criteria": ["Workspace prepared cleanly"],
                "predecessor_receipts": [],
                "parameters": overrides.get("parameters", {}),
            },
            "contract": {
                "receipt_path": str(overrides.get("receipt_path", receipt_path)),
                "receipt_template": "templates/subagent-receipt.template.md",
            },
            "budgets": {
                "delivery_attempts_limit": 3,
                "delivery_attempts_used": 0,
                "replans_limit": 2,
                "replans_used": 0,
            },
        }
        envelope_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return envelope_path

    def run_kernel(self, *args, success=True):
        """Invoke prepare-worktree.py directly with custom arguments."""
        result = subprocess.run(
            [sys.executable, str(HELPER), *args],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if not success:
            self.assertNotEqual(result.returncode, 0, f"Expected failure, got success: {result.stdout}")
            return result
        self.assertEqual(result.returncode, 0, f"Execution failed: {result.stderr}")
        return result

    # --- Existing Legacy Tests ---

    def test_issue_creation_reuse_and_rework_guards(self):
        result = self.prepare("--issue", "12")
        target = self.root / "checkout-worktrees" / "issue-12"
        self.assertEqual(result["worktree"], str(target))
        self.assertEqual(result["working_directory"], str(target))
        self.assertEqual(result["branch"], "issue-12")
        self.assertTrue(result["created"])
        reused = self.prepare("--issue", "12", "--expected-head", self.initial)
        self.assertFalse(reused["created"])
        (target / "source.txt").write_text("implemented\n")
        self.git(target, "commit", "-am", "Implement")
        delivered = self.git(target, "rev-parse", "HEAD")
        error = self.prepare("--issue", "12", "--expected-head", self.initial, success=False)
        self.assertIn("Expected predecessor HEAD", error)
        self.assertEqual(self.git(target, "rev-parse", "HEAD"), delivered)
        self.assertFalse(self.prepare("--issue", "12", "--expected-head", delivered)["created"])
        (target / "source.txt").write_text("uncommitted\n")
        error = self.prepare("--issue", "12", success=False)
        self.assertIn("Uncommitted changes", error)
        self.assertEqual((target / "source.txt").read_text(), "uncommitted\n")
        self.assertEqual(self.git(self.source, "branch", "--show-current"), "main")

    def test_generic_branch_and_missing_rework_preserve_source(self):
        target = self.root / "refactor"
        error = self.prepare("--branch", "codex/refactor", "--worktree", str(target),
                             "--expected-head", self.initial, success=False)
        self.assertIn("predecessor worktree is missing", error)
        self.assertFalse(target.exists())
        result = self.prepare("--branch", "codex/refactor", "--worktree", str(target))
        self.assertEqual(result["branch"], "codex/refactor")
        self.assertEqual(result["commit"], self.initial)
        self.assertEqual(self.git(self.source, "rev-parse", "HEAD"), self.initial)

    def test_detached_verification_stays_pinned_and_rejects_drift(self):
        (self.source / "source.txt").write_text("updated\n")
        self.git(self.source, "commit", "-am", "Update")
        self.git(self.source, "push", "origin", "main")
        newer = self.git(self.source, "rev-parse", "HEAD")
        target = self.root / "integrated"
        result = self.prepare("--commit", self.initial, "--worktree", str(target))
        self.assertIsNone(result["branch"])
        self.assertEqual(result["commit"], self.initial)
        self.assertEqual(self.git(target, "branch", "--show-current"), "")
        self.assertFalse(self.prepare("--commit", self.initial, "--worktree", str(target))["created"])
        error = self.prepare("--commit", newer, "--worktree", str(target), success=False)
        self.assertIn("Expected integrated HEAD", error)
        self.assertEqual(self.git(target, "rev-parse", "HEAD"), self.initial)

    def test_occupied_target_is_preserved(self):
        target = self.root / "occupied"
        target.mkdir()
        (target / "data.txt").write_text("retain\n")
        error = self.prepare("--branch", "codex/new", "--worktree", str(target), success=False)
        self.assertIn("occupied", error)
        self.assertEqual((target / "data.txt").read_text(), "retain\n")

    # --- New Kernel-Wrapper and Receipt Contract Tests ---

    def test_input_envelope_feature_worktree(self):
        env_file = self.root / "envelopes" / "01-input.json"
        self.create_envelope_file(env_file, issue=50)

        res = self.run_kernel("--input-envelope", str(env_file))
        report = json.loads(res.stdout)

        # 1. Stdout matches compact report contract
        self.assertEqual(report["execution_status"], "succeeded")
        self.assertIn("summary", report)
        self.assertTrue(len(report["summary"]) > 0)
        self.assertEqual(report["receipt_path"], str(self.root / "receipts" / "01-workspace-prepare-issue-50.md"))

        # 2. Result environment fields
        result_env = report["result"]
        expected_target = self.root / "checkout-worktrees" / "issue-50"
        self.assertEqual(result_env["working_directory"], str(expected_target))
        self.assertEqual(result_env["worktree"], str(expected_target))
        self.assertEqual(result_env["branch"], "issue-50")
        self.assertEqual(result_env["baseBranch"], "main")
        self.assertEqual(result_env["commit"], self.initial)
        self.assertTrue(result_env["created"])

        # 3. Worktree exists and is verified
        self.assertTrue(expected_target.is_dir())
        self.assertEqual(self.git(expected_target, "branch", "--show-current"), "issue-50")
        self.assertEqual(self.git(expected_target, "rev-parse", "HEAD"), self.initial)

    def test_input_envelope_creates_markdown_receipt(self):
        env_file = self.root / "envelopes" / "02-input.json"
        receipt_file = self.root / "receipts" / "02-custom-receipt.md"
        self.create_envelope_file(env_file, issue=51, receipt_path=receipt_file)

        self.run_kernel("--input-envelope", str(env_file))
        self.assertTrue(receipt_file.exists(), f"Receipt file missing at {receipt_file}")

        content = receipt_file.read_text(encoding="utf-8")
        # Check metadata
        self.assertIn("root_issue_id: 51", content)
        self.assertIn("current_issue_id: 51", content)
        self.assertIn("execution_status: succeeded", content)
        # Check required sections
        self.assertIn("## Compact Report", content)
        self.assertIn("## Artifacts", content)
        self.assertIn("## Verification", content)
        self.assertIn("## Task Result", content)
        self.assertIn("## Current State and Feedback", content)
        self.assertIn("## Recovery and Budgets", content)
        # Check artifact fields
        self.assertIn(str(self.root / "checkout-worktrees" / "issue-51"), content)
        self.assertIn("branch: issue-51", content)

    def test_input_envelope_stdout_compact_report(self):
        env_file = self.root / "envelopes" / "03-compact.json"
        self.create_envelope_file(env_file, issue=50)

        res = self.run_kernel("--input-envelope", str(env_file))
        report = json.loads(res.stdout)
        self.assertEqual(report["execution_status"], "succeeded")
        self.assertIn("summary", report)
        self.assertTrue(len(report["summary"]) > 0)
        self.assertEqual(report["receipt_path"], str(self.root / "receipts" / "01-workspace-prepare-issue-50.md"))
        self.assertIn("repository", report["result"])
        self.assertIn("working_directory", report["result"])
        self.assertIn("worktree", report["result"])
        self.assertIn("branch", report["result"])
        self.assertIn("baseBranch", report["result"])
        self.assertIn("commit", report["result"])
        self.assertIn("created", report["result"])

    def test_input_envelope_detached_verification_worktree(self):
        env_file = self.root / "envelopes" / "03-detached.json"
        detached_target = self.root / "integrated-worktree"
        self.create_envelope_file(
            env_file,
            issue=52,
            branch=None,
            commit=self.initial,
            parameters={"worktree": str(detached_target)},
        )

        res = self.run_kernel("--input-envelope", str(env_file))
        report = json.loads(res.stdout)
        self.assertEqual(report["execution_status"], "succeeded")
        self.assertIsNone(report["result"]["branch"])
        self.assertEqual(report["result"]["commit"], self.initial)
        self.assertEqual(report["result"]["worktree"], str(detached_target))

        self.assertEqual(self.git(detached_target, "branch", "--show-current"), "")
        self.assertEqual(self.git(detached_target, "rev-parse", "HEAD"), self.initial)

    def test_input_envelope_reuse_and_rework_validation(self):
        env_file = self.root / "envelopes" / "04-reuse.json"
        self.create_envelope_file(env_file, issue=53)

        # First run: creates worktree
        res1 = self.run_kernel("--input-envelope", str(env_file))
        report1 = json.loads(res1.stdout)
        self.assertTrue(report1["result"]["created"])

        # Second run: reuses worktree cleanly
        res2 = self.run_kernel("--input-envelope", str(env_file))
        report2 = json.loads(res2.stdout)
        self.assertEqual(report2["execution_status"], "succeeded")
        self.assertFalse(report2["result"]["created"])

        # Modify worktree and commit
        target = self.root / "checkout-worktrees" / "issue-53"
        (target / "source.txt").write_text("updated content\n")
        self.git(target, "commit", "-am", "Rework commit")
        new_sha = self.git(target, "rev-parse", "HEAD")

        # Envelope with expected_head mismatch
        env_mismatch = self.root / "envelopes" / "04-mismatch.json"
        self.create_envelope_file(env_mismatch, issue=53, parameters={"expected_head": self.initial})
        res_err = self.run_kernel("--input-envelope", str(env_mismatch), success=False)
        self.assertIn("Expected predecessor HEAD", res_err.stderr + res_err.stdout)

        # Envelope with matching expected_head succeeds
        env_match = self.root / "envelopes" / "04-match.json"
        self.create_envelope_file(env_match, issue=53, parameters={"expected_head": new_sha})
        res_ok = self.run_kernel("--input-envelope", str(env_match))
        report_ok = json.loads(res_ok.stdout)
        self.assertFalse(report_ok["result"]["created"])
        self.assertEqual(report_ok["result"]["commit"], new_sha)

    def test_input_envelope_blocked_on_uncommitted_changes(self):
        env_file = self.root / "envelopes" / "05-dirty.json"
        self.create_envelope_file(env_file, issue=54)

        # First prepare clean
        self.run_kernel("--input-envelope", str(env_file))
        target = self.root / "checkout-worktrees" / "issue-54"

        # Make uncommitted dirty change
        (target / "dirty.txt").write_text("uncommitted\n")
        res_err = self.run_kernel("--input-envelope", str(env_file), success=False)
        output = res_err.stderr + res_err.stdout
        self.assertIn("Uncommitted changes", output)
        self.assertEqual((target / "dirty.txt").read_text(), "uncommitted\n")

    def test_cli_flags_backward_compatibility(self):
        # Direct CLI execution without envelope or receipt-path returns raw dict
        res = self.run_kernel("--repo-dir", str(self.source), "--issue", "88")
        data = json.loads(res.stdout)
        self.assertIn("worktree", data)
        self.assertIn("created", data)
        self.assertNotIn("execution_status", data)
        self.assertNotIn("compact_report", data)

    def test_cli_flags_with_receipt_path(self):
        receipt_path = self.root / "receipts" / "cli-receipt.md"
        res = self.run_kernel(
            "--repo-dir", str(self.source),
            "--issue", "60",
            "--receipt-path", str(receipt_path),
        )
        report = json.loads(res.stdout)
        self.assertEqual(report["execution_status"], "succeeded")
        self.assertEqual(report["receipt_path"], str(receipt_path))
        self.assertTrue(receipt_path.exists())

    def test_input_envelope_missing_file_handling(self):
        missing_file = self.root / "does_not_exist.json"
        res = self.run_kernel("--input-envelope", str(missing_file), success=False)
        self.assertIn("Input envelope not found", res.stderr)

    def test_workspace_config_normal_project_defaults(self):
        """Prepare worktree consumes workspace-config.json and creates in default container."""
        (self.source / ".gitignore").write_text(".paper-craft/\n")
        self.git(self.source, "add", ".gitignore")
        self.git(self.source, "commit", "-m", "Add gitignore")

        cfg_dir = self.source / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "test/repo",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../project-worktrees",
        }), encoding="utf-8")

        res = self.run_kernel("--repo-dir", str(self.source), "--issue", "70")
        data = json.loads(res.stdout)
        expected_target = self.root / "project-worktrees" / "issue-70"
        self.assertEqual(data["worktree"], str(expected_target))
        self.assertEqual(data["repository"], "test/repo")
        self.assertEqual(data["baseBranch"], "main")
        self.assertTrue(data["created"])
        self.assertTrue(expected_target.is_dir())

    def test_workspace_config_custom_worktree_container(self):
        """Custom worktree_container in workspace-config.json is respected."""
        (self.source / ".gitignore").write_text(".paper-craft/\n")
        self.git(self.source, "add", ".gitignore")
        self.git(self.source, "commit", "-m", "Add gitignore")

        cfg_dir = self.source / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "test/repo",
            "base_remote": "origin",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../custom-worktrees",
        }), encoding="utf-8")

        res = self.run_kernel("--repo-dir", str(self.source), "--issue", "71")
        data = json.loads(res.stdout)
        expected_target = self.root / "custom-worktrees" / "issue-71"
        self.assertEqual(data["worktree"], str(expected_target))
        self.assertTrue(expected_target.is_dir())

    def test_workspace_config_invalid_json_blocks_preparation(self):
        """Corrupted workspace-config blocks preparation and does not create worktree."""
        cfg_dir = self.source / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text("{corrupt-json", encoding="utf-8")

        res = self.run_kernel("--repo-dir", str(self.source), "--issue", "72", success=False)
        self.assertIn("Workspace configuration", res.stderr)
        self.assertIn("invalid", res.stderr.lower())

        target_container = self.root / "project-worktrees" / "issue-72"
        self.assertFalse(target_container.exists(), "Worktree must not be created on invalid config")

    def test_fork_project_fetches_upstream_baseline_and_custom_container(self):
        """Fork repository fetches mainline baseline from base_remote (upstream) into custom container."""
        (self.source / ".gitignore").write_text(".paper-craft/\n")
        self.git(self.source, "add", ".gitignore")
        self.git(self.source, "commit", "-m", "Add gitignore")

        # Setup bare upstream and push a unique commit
        upstream_bare = self.root / "upstream.git"
        self.git(self.root, "init", "--bare", "--initial-branch=main", "upstream.git")

        temp_upstream_checkout = self.root / "temp-upstream"
        self.git(self.root, "clone", str(upstream_bare), "temp-upstream")
        self.git(temp_upstream_checkout, "config", "user.name", "Upstream Dev")
        self.git(temp_upstream_checkout, "config", "user.email", "upstream@example.com")
        self.git(temp_upstream_checkout, "config", "commit.gpgsign", "false")
        (temp_upstream_checkout / "UPSTREAM_FEATURE.md").write_text("# Mainline Feature\n")
        self.git(temp_upstream_checkout, "add", "UPSTREAM_FEATURE.md")
        self.git(temp_upstream_checkout, "commit", "-m", "Upstream mainline commit")
        self.git(temp_upstream_checkout, "push", "origin", "main")
        upstream_head_sha = self.git(temp_upstream_checkout, "rev-parse", "HEAD")

        # In source repo (the fork checkout), add upstream remote
        self.git(self.source, "remote", "add", "upstream", str(upstream_bare))

        # Setup workspace configuration for fork
        cfg_dir = self.source / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "upstream-owner/repo",
            "base_remote": "upstream",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../custom-fork-worktrees",
        }), encoding="utf-8")

        # Create input envelope
        receipt_path = self.root / "receipts" / "01-fork-receipt.md"
        env_file = self.root / "envelopes" / "fork-input.json"
        env_file.parent.mkdir(parents=True, exist_ok=True)
        env_data = {
            "schema_version": "1.0",
            "task": {
                "logical_stage": "workspace_prepare",
                "step_index": 1,
                "attempt": 1,
                "root_issue_id": "39",
                "current_issue_id": "39",
            },
            "provider": {
                "type": "script",
                "target": str(HELPER),
                "args": [],
            },
            "environment": {
                "working_directory": str(self.source),
                "repository": "upstream-owner/repo",
                "delivery_target": "upstream-owner/repo",
                "base_remote": "upstream",
                "push_remote": "origin",
                "base_branch": "main",
            },
            "inputs": {
                "objective": "Prepare workspace for fork issue #39",
                "scope": "",
                "acceptance_criteria": [],
                "predecessor_receipts": [],
                "parameters": {
                    "delivery_target": "upstream-owner/repo",
                    "base_remote": "upstream",
                    "push_remote": "origin",
                    "worktree_container": "../custom-fork-worktrees",
                },
            },
            "contract": {
                "receipt_path": str(receipt_path),
                "receipt_template": "templates/subagent-receipt.template.md",
            },
            "budgets": {
                "delivery_attempts_used": 0,
                "delivery_attempts_max": 3,
                "replans_used": 0,
                "replans_max": 2,
            },
        }
        env_file.write_text(json.dumps(env_data, indent=2), encoding="utf-8")

        # Run prepare-worktree
        res = self.run_kernel("--input-envelope", str(env_file))
        report = json.loads(res.stdout)
        self.assertEqual(report["execution_status"], "succeeded")

        result = report["result"]
        self.assertEqual(result.get("delivery_target"), "upstream-owner/repo")
        self.assertEqual(result.get("base_remote"), "upstream")
        self.assertEqual(result.get("push_remote"), "origin")
        self.assertEqual(result.get("commit"), upstream_head_sha)

        expected_worktree = self.root / "custom-fork-worktrees" / "issue-39"
        self.assertEqual(result.get("worktree"), str(expected_worktree))
        self.assertTrue(expected_worktree.is_dir())
        self.assertTrue((expected_worktree / "UPSTREAM_FEATURE.md").exists())

        # Check receipt
        self.assertTrue(receipt_path.exists())
        receipt_text = receipt_path.read_text(encoding="utf-8")
        self.assertIn("upstream-owner/repo", receipt_text)
        self.assertIn("upstream", receipt_text)


class CleanupTests(unittest.TestCase):
    """Exercise destructive cleanup with real local refs and isolated PR metadata."""

    setUp = WorkspaceTests.setUp
    git = WorkspaceTests.git
    prepare = WorkspaceTests.prepare
    create_envelope_file = WorkspaceTests.create_envelope_file

    def merged_candidate(self):
        """Create a squash-merged feature whose tip is not an ancestor of main."""
        candidate = self.prepare("--issue", "73")
        target = Path(candidate["worktree"])
        (target / "feature.txt").write_text("feature\n")
        self.git(target, "add", "feature.txt")
        self.git(target, "commit", "-m", "Feature")
        candidate["commit"] = self.git(target, "rev-parse", "HEAD")
        self.git(target, "push", "--set-upstream", "origin", "issue-73")
        self.git(self.source, "merge", "--squash", "issue-73")
        self.git(self.source, "commit", "-m", "Squash delivery")
        merged = self.git(self.source, "rev-parse", "HEAD")
        # A different squash message guarantees a distinct commit object.
        self.assertNotEqual(merged, candidate["commit"])
        self.git(self.source, "push", "origin", "main")
        candidate.update(pr=73, consumers_finished=True)
        metadata = dict(state="MERGED", headRefName="issue-73", headRefOid=candidate["commit"],
                        baseRefName="main", mergeCommit=dict(oid=merged),
                        headRepository=dict(name="repo"), headRepositoryOwner=dict(login="test"))
        (self.root / "pr.json").write_text(json.dumps(metadata))
        gh = self.root / "bin" / "gh"
        gh.write_text(f"""#!/bin/sh
if [ "$1" = "pr" ]; then
    cat "{self.root / 'pr.json'}"
else
    printf '%s\\n' '{{"nameWithOwner":"test/repo","defaultBranchRef":{{"name":"main"}}}}'
fi
""")
        return candidate

    def clean_candidate(self, candidate, flag=False):
        """Run the public cleanup envelope entry point and check its durable receipt."""
        envelope = self.create_envelope_file(self.root / "cleanup.json", logical_stage="workspace_cleanup",
                                             parameters=dict(candidates=[candidate]))
        result = self.prepare("--input-envelope", str(envelope), *(["--cleanup"] if flag else []))
        receipt = Path(json.loads(envelope.read_text())["contract"]["receipt_path"])
        self.assertIn("workspace_cleanup", receipt.read_text())
        return result

    def test_cleanup_squash_merge_and_retry(self):
        candidate = self.merged_candidate()
        for flag in (False, True):
            result = self.clean_candidate(candidate, flag)
            self.assertEqual(result["retained_paths"], [])
            self.assertEqual(result["retained_branches"], [])
            self.assertFalse(Path(candidate["worktree"]).exists())
            self.assertEqual(self.git(self.source, "branch", "--list", "issue-73"), "")
            self.assertNotIn("branch.issue-73.", self.git(self.source, "config", "--local", "--list"))
            self.assertEqual(self.git(self.source, "ls-remote", "origin", "refs/heads/issue-73"), "")

    def test_historical_branch_without_worktree_requires_ownership(self):
        candidate = self.merged_candidate()
        self.git(self.source, "worktree", "remove", candidate["worktree"])
        candidate.update(worktree=None, created=False)
        blocked = self.clean_candidate(candidate)
        self.assertEqual(blocked["outcome"], "incomplete")
        self.assertTrue(self.git(self.source, "branch", "--list", "issue-73"))
        candidate["ownership_evidence"] = {"root_issue_id": "42", "issue": "73", "source": "PR #73"}
        # Match the root assigned by the fixture envelope.
        envelope = self.create_envelope_file(self.root / "ownership.json")
        candidate["ownership_evidence"]["root_issue_id"] = json.loads(envelope.read_text())["task"]["root_issue_id"]
        cleaned = self.clean_candidate(candidate)
        self.assertEqual(cleaned["outcome"], "cleaned")
        self.assertEqual(cleaned["removed_paths"], [])
        self.assertEqual(self.git(self.source, "branch", "--list", "issue-73"), "")
        self.assertEqual(self.git(self.source, "ls-remote", "origin", "refs/heads/issue-73"), "")

    def test_cleanup_retains_changed_or_unowned_resources(self):
        candidate = self.merged_candidate()
        target = Path(candidate["worktree"])
        for key in ("created", "consumers_finished"):
            changed = dict(candidate, **{key: False})
            self.assertTrue(self.clean_candidate(changed)["retained_paths"])
        (target / "evidence.log").write_text("retain me")
        self.assertTrue(self.clean_candidate(candidate)["retained_paths"])
        (target / "evidence.log").unlink()
        self.git(target, "commit", "--allow-empty", "-m", "After delivery")
        newer = self.git(target, "rev-parse", "HEAD")
        self.assertTrue(self.clean_candidate(candidate)["retained_paths"])
        # Restore local state but leave a newer remote tip.
        self.git(target, "push", "origin", "issue-73")
        self.git(target, "reset", "--hard", candidate["commit"])
        self.assertTrue(self.clean_candidate(candidate)["retained_paths"])
        self.assertTrue(target.exists())
        self.assertIn(newer, self.git(self.source, "ls-remote", "origin", "refs/heads/issue-73"))

    def test_cleanup_requires_matching_merge_evidence(self):
        candidate = self.merged_candidate()
        metadata_path = self.root / "pr.json"
        original = json.loads(metadata_path.read_text())
        for changes in (dict(state="OPEN"), dict(headRefOid=self.initial),
                        dict(baseRefName="other"), dict(mergeCommit=dict(oid=candidate["commit"])),
                        dict(headRepositoryOwner=dict(login="another-owner"))):
            with self.subTest(changes=changes):
                metadata_path.write_text(json.dumps(dict(original, **changes)))
                result = self.clean_candidate(candidate)
                self.assertTrue(result["retained_paths"])
                self.assertTrue(Path(candidate["worktree"]).exists())
                self.assertIn(candidate["commit"], self.git(self.source, "ls-remote", "origin", "refs/heads/issue-73"))

    def test_cleanup_detached_and_ignored_material(self):
        candidate = self.prepare("--commit", self.initial, "--worktree", str(self.root / "verify"))
        candidate.update(consumers_finished=True, verification_completed=True)
        target = Path(candidate["worktree"])
        exclude = self.source / ".git" / "info" / "exclude"
        exclude.write_text("evidence.log\n")
        (target / "evidence.log").write_text("preserve scientific evidence")
        self.assertTrue(self.clean_candidate(candidate)["retained_paths"])
        (target / "evidence.log").unlink()
        result = self.clean_candidate(candidate)
        self.assertEqual(result["retained_paths"], [])
        self.assertFalse(target.exists())

    def test_cleanup_locked_worktree_and_partial_retry(self):
        candidate = self.merged_candidate()
        target = Path(candidate["worktree"])
        # Locked worktrees retain every resource. A partial prior cleanup remains retryable.
        self.git(target, "config", "core.hooksPath", "/dev/null")
        self.git(self.source, "worktree", "lock", str(target))
        self.assertTrue(self.clean_candidate(candidate)["retained_paths"])
        self.assertIn(candidate["commit"], self.git(self.source, "ls-remote", "origin", "refs/heads/issue-73"))
        self.git(self.source, "worktree", "unlock", str(target))
        self.git(self.source, "push", "origin", ":refs/heads/issue-73")
        self.git(self.source, "worktree", "remove", str(target))
        result = self.clean_candidate(candidate)
        self.assertEqual(result["retained_branches"], [])
        self.assertEqual(self.git(self.source, "branch", "--list", "issue-73"), "")


if __name__ == "__main__":
    unittest.main()
