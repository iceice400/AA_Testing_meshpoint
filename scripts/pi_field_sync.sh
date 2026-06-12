#!/bin/bash
# Sync /opt/meshpoint to origin/field/all-features for field testing.
# Run on the Pi: sudo bash scripts/pi_field_sync.sh
set -euo pipefail

REPO="${MESHPOINT_DIR:-/opt/meshpoint}"
BRANCH="${MESHPOINT_BRANCH:-field/all-features}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo bash $0" >&2
    exit 1
fi

if [ ! -d "${REPO}/.git" ]; then
    echo "No git repo at ${REPO}. Re-run install.sh from a git clone, or:" >&2
    echo "  cd ${REPO} && git init && git remote add origin <your-remote>" >&2
    exit 1
fi

if [ -f "${REPO}/config/local.yaml" ]; then
    cp "${REPO}/config/local.yaml" /tmp/meshpoint-local.yaml.bak
fi

systemctl stop meshpoint || true

if [ -f "${REPO}/scripts/ensure_git_safe.sh" ]; then
    bash "${REPO}/scripts/ensure_git_safe.sh" "${REPO}"
fi

git -C "${REPO}" fetch origin
git -C "${REPO}" checkout -f "${BRANCH}"
git -C "${REPO}" reset --hard "origin/${BRANCH}"
git -C "${REPO}" clean -fd

if [ -f /tmp/meshpoint-local.yaml.bak ]; then
    cp /tmp/meshpoint-local.yaml.bak "${REPO}/config/local.yaml"
    chown meshpoint:meshpoint "${REPO}/config/local.yaml" 2>/dev/null || true
fi

bash "${REPO}/scripts/install.sh"

systemctl start meshpoint
systemctl --no-pager status meshpoint || true
echo "Synced to $(git -C "${REPO}" rev-parse --short HEAD) on ${BRANCH}"
