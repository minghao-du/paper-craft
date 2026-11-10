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
sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import resolve_workspace_config, validate_workspace_config, SCHEMA_VERSION


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
        self.assertEqual(data.get("workflow"), "default")
        self.assertEqual(data.get("delivery_attempts_max"), 3)
        self.assertEqual(data.get("replans_max"), 2)

        res_show = self.run_config("show")
        self.assertEqual(res_show.returncode, 0)
        show_data = json.loads(res_show.stdout)
        self.assertEqual(show_data, data)

    def test_init_supports_workflow_and_budgets(self):
        """Init supports project settings including workflow, delivery_attempts_max, replans_max."""
        res = self.run_config(
            "init",
            "--workflow", "custom-workflow",
            "--delivery-attempts-max", "5",
            "--replans-max", "4",
            "--defaults",
        )
        self.assertEqual(res.returncode, 0)

        config_file = self.repo / ".paper-craft" / "workspace-config.json"
        with open(config_file, "r", encoding="utf-8") as f:
            data = json.load(f)

        self.assertEqual(data.get("workflow"), "custom-workflow")
        self.assertEqual(data.get("delivery_attempts_max"), 5)
        self.assertEqual(data.get("replans_max"), 4)

    def test_obsolete_aliases_rejected(self):
        """Obsolete top-level flag aliases (--show, --init, --validate) are removed and rejected."""
        res_show = self.run_config("--show", check=False)
        self.assertNotEqual(res_show.returncode, 0)

        res_init = self.run_config("--init", check=False)
        self.assertNotEqual(res_init.returncode, 0)

        res_validate = self.run_config("--validate", check=False)
        self.assertNotEqual(res_validate.returncode, 0)

    def test_init_fails_when_remote_undetectable(self):
        """When repo has no remotes and no explicit base_remote, init stops immediately without guessing."""
        no_remote_repo = self.root / "no-remote-repo"
        no_remote_repo.mkdir()
        self.git(no_remote_repo, "init", "--initial-branch=main")

        res = subprocess.run(
            [sys.executable, str(CONFIG_SCRIPT), "--repo-dir", str(no_remote_repo), "init", "--defaults"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("No git remotes configured", res.stderr)

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

    def test_resolve_workspace_config_api(self):
        """resolve_workspace_config parses, validates, and merges overrides deterministically."""
        # 1. Missing with require_file=True raises ValueError with guidance
        with self.assertRaises(ValueError) as ctx:
            resolve_workspace_config(self.repo, require_file=True)
        self.assertIn("pc-workspace-config", str(ctx.exception))

        # 2. Initialize valid config
        self.run_config("init", "--defaults")

        resolved = resolve_workspace_config(self.repo)
        self.assertEqual(resolved["delivery_target"], "test-owner/my-project")
        self.assertEqual(resolved["base_remote"], "origin")
        self.assertEqual(resolved["push_remote"], "origin")
        self.assertEqual(resolved["base_branch"], "main")
        self.assertEqual(resolved["workflow"], "default")
        self.assertEqual(resolved["delivery_attempts_max"], 3)
        self.assertEqual(resolved["replans_max"], 2)
        self.assertEqual(resolved["repo_checkout"], str(self.repo.resolve()))

        # 3. Explicit overrides take precedence
        overridden = resolve_workspace_config(
            self.repo,
            overrides={
                "workflow": "custom-wf",
                "delivery_attempts_max": 9,
                "replans_max": 7,
            },
        )
        self.assertEqual(overridden["workflow"], "custom-wf")
        self.assertEqual(overridden["delivery_attempts_max"], 9)
        self.assertEqual(overridden["replans_max"], 7)
        self.assertEqual(overridden["delivery_target"], "test-owner/my-project")


if __name__ == "__main__":
    unittest.main()
