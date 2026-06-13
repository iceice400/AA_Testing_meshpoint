#!/bin/bash
# Sync /opt/meshpoint to the AA_Testing field integration branch.
# Run on the Pi: sudo bash scripts/pi_field_sync.sh
#
# Defaults: remote=origin, branch=field/all-features.
# Override: MESHPOINT_REMOTE=aa_testing MESHPOINT_BRANCH=field/all-features
# See docs/plans/AA_TESTING_FORK.md
set -euo pipefail

REPO="${MESHPOINT_DIR:-/opt/meshpoint}"
REMOTE="${MESHPOINT_REMOTE:-origin}"
BRANCH="${MESHPOINT_BRANCH:-field/all-features}"
AA_TESTING_URL="${MESHPOINT_AA_TESTING_URL:-https://github.com/iceice400/AA_Testing_meshpoint.git}"

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

ORIGIN_URL="$(git -C "${REPO}" remote get-url "${REMOTE}" 2>/dev/null || true)"
if [ -z "${ORIGIN_URL}" ]; then
    echo "Adding remote ${REMOTE} -> ${AA_TESTING_URL}" >&2
    git -C "${REPO}" remote add "${REMOTE}" "${AA_TESTING_URL}"
elif ! echo "${ORIGIN_URL}" | grep -q "AA_Testing_meshpoint"; then
    echo "Warning: ${REMOTE} is ${ORIGIN_URL} (expected AA_Testing_meshpoint)." >&2
    echo "  sudo git -C ${REPO} remote set-url ${REMOTE} ${AA_TESTING_URL}" >&2
fi

git -C "${REPO}" fetch "${REMOTE}"
git -C "${REPO}" checkout -f "${BRANCH}"
git -C "${REPO}" reset --hard "${REMOTE}/${BRANCH}"
git -C "${REPO}" clean -fd

if [ -f /tmp/meshpoint-local.yaml.bak ]; then
    cp /tmp/meshpoint-local.yaml.bak "${REPO}/config/local.yaml"
    chown meshpoint:meshpoint "${REPO}/config/local.yaml" 2>/dev/null || true
fi

bash "${REPO}/scripts/install.sh"

systemctl start meshpoint
systemctl --no-pager status meshpoint || true
echo "Synced to $(git -C "${REPO}" rev-parse --short HEAD) on ${REMOTE}/${BRANCH}"
