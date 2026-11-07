#!/usr/bin/env python3
"""Exercise workspace preparation against local Git repositories through its CLI."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).with_name("prepare-worktree.py")


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
        return json.loads(result.stdout)

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


if __name__ == "__main__":
    unittest.main()
