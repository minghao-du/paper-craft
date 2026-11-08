#!/usr/bin/env python3
"""Unit tests for pc-workspace-config helper (skills/pc-workspace-config/scripts/config.py)."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CONFIG_SCRIPT = Path(__file__).resolve().parent / "config.py"


class WorkspaceConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "my-project"
        self.repo.mkdir()

        # Initialize bare origin and local checkout
        self.git(self.root, "init", "--bare", "--initial-branch=main", "origin.git")
        self.git(self.repo, "init", "--initial-branch=main")
        self.git(self.repo, "config", "user.name", "Config Test")
        self.git(self.repo, "config", "user.email", "config@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        (self.repo / "README.md").write_text("# Test Repo\n")
        self.git(self.repo, "add", "README.md")
        self.git(self.repo, "commit", "-m", "Initial commit")
        self.git(self.repo, "remote", "add", "origin", "git@github.com:test-owner/my-project.git")

    def git(self, directory: Path, *args: str) -> str:
        res = subprocess.run(
            ["git", *args],
            cwd=directory,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        return res.stdout.strip()

    def run_config(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        res = subprocess.run(
            [sys.executable, str(CONFIG_SCRIPT), "--repo-dir", str(self.repo), *args],
            cwd=self.repo,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if check:
            self.assertEqual(res.returncode, 0, f"Config script failed:\n{res.stderr}\n{res.stdout}")
        return res

    def test_init_defaults_normal_project(self):
        """Probes git repo with only origin and writes default workspace config."""
        res = self.run_config("init", "--defaults")
        self.assertEqual(res.returncode, 0)

        config_file = self.repo / ".paper-craft" / "workspace-config.json"
        self.assertTrue(config_file.exists(), "Config file must be created")

        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("schema_version"), "1.0")
        self.assertEqual(data.get("delivery_target"), "test-owner/my-project")
        self.assertEqual(data.get("base_remote"), "origin")
        self.assertEqual(data.get("push_remote"), "origin")
        self.assertEqual(data.get("base_branch"), "main")
        self.assertEqual(data.get("worktree_container"), "../project-worktrees")

        # Also test via --init flag format
        res_flag = self.run_config("--show")
        self.assertEqual(res_flag.returncode, 0)
        show_data = json.loads(res_flag.stdout)
        self.assertEqual(show_data, data)

    def test_init_with_explicit_overrides(self):
        """Allows overriding delivery target, remotes, base branch, and worktree container."""
        res = self.run_config(
            "init",
            "--delivery-target", "custom-org/custom-repo",
            "--base-remote", "origin",
            "--push-remote", "origin",
            "--base-branch", "main",
            "--worktree-container", "../custom-worktrees",
            "--defaults",
        )
        self.assertEqual(res.returncode, 0)

        config_file = self.repo / ".paper-craft" / "workspace-config.json"
        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("delivery_target"), "custom-org/custom-repo")
        self.assertEqual(data.get("worktree_container"), "../custom-worktrees")

    def test_init_fork_scenario_defaults(self):
        """Fork repo with origin and upstream remotes defaults to upstream baseline and origin push."""
        self.git(self.repo, "remote", "add", "upstream", "git@github.com:upstream-owner/my-project.git")
        res = self.run_config("init", "--defaults")
        self.assertEqual(res.returncode, 0)

        config_file = self.repo / ".paper-craft" / "workspace-config.json"
        self.assertTrue(config_file.exists())

        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("delivery_target"), "upstream-owner/my-project")
        self.assertEqual(data.get("base_remote"), "upstream")
        self.assertEqual(data.get("push_remote"), "origin")
        self.assertEqual(data.get("base_branch"), "main")
        self.assertEqual(data.get("worktree_container"), "../project-worktrees")

    def test_init_fork_with_custom_flags(self):
        """Fork repo with custom flags overrides probed defaults."""
        self.git(self.repo, "remote", "add", "upstream", "git@github.com:upstream-owner/my-project.git")
        res = self.run_config(
            "init",
            "--delivery-target", "upstream-owner/custom-target",
            "--base-remote", "upstream",
            "--push-remote", "origin",
            "--base-branch", "main",
            "--worktree-container", "../custom-fork-worktrees",
            "--defaults",
        )
        self.assertEqual(res.returncode, 0)

        config_file = self.repo / ".paper-craft" / "workspace-config.json"
        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("delivery_target"), "upstream-owner/custom-target")
        self.assertEqual(data.get("base_remote"), "upstream")
        self.assertEqual(data.get("push_remote"), "origin")
        self.assertEqual(data.get("worktree_container"), "../custom-fork-worktrees")

    def test_show_subcommand_and_flag(self):
        """Show subcommand outputs JSON configuration."""
        self.run_config("init", "--defaults")

        res1 = self.run_config("show")
        data1 = json.loads(res1.stdout)
        self.assertEqual(data1.get("delivery_target"), "test-owner/my-project")

        res2 = self.run_config("--show")
        data2 = json.loads(res2.stdout)
        self.assertEqual(data2, data1)

    def test_validate_success(self):
        """Validate passes when configuration matches schema and repo remotes."""
        self.run_config("init", "--defaults")
        res = self.run_config("validate")
        self.assertEqual(res.returncode, 0)
        self.assertIn("valid", res.stdout.lower())

    def test_validate_missing_config_gives_clear_guidance(self):
        """When configuration is missing, validate fails and guides to run pc-workspace-config."""
        res = self.run_config("validate", check=False)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("pc-workspace-config", res.stderr)
        self.assertIn("missing", res.stderr.lower())

    def test_validate_invalid_json(self):
        """When configuration file contains corrupted JSON, validate fails with clear error."""
        cfg_dir = self.repo / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text("{corrupted-json-content")

        res = self.run_config("validate", check=False)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("invalid", res.stderr.lower())

    def test_validate_missing_required_fields(self):
        """When configuration file is missing required fields, validate fails."""
        cfg_dir = self.repo / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "owner/repo",
            # missing remotes, branch, worktree_container
        }))

        res = self.run_config("validate", check=False)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("base_remote", res.stderr)

    def test_validate_nonexistent_remote(self):
        """When configuration references a git remote not configured in repo, validate fails."""
        cfg_dir = self.repo / ".paper-craft"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        (cfg_dir / "workspace-config.json").write_text(json.dumps({
            "schema_version": "1.0",
            "delivery_target": "owner/repo",
            "base_remote": "nonexistent_remote",
            "push_remote": "origin",
            "base_branch": "main",
            "worktree_container": "../project-worktrees",
        }))

        res = self.run_config("validate", check=False)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("nonexistent_remote", res.stderr)


if __name__ == "__main__":
    unittest.main()
