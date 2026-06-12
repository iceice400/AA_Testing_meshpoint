"""Shared git invocation helpers for the dashboard update flow."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

GIT_BIN = "/usr/bin/git"
DEFAULT_REPO_PATH = "/opt/meshpoint"

Runner = Callable[[list[str], Optional[str], float], tuple[int, str, str]]


def git_prefix(*, use_sudo: bool) -> list[str]:
    """Argv prefix for git commands run from the meshpoint service account."""
    if use_sudo:
        return ["sudo", GIT_BIN]
    return [GIT_BIN]


def shell_runner(
    args: list[str], cwd: Optional[str], timeout_seconds: float,
) -> tuple[int, str, str]:
    """Default :data:`Runner` -- shells out via ``subprocess.run``."""
    completed = subprocess.run(  # noqa: S603 -- args is a structured list
        args,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def ensure_git_safe_directory(
    repo_path: str = DEFAULT_REPO_PATH,
    *,
    runner: Runner = shell_runner,
) -> bool:
    """Run ``scripts/ensure_git_safe.sh`` so root-owned trees are trusted."""
    script = Path(repo_path) / "scripts" / "ensure_git_safe.sh"
    if not script.is_file():
        logger.debug("ensure_git_safe: script missing at %s", script)
        return False
    rc, _, stderr = runner(
        ["sudo", "/bin/bash", script.as_posix(), repo_path],
        None,
        30.0,
    )
    if rc != 0:
        logger.warning(
            "ensure_git_safe failed for %s (rc=%s): %s",
            repo_path,
            rc,
            (stderr or "").strip()[:300],
        )
        return False
    return True
