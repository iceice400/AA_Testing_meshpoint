# AA_Testing fork — integration guide

**Fork:** [iceice400/AA_Testing_meshpoint](https://github.com/iceice400/AA_Testing_meshpoint)  
**Upstream:** [KMX415/meshpoint](https://github.com/KMX415/meshpoint)  
**Field integration branch:** `field/all-features`  
**PR queue:** [master-pr-roadmap.md](./master-pr-roadmap.md)

This document explains how the AA_Testing fork is organized, how to sync a Pi or dev machine, and how field work flows back to upstream as small PRs.

---

## Remote layout

| Remote | URL | Role |
|--------|-----|------|
| `upstream` | `https://github.com/KMX415/meshpoint.git` | Canonical project; submit PRs here |
| `aa_testing` | `https://github.com/iceice400/AA_Testing_meshpoint.git` | Field fork; Pi deploy target |
| `origin` | Should match `aa_testing` on field machines | Your push remote |

**One-time dev setup:**

```bash
git remote add upstream https://github.com/KMX415/meshpoint.git
git remote add aa_testing https://github.com/iceice400/AA_Testing_meshpoint.git
git remote set-url origin https://github.com/iceice400/AA_Testing_meshpoint.git
git fetch --all
```

If `origin` still points at `iceice400/meshpoint`, GitHub redirects to AA_Testing — set the URL explicitly to avoid confusion.

---

## Branch strategy

```
upstream/main  ─────────────────────────►  aa_testing/main  (tracking mirror)
      │                                           │
      │  individual PRs (#68–#90)                 │
      ▼                                           │
 feat/packet-detail-modal, feat/topology-graph-tab, …  (on both remotes)
      │                                           │
      │  field-only integration + fixes           │
      └──────────────────────────────────────────► field/all-features
```

| Branch | Purpose | Merge to upstream? |
|--------|---------|-------------------|
| `main` | Tracks `upstream/main` (stable / v0.7.6+) | N/A — pull from upstream |
| `field/all-features` | Full dashboard integration for Pi field testing | **No** — too large; split into PRs |
| `feat/*` | One feature per branch, aligned with [master-pr-roadmap](./master-pr-roadmap.md) | **Yes** — one PR at a time |

### Important: `field/all-features` history

The integration branch was created with a **root commit** (`88657ae`) that snapshots many in-flight features in one tree. It is **not** a linear extension of `upstream/main` in git history (no shared merge-base), even though the code corresponds to ~v0.7.6-era upstream.

Do **not** attempt a single merge of `field/all-features` into KMX415. Instead:

1. Land upstream PRs from `feat/*` branches (already submitted #68–#87, #90).
2. Cherry-pick or re-implement **field-only deltas** listed below onto fresh branches from `upstream/main`.
3. Rebuild `field/all-features` periodically by merging updated `main` + integration fixes (or re-export from merged feat branches).

---

## `field/all-features` commit map

| Commit | Summary | Upstream path |
|--------|---------|---------------|
| `88657ae` | Wire orphan PR routes, config, dashboard hooks | Bundle of feat/* PRs — wait for #68–#87 |
| `d62ce89` | Topology tab, 24h heatmap, push notifications | #72, #69, #77 |
| `aaee5ce` | Complete field integration UI + Pi sync | Integration only |
| `bfca4ee` | Remaining Pi dashboard gaps | Integration only |
| `8cf86b6` | MQTT TLS port + `ensure_git_safe` sudoers | Field ops — evaluate for upstream |
| `81d6c2c` | Field audit: deps, webhooks, branding, MQTT | Partially #82, #83, #90 |
| `11f0fe2` | Stats status strip, map hint, remove orphan frontend | #90 operator polish |
| `76a1e84` | Onboard GPS UART + Pi boot config | Field hardware — fork or small upstream PR |
| `f3e4af4` | GPS troubleshooting + field sync docs | Docs — can upstream README section |
| `3c407fb` | Dashboard map + smart topology dock (Tier A) | #72 topology-adjacent |
| `e2e0af7` | Dashboard map restore; topology tab Tier B/C | #72 + new poller/dark-node APIs |
| `756d921` | Packets browser tab + topology graph upgrades | #68 packets + #72 graph |
| `d7bfc8b` | Fix blank Packets tab + topology layout | Bugfixes on above |
| `5f6eab4` | MeshCore map from contact GPS + advert coords | **New** — candidate upstream PR |

---

## Suggested upstream PR slices (after queue merges)

Submit **one at a time** per [CONTRIBUTING.md](../../CONTRIBUTING.md):

| Priority | Branch name | Contents | Risk |
|----------|-------------|----------|------|
| 1 | `feat/meshcore-map-gps` | `5f6eab4` — coords parser, contact sync, map markers | 🟡 |
| 2 | `feat/packets-tab-integrated` | Packets SPA tab (#68 UI integrated into shell) | 🟢 |
| 3 | `feat/topology-tab-tier-bc` | Topology poller + dark node locator + tab layout | 🟡 |
| 4 | `fix/gps-uart-reader` | RAK onboard GPS UART (if reproducible on upstream hardware) | 🟡 |
| 5 | `chore/pi-git-safe-directory` | `ensure_git_safe.sh` + sudoers for root-owned repo | 🟢 |

Rebase each branch onto current `upstream/main` after every upstream merge.

---

## Pi field sync

On the Pi (`/opt/meshpoint`):

```bash
sudo git remote set-url origin https://github.com/iceice400/AA_Testing_meshpoint.git
sudo bash scripts/pi_field_sync.sh
```

The script:

- Fetches `field/all-features` (override with `MESHPOINT_BRANCH`)
- Preserves `config/local.yaml`
- Runs `install.sh` and restarts `meshpoint`

Verify after sync:

```bash
git -C /opt/meshpoint rev-parse --short HEAD   # expect >= 5f6eab4
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/health
```

Hard-refresh the dashboard (Ctrl+Shift+R) and exercise **Packets**, **Topology**, and **Map** (MeshCore markers).

Return to upstream stable:

```bash
cd /opt/meshpoint
sudo git remote set-url origin https://github.com/KMX415/meshpoint.git
sudo git fetch origin && sudo git checkout main && sudo git pull origin main
sudo bash scripts/install.sh && sudo systemctl restart meshpoint
```

---

## Dev machine sync

```bash
bash scripts/dev_fork_sync.sh
```

Fetches `upstream` and `aa_testing`, prints branch divergence, and reminds you which branch to checkout.

---

## Dashboard update picker

The **Field: all-features integration** channel (`field-all-features` → `field/all-features`) is registered in `src/api/update/channels.py` for operators who use dashboard Apply instead of SSH sync.

---

## Maintenance checklist

- [ ] After each upstream release: `git fetch upstream && git checkout main && git merge upstream/main && git push aa_testing main`
- [ ] Reconcile `field/all-features` with merged feat branches (or re-cherry-pick field-only commits)
- [ ] Open upstream PRs from slices above; close corresponding field-only commits once merged
- [ ] Update this doc when branch names or PR numbers change
