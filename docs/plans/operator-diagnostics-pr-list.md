# Operator Diagnostics — PR Build List (7 PRs)

**Purpose:** Ordered, independent pull requests you can build one at a time after the earlier diagnostics discussion.  
**Workflow:** [CONTRIBUTING.md](../../CONTRIBUTING.md) — open **one GitHub issue** first, then branch each PR from current `main` (do not stack branches).  
**Detailed specs for PRs 1–4:** [operator-diagnostics-pr-suite.md](./operator-diagnostics-pr-suite.md)

---

## Master table

| # | PR | Branch | Complexity | Scope | Depends on | Conflicts with |
|---|-----|--------|------------|-------|------------|----------------|
| 1 | Deep Packet Inspection Modal | `feat/packet-detail-modal` | Low | Frontend only | — | PR 1 only (`simple_packet_feed.js`) |
| 2 | 24-Hour Traffic Histograms | `feat/traffic-histograms` | Low | Frontend + SQL | — | `stats_routes.py`, `stats_tab.js` |
| 3 | Signal Health Sparklines | `feat/signal-health-tracking` | Low–Medium | Frontend + SQL + optional yaml | — | `nodes.py`, `node_cards.js` |
| 4 | Smart Relay Controls | `feat/relay-filter-controls` | Medium | Frontend + relay + yaml | — | `relay_manager.py`, `system_config_routes.py` |
| 5 | Visual Topology Graph | `feat/topology-graph-tab` | Medium | Frontend (D3) + SQL | — | New tab; extends `analytics.py` |
| 6 | REST API for Automation | `feat/lan-rest-api` | Medium | Backend routes + auth docs | — | New `api_token` config; thin routes |
| 7 | Duty Cycle & Per-Channel Throttle | `feat/relay-duty-cycle` | Medium–High | Relay + ToA + UI | **PR 2** (ToA helper), **PR 4** (relay config UI) | `relay_manager.py`, `rate_limiter.py` |

**Merge order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 (ascending review risk). PRs 1–6 do not require each other; rebase onto `main` after each merge before starting the next.

---

## Shared prerequisites (every PR)

```bash
git fetch upstream
git checkout -b feat/<branch-name> upstream/main
```

**PR description must include:** what / why / how tested / hardware (RAK7248 or Pi+HAT) / region (US915) / risks / `Closes #NNN` or `Related to #NNN`.

**Suggested GitHub issue title:**

> `[Feature] Operator diagnostics suite — packet modal, traffic, signal health, relay, topology, API`

---

## PR 1 — Deep Packet Inspection Modal

| | |
|---|---|
| **Branch** | `feat/packet-detail-modal` |
| **Title** | `feat(dashboard): packet detail modal in live feed` |
| **Complexity** | Low — frontend only |
| **High-review area** | No |

### Build summary

Upgrade `frontend/js/simple_packet_feed.js`: replace inline JSON expand (`_toggleDetail`) with a structured modal.

### Files

- `frontend/js/simple_packet_feed.js` — open modal on row click
- `frontend/js/packet_detail_modal.js` — **new**
- `frontend/css/packet_detail_modal.css` — **new**
- `frontend/index.html` — script/style tags

### Data source

Existing WebSocket packet object (`Packet.to_dict()`). **No new API. No SQLite.**

### Defer to later

- Multi-channel “heard 3×” breakdown (not in packet model today)
- Channel name from `channel_hash` (needs config map)

### Done when

- [ ] Modal layers: RF, mesh header, payload/decrypt, capture meta
- [ ] Decrypt failure state explicit
- [ ] Close: ✕, Escape, backdrop
- [ ] Feed keeps updating behind modal
- [ ] Tested on RAK7248 / US915

---

## PR 2 — 24-Hour Traffic Histograms

| | |
|---|---|
| **Branch** | `feat/traffic-histograms` |
| **Title** | `feat(stats): 24-hour hourly traffic histogram with duty-cycle estimate` |
| **Complexity** | Low — frontend + one SQL aggregation |
| **High-review area** | No |

### Build summary

SQL-backed 24h hourly buckets on Stats tab. Complements existing 60-min in-memory timeline (`TrafficMonitor.get_recent_activity` over last 2000 packets).

### Files

| Layer | Files |
|-------|-------|
| Backend | `src/storage/packet_repository.py` — `get_hourly_traffic()` |
| Backend | `src/api/routes/stats_routes.py` — `GET /api/stats/hourly` |
| Backend | `src/analytics/toa_estimate.py` — **new** (shared with PR 7 later) |
| Frontend | `frontend/js/stats_tab.js` — new “Traffic (24h)” section |
| Frontend | `frontend/css/stats.css` |
| Tests | `tests/test_traffic_hourly.py` — **new** |

### Endpoint

```
GET /api/stats/hourly?hours=24
→ [{ hour, meshtastic, meshcore, total, toa_ms_estimated, duty_cycle_pct }]
```

Uses existing `idx_packets_timestamp`. No schema migration.

### UI

- Chart.js stacked bars (already on page)
- Duty cycle line on secondary axis — label **“est.”**
- EU868: dashed 1% limit when `radio.region == EU_868`

### Done when

- [ ] Hourly counts match manual SQL on 72h dataset
- [ ] `< 100 ms` on Pi 4 (~30k rows)
- [ ] 5-min refresh without chart flicker
- [ ] US915: no false EU duty warning

---

## PR 3 — Signal Health Sparklines

| | |
|---|---|
| **Branch** | `feat/signal-health-tracking` |
| **Title** | `feat(nodes): signal health sparklines and RSSI health badge` |
| **Complexity** | Low–Medium — frontend + SQL + optional config |
| **High-review area** | No |

### Build summary

Per-node 15-min RSSI/SNR buckets on node cards + health badge. Extends existing `GET /api/nodes/{node_id}/metrics_history` (raw samples already returned for `NodeDrawer`).

### Files

| Layer | Files |
|-------|-------|
| Backend | `src/storage/packet_repository.py` — `get_signal_buckets()` |
| Backend | `src/api/routes/nodes.py` — add `signal_buckets` to response (or `bucket_minutes` param) |
| Backend | `src/config.py` — optional `SignalHealthConfig` |
| Backend | `src/api/routes/config_enrichment.py` |
| Frontend | `frontend/js/signal_sparkline.js` — **new** (canvas; follow `noise_floor_sparkline.js`) |
| Frontend | `frontend/js/node_cards.js` — badge + lazy sparkline |
| Frontend | `frontend/css/node_cards.css` |
| Tests | `tests/test_signal_buckets.py` — **new** |

### Config (optional)

```yaml
signal_health:
  green_rssi_floor: -100
  yellow_rssi_floor: -115
  min_packets_per_hour: 5
```

### UI rules

- `IntersectionObserver` — fetch buckets only when card visible
- Badge hidden if `< min_packets_per_hour`
- Sparse gaps: dashed connector in sparkline

### Done when

- [ ] Bucket counts match SQL spot checks
- [ ] Threshold change in yaml updates badge
- [ ] Pass-through nodes: no false Red badge
- [ ] Desktop + 375px mobile

---

## PR 4 — Smart Relay Controls (Blocklist / Priority / Dedup TTL)

| | |
|---|---|
| **Branch** | `feat/relay-filter-controls` |
| **Title** | `feat(relay): blocklist, priority list, and dedup TTL dashboard controls` |
| **Complexity** | Medium — relay module + config + UI |
| **High-review area** | **Yes — relay** |

### Build summary

Dashboard controls for three relay filters. Extends existing `PUT /api/config/relay` (`system_config_routes.py`) — **not** a new `/api/relay/config` route.

### Correctness notes (from codebase audit)

| Draft assumption | Reality |
|------------------|---------|
| Dedup default 30 s | **`DeduplicationFilter` default `ttl_seconds=300`** (5 min) |
| Priority skips “TX queue” | `RateLimiter` global window — priority = **bypass burst gate**, not per-minute cap |
| Relay settings location | Configuration → Advanced today; add **`relay_filters_card.js`** |

### Files

| Layer | Files |
|-------|-------|
| Config | `src/config.py` — `RelayConfig.blocklist`, `priority_list`, `dedup_ttl_seconds` |
| Relay | `src/relay/relay_manager.py` — early blocklist; configurable dedup TTL |
| Relay | `src/relay/dedup_filter.py` — expose TTL setter |
| Relay | `src/relay/rate_limiter.py` — `allow_priority()` |
| API | `src/api/routes/system_config_routes.py` — extend `RelaySettingsUpdate` |
| API | `src/api/routes/config_enrichment.py` |
| Frontend | `frontend/js/configuration/relay_filters_card.js` — **new** |
| Frontend | `frontend/js/configuration/configuration_panel.js` — mount card |
| Tests | `tests/test_relay_filters.py` — **new** |

### Config

```yaml
relay:
  blocklist: []           # 8-char hex node IDs (no ! prefix)
  priority_list: []
  dedup_ttl_seconds: 300  # omit = current behaviour
```

### UI copy

> Blocklist affects **relay only** — packets still appear in the live feed.

### Done when

- [ ] Blocklist add/remove persists across restart
- [ ] Log reason `blocklisted` before TX queue
- [ ] Priority ordering visible under congestion
- [ ] Dedup TTL 10 s vs 600 s behaviour verified
- [ ] Node ID validation `^[0-9a-f]{8}$` → 400 on bad input
- [ ] Hot reload without full service restart

---

## PR 5 — Visual Topology Graph

| | |
|---|---|
| **Branch** | `feat/topology-graph-tab` |
| **Title** | `feat(topology): force-directed mesh graph from NEIGHBORINFO and TRACEROUTE` |
| **Complexity** | Medium — frontend (D3) + SQL |
| **High-review area** | No |

### Build summary

Dedicated **Topology** dashboard tab with interactive force-directed graph. Builds on data Meshpoint already decodes and partially exposes.

### Already exists (extend, don’t reinvent)

| Asset | Location |
|-------|----------|
| `GET /api/analytics/topology` | `src/api/routes/analytics.py` — NEIGHBORINFO links |
| Map overlay | `frontend/js/components/node_map.js` — Leaflet polylines from same endpoint |
| Decoders | `src/decode/portnum_handlers.py` — `neighborinfo`, `traceroute` payloads |

### Files

| Layer | Files |
|-------|-------|
| Backend | `src/api/routes/analytics.py` — extend topology: nodes + edges + optional TRACEROUTE paths, `?hours=24` window |
| Backend | `src/storage/packet_repository.py` — `get_topology_edges(since)` |
| Frontend | `frontend/js/topology_tab.js` — **new** D3 force graph |
| Frontend | `frontend/css/topology.css` — **new** |
| Frontend | `frontend/index.html` — D3 CDN (or vendor copy), sidebar route `#/topology` |
| Tests | `tests/test_topology_api.py` — **new** |

### Graph encoding

| Element | Source |
|---------|--------|
| Nodes | Known nodes + NEIGHBORINFO endpoints |
| Edges | NEIGHBORINFO neighbor SNR/RSSI; weight by RSSI |
| Node colour | Protocol (meshtastic / meshcore) |
| Node size | Packet count in time window |
| TRACEROUTE | Optional path highlight on node click |

### Time windows

`1h` / `6h` / `24h` selector — SQL `WHERE timestamp >= ?`.

### Done when

- [ ] Graph renders with ≥10 nodes from live NEIGHBORINFO traffic
- [ ] Weak links (< -110 dBm) visually distinct
- [ ] Time window changes refresh graph
- [ ] No impact on relay/TX (read-only SQL)
- [ ] Performance acceptable on Pi 4 (limit edge query, e.g. last 500 NI packets)

---

## PR 6 — REST API for External Automation

| | |
|---|---|
| **Branch** | `feat/lan-rest-api` |
| **Title** | `feat(api): documented LAN automation API with optional token auth` |
| **Complexity** | Medium — backend routes + auth + docs |
| **High-review area** | Partial — TX send path |

### Build summary

Formalize a **minimal scripting API** for Home Assistant / Node-RED on the LAN. Much already exists behind dashboard JWT auth; this PR documents it and adds optional **token auth** for non-browser clients.

### Already exists

| Endpoint | Purpose |
|----------|---------|
| `GET /api/nodes` | Node list with signal |
| `GET /api/nodes/{id}` | Node detail |
| `GET /api/packets?limit=N` | Recent packets |
| `POST /api/messages/send` | Meshtastic broadcast/DM |
| `GET /api/device/status` | Health snapshot |

### Files

| Layer | Files |
|-------|-------|
| Config | `src/config.py` — `ApiAutomationConfig`: `enabled`, `token` (optional) |
| Auth | `src/api/auth/dependencies.py` — accept `X-Meshpoint-Token` or `Authorization: Bearer <api_token>` when configured |
| Routes | `src/api/routes/automation_routes.py` — **new** thin wrappers (or alias existing handlers) |
| Docs | `docs/API-AUTOMATION.md` — **new** |
| Docs | `docs/CONFIGURATION.md` — token setup section |
| Tests | `tests/test_automation_api.py` — **new** |

### Proposed surface (v1)

```
GET  /api/automation/nodes          → alias /api/nodes
GET  /api/automation/nodes/{id}     → alias /api/nodes/{id}
GET  /api/automation/packets        → alias /api/packets?limit=
POST /api/automation/send           → { "text": "...", "channel": 0 }
```

### Security model

- `api.automation.enabled: false` by default
- When enabled, require `api.automation.token` (random 32+ chars) **or** existing dashboard JWT
- Bind to LAN only — document “do not port-forward”; consistent with local-first privacy
- Rate-limit `POST /send` (reuse existing message send guards)

### Out of scope

- Public internet exposure
- Meshradar cloud API
- WebSocket streaming for automation

### Done when

- [ ] curl with token works; without token → 401
- [ ] Token absent from repo / logs
- [ ] `docs/API-AUTOMATION.md` with copy-paste HA examples
- [ ] Disabled by default — zero behaviour change on upgrade

---

## PR 7 — Duty Cycle Overlay & Per-Channel Throttle

| | |
|---|---|
| **Branch** | `feat/relay-duty-cycle` |
| **Title** | `feat(relay): per-channel TX throttle and live duty-cycle budget` |
| **Complexity** | Medium–High — relay + ToA + UI |
| **High-review area** | **Yes — relay + TX** |

### Build summary

Operator-facing **per-channel relay duty budget** and live duty-cycle meter. Reuses ToA estimator from **PR 2**. Extends relay config UI from **PR 4**.

### Soft dependencies

| PR | Why |
|----|-----|
| PR 2 | `src/analytics/toa_estimate.py` — don’t duplicate ToA math |
| PR 4 | Relay filters card — add throttle section to same Configuration area |

Rebase onto `main` after 2 and 4 merge before opening PR 7.

### Files

| Layer | Files |
|-------|-------|
| Analytics | `src/analytics/toa_estimate.py` — extend per-packet ToA |
| Relay | `src/relay/channel_budget.py` — **new** per-channel rolling ToA budget |
| Relay | `src/relay/relay_manager.py` — check budget before approve |
| Config | `src/config.py` — `relay.channel_throttle_percent: { "0": 100, "1": 50 }` |
| API | `src/api/routes/system_config_routes.py` |
| API | `src/api/routes/stats_routes.py` — `GET /api/stats/duty_cycle` live budget |
| Frontend | `frontend/js/configuration/relay_filters_card.js` — throttle sliders |
| Frontend | `frontend/js/stats_tab.js` — live duty meter (optional) |
| Tests | `tests/test_relay_duty_cycle.py` — **new** |

### Behaviour

- Throttle is **relay TX only** — does not change concentrator native TX (`transmit.enabled`)
- EU868: respect 1% regional hint from `radio.region` as ceiling suggestion
- US915: operator-set % only (no legal line)
- UI labels every value **estimate** — same as PR 2

### Risks (call out in PR)

- Misconfigured throttle can starve relay traffic on busy channels
- ToA estimate ≠ spectrum analyser measurement
- Touches `RelayManager.evaluate()` — request maintainer review

### Done when

- [ ] Channel 0 at 50% throttle reduces relay TX under synthetic load
- [ ] Duty meter updates on Stats tab
- [ ] Omitting `channel_throttle_percent` = 100% all channels (today’s behaviour)
- [ ] Unit tests for budget accounting

---

## Issue ↔ PR map (for GitHub)

| Feature request section | PR |
|-------------------------|-----|
| §2 Deep Packet Inspection | **1** |
| §4 24-Hour Traffic Histograms | **2** |
| §3 Signal Health | **3** |
| §5 Smart Relay (blocklist/priority/window) | **4** |
| §1 Visual Topology Graph | **5** |
| §6 REST API | **6** |
| §5 Duty cycle / per-channel throttle | **7** |

---

## Recommended build sequence

```
Issue opened on KMX415/meshpoint
        │
        ▼
   PR 1 ──merge──► main
        │ rebase
        ▼
   PR 2 ──merge──► main
        │ rebase
        ▼
   PR 3 ──merge──► main
        │ rebase
        ▼
   PR 4 ──merge──► main   ◄── extra relay review
        │ rebase
        ▼
   PR 5 ──merge──► main
        │ rebase
        ▼
   PR 6 ──merge──► main
        │ rebase (needs PR 2 + 4 landed)
        ▼
   PR 7 ──merge──► main   ◄── highest review; uses ToA + relay UI
```

---

## Operator test matrix (all PRs)

| Item | Value |
|------|-------|
| Primary hardware | RAK Hotspot V2 (RAK7248) or Pi 4 + RAK2287/5146 Pi HAT |
| Region | US915 (EU868 re-test for PR 2 duty line + PR 7) |
| OS | Raspberry Pi OS 64-bit Bookworm |
| Load profile | ~8k–12k packets/day backbone |
| MeshCore | Heltec V3 `companion_radio_usb` optional (PR 2 protocol split) |

---

## What to say when starting each PR

| Step | Command / action |
|------|------------------|
| Start PR 1 | `git checkout -b feat/packet-detail-modal upstream/main` |
| After PR 1 merges | `git checkout -b feat/traffic-histograms upstream/main` |
| … | Repeat for each branch name in table |
| Before PR 7 | Confirm PR 2 and PR 4 are on `main` |

Say **“start PR N”** in chat when you want implementation to begin for that item.
