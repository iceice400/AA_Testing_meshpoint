#!/bin/bash
# Dev-machine sync for the AA_Testing field fork.
# Fetches upstream + aa_testing, prints branch status, optional checkout.
#
# Usage:
#   bash scripts/dev_fork_sync.sh              # status only
#   bash scripts/dev_fork_sync.sh --checkout   # checkout field/all-features
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

AA_TESTING_URL="${MESHPOINT_AA_TESTING_URL:-https://github.com/iceice400/AA_Testing_meshpoint.git}"
UPSTREAM_URL="${MESHPOINT_UPSTREAM_URL:-https://github.com/KMX415/meshpoint.git}"
FIELD_BRANCH="${MESHPOINT_BRANCH:-field/all-features}"

_ensure_remote() {
    local name="$1"
    local url="$2"
    if git remote get-url "${name}" &>/dev/null; then
        echo "  ${name}: $(git remote get-url "${name}")"
    else
        echo "  adding remote ${name} -> ${url}"
        git remote add "${name}" "${url}"
    fi
}

echo "=== MeshPoint fork sync ==="
echo "Repo: ${REPO_ROOT}"
echo ""
echo "Remotes:"
_ensure_remote upstream "${UPSTREAM_URL}"
_ensure_remote aa_testing "${AA_TESTING_URL}"

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ "${ORIGIN_URL}" != *"AA_Testing_meshpoint"* ]]; then
    echo ""
    echo "Hint: origin is not AA_Testing. Recommended:"
    echo "  git remote set-url origin ${AA_TESTING_URL}"
fi

echo ""
echo "Fetching..."
git fetch upstream
git fetch aa_testing

UPSTREAM_HEAD="$(git rev-parse upstream/main)"
AA_MAIN="$(git rev-parse aa_testing/main 2>/dev/null || echo '?')"
FIELD_HEAD="$(git rev-parse "aa_testing/${FIELD_BRANCH}" 2>/dev/null || echo '?')"
CURRENT="$(git rev-parse --abbrev-ref HEAD)"
CURRENT_SHA="$(git rev-parse --short HEAD)"

echo ""
echo "Branches:"
echo "  upstream/main     $(git log -1 --oneline "${UPSTREAM_HEAD}")"
echo "  aa_testing/main   $(git log -1 --oneline "${AA_MAIN}" 2>/dev/null || echo '(missing)')"
echo "  aa_testing/${FIELD_BRANCH} $(git log -1 --oneline "${FIELD_HEAD}" 2>/dev/null || echo '(missing)')"
echo "  current (${CURRENT}) ${CURRENT_SHA}"

if [[ "${AA_MAIN}" != "?" && "${UPSTREAM_HEAD}" != "${AA_MAIN}" ]]; then
    echo ""
    echo "Note: aa_testing/main differs from upstream/main — consider:"
    echo "  git checkout main && git merge upstream/main && git push aa_testing main"
fi

if [[ "${1:-}" == "--checkout" ]]; then
    git checkout "${FIELD_BRANCH}"
    git pull aa_testing "${FIELD_BRANCH}" 2>/dev/null || git merge "aa_testing/${FIELD_BRANCH}"
    echo ""
    echo "On ${FIELD_BRANCH} at $(git rev-parse --short HEAD)"
fi

echo ""
echo "Pi deploy: sudo bash scripts/pi_field_sync.sh"
echo "Docs: docs/plans/AA_TESTING_FORK.md"
