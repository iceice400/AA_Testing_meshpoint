#!/bin/bash
# Trust the root-owned install tree for git (meshpoint user and sudo git).
# Idempotent: safe to run on every install, apply, and post-update.
set -euo pipefail

REPO="${1:-/opt/meshpoint}"

if [ ! -d "${REPO}/.git" ]; then
    exit 0
fi

_add_safe_dir() {
    local scope="$1"
    shift
    if "$@" config --get-all safe.directory 2>/dev/null | grep -Fxq "${REPO}"; then
        return 0
    fi
    "$@" config --add safe.directory "${REPO}" 2>/dev/null || true
}

# Root / sudo git (dashboard apply, install_status rev-parse).
_add_safe_dir system git

# Direct git as meshpoint (SSH mistakes, diagnostics).
if id -u meshpoint &>/dev/null; then
    _add_safe_dir global sudo -u meshpoint git
fi
