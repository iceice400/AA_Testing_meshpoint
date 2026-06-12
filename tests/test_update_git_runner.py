"""Tests for shared git runner helpers."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from src.api.update.git_runner import (
    GIT_BIN,
    ensure_git_safe_directory,
    git_prefix,
)


class TestGitPrefix(unittest.TestCase):
    def test_sudo_uses_absolute_git_path(self) -> None:
        self.assertEqual(git_prefix(use_sudo=True), ["sudo", GIT_BIN])

    def test_direct_git_uses_absolute_path(self) -> None:
        self.assertEqual(git_prefix(use_sudo=False), [GIT_BIN])


class TestEnsureGitSafeDirectory(unittest.TestCase):
    def test_runs_ensure_script_via_sudo(self) -> None:
        calls: list[list[str]] = []

        def runner(args, cwd, timeout):
            calls.append(list(args))
            return 0, "", ""

        with mock.patch.object(Path, "is_file", return_value=True):
            ok = ensure_git_safe_directory("/opt/meshpoint", runner=runner)

        self.assertTrue(ok)
        expected_script = (
            Path("/opt/meshpoint") / "scripts" / "ensure_git_safe.sh"
        ).as_posix()
        self.assertEqual(
            calls[0],
            ["sudo", "/bin/bash", expected_script, "/opt/meshpoint"],
        )

    def test_missing_script_returns_false(self) -> None:
        with mock.patch.object(Path, "is_file", return_value=False):
            ok = ensure_git_safe_directory("/opt/meshpoint", runner=lambda *a: (0, "", ""))
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
