# Operator Diagnostics PR Suite — Implementation Specs

**Status:** Draft for operator review before any branch work.  
**Upstream target:** `KMX415/meshpoint:main`  
**Workflow:** Per [CONTRIBUTING.md](../../CONTRIBUTING.md) — open the feature issue first, then submit **one PR at a time**, each branched from current `main` (not stacked).

---

## Before you start

### 1. Open the GitHub issue

Use the feature-request text you already drafted (Operator Diagnostics Suite). Suggested title:

> `[Feature] Operator diagnostics: packet modal, 24h traffic, signal health, relay filters`

Label it `enhancement`. Link that issue in every PR body as `Closes #NNN` or `Related to #NNN` depending on whether you split the issue per PR.

### 2. Submission rules (from CONTRIBUTING)

| Rule | How this suite complies |
|------|-------------------------|
| One change per PR | Four independent PRs, four branches |
| Branch from `main` | `git fetch upstream && git checkout -b feat/... upstream/main` |
| Rebase on conflict | `git rebase upstream/main` + force-push (no merge commits into PR branch) |
| Squash merge | Put the full test narrative in the PR description |
| High-review areas | PR 4 touches relay — extra detail required |

### 3. What already exists (important)

Your draft assumed green-field files. The codebase already has overlapping pieces:

| Your draft | Current Meshpoint |
|------------|-------------------|
| `frontend/components/PacketFeed.js` | `frontend/js/simple_packet_feed.js` — **already expands rows inline** (`_toggleDetail`) with raw JSON |
| `GET /api/stats/hourly` | `GET /api/stats/summary` + `traffic_timeline` (60 min, 5-min buckets, **in-memory** over last 2000 packets) |
| `GET /api/nodes/{id}/signal_history` | `GET /api/nodes/{node_id}/metrics_history` — raw RSSI samples + telemetry |
| `POST /api/relay/config` | `PUT /api/config/relay` in `system_config_routes.py` |
| Duplicate window 30 s | `DeduplicationFilter` default **`ttl_seconds=300`** (5 min) in `src/relay/dedup_filter.py` |
| Chart.js | Already loaded in `frontend/index.html` (v4.4.4); used by `stats_tab.js`, `node_metrics_chart.js` |
| Relay panel | Relay knobs live under **Configuration → Advanced** (`advanced_card.js`) + `PUT /api/config/relay` |

These PRs **extend** existing surfaces; they do not replace the architecture.

---

## PR 1 of 4 — Packet Detail Modal

| Field | Value |
|-------|-------|
| **Branch** | `feat/packet-detail-modal` |
| **Base** | `main` |
| **Type** | Frontend only |
| **Risk** | Low |
| **Touches relay/decoder/radio** | No |

### Title

```
feat(dashboard): packet detail modal in live feed
```

### Summary

Replace the live feed’s inline JSON expand row with a structured **modal** that layers RF, mesh header, payload/decrypt status, and metadata — using the **existing WebSocket packet object** (no new API routes, no SQLite changes).

### Motivation

`simple_packet_feed.js` already calls `_toggleDetail()` on row click and dumps `decoded_payload` as JSON. Operators still cannot quickly see decrypt failure vs empty payload, hop math, or modem params without reading raw JSON. This PR is a **UX upgrade** of existing behavior.

### Files to change

| File | Change |
|------|--------|
| `frontend/js/simple_packet_feed.js` | Row click opens modal instead of inserting `.packet-detail-row`; keep `_onFocus` callback |
| `frontend/js/packet_detail_modal.js` | **New** — render layers, keyboard/backdrop close |
| `frontend/css/packet_detail_modal.css` | **New** — overlay, layer grid, mobile scroll |
| `frontend/index.html` | Include new JS/CSS |

**Do not add** `PacketDetailModal` under a `components/` tree unless you also migrate other dashboard widgets — match the flat `frontend/js/` convention.

### WebSocket packet fields available today

From `Packet.to_dict()` / feed rendering:

```javascript
{
  packet_id, source_id, destination_id, protocol, packet_type,
  hop_limit, hop_start, hop_count, channel_hash, want_ack,
  relay_node, decoded_payload, decrypted, capture_source,
  timestamp, signal: {
    rssi, snr, frequency_mhz, spreading_factor,
    bandwidth_khz, coding_rate, signal_quality_percent
  }
}
```

### Modal sections (mapped to real fields)

| Section | Source fields | Notes |
|---------|---------------|-------|
| **RF** | `signal.*`, `packet.rssi`/`snr` fallbacks | **Time-on-air:** not in packet today — either omit in v1 or add a small client-side estimator (SF/BW/payload length) labelled **“est.”** |
| **Mesh** | `source_id`, `destination_id`, `packet_type`, `hop_start`/`hop_limit`/`hop_count`, `want_ack`, `relay_node` | Resolve display names via existing node map in feed (`loadNodes`) |
| **Payload** | `decoded_payload`, `decrypted`, `packet_type` | Failed decrypt: `decrypted === false` → show “No matching key” + optional hex from payload if present |
| **Capture** | `capture_source`, `packet_id`, `timestamp` | Honest label: concentrator vs meshcore_usb vs serial |

### Out of scope for PR 1 (defer honestly)

| Draft feature | Why deferred |
|---------------|--------------|
| “Heard 3× on CH 0, 3, 7” duplicate breakdown | Packet model stores **one** RSSI per DB row; multi-RF-chain duplicate aggregation is not in `Packet` or WS payload today |
| Channel name “LongFast” | Only `channel_hash` on wire — map via `meshtastic.channel_keys` / config in a follow-up |
| Portnum name column | Use `packet_type` enum string; map to Meshtastic portnums only when `decoded_payload.portnum` exists |

### UI behaviour

- Open: row click (replace current expand)
- Close: ✕, `Escape`, backdrop click
- Feed keeps updating behind modal (no WS unsubscribe)
- Large binary payloads: truncate hex/text with “Show more” toggle (mobile overflow guard)
- Preserve `setOnFocus(source_id)` when modal opens (map highlight)

### How to test

```text
Hardware: RAK7248 or Pi + RAK2287/5146 HAT, US915 LongFast
1. Receive mixed portnums: text, position, telemetry, nodeinfo, routing, traceroute
2. Click each row → modal fields populated
3. Wrong PSK on private channel → decrypt failure state visible
4. Escape / backdrop / ✕ close
5. Chrome + Firefox + narrow viewport (375px)
```

### PR body checklist

- [ ] Frontend only — no Python changes
- [ ] No new endpoints
- [ ] No SQLite schema changes
- [ ] Replaces inline expand (mention in “What changed”)
- [ ] Duplicate-RF section explicitly deferred with issue link

---

## PR 2 of 4 — 24-Hour Traffic Histograms

| Field | Value |
|-------|-------|
| **Branch** | `feat/traffic-histograms` |
| **Base** | `main` |
| **Type** | Frontend + read-only SQL |
| **Risk** | Low–medium |
| **Touches relay/decoder/radio** | No |

### Title

```
feat(stats): 24-hour hourly traffic histogram with duty-cycle estimate
```

### Summary

Add a **SQL-backed** 24-hour hourly traffic view to the Stats tab: Meshtastic vs MeshCore stacked bars plus an estimated duty-cycle line. Complements the existing 60-minute in-memory timeline in `stats_tab.js` (which scans only the last 2000 packets).

### Motivation

`TrafficMonitor.get_recent_activity()` buckets in Python over `get_recent(2000)`. On a 10k packets/day backbone node, 24h history is wrong or sparse. Hourly aggregation should hit SQLite directly — `idx_packets_timestamp` already exists in `src/storage/database.py`.

### Backend changes

| File | Change |
|------|--------|
| `src/storage/packet_repository.py` | Add `get_hourly_traffic(hours=24) -> list[dict]` |
| `src/api/routes/stats_routes.py` | Add `GET /api/stats/hourly` |
| `tests/test_traffic_hourly.py` | **New** — bucket correctness against fixture DB |

**Query shape (SQLite):**

```sql
SELECT
  strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour_start,
  SUM(CASE WHEN protocol = 'meshtastic' THEN 1 ELSE 0 END) AS meshtastic,
  SUM(CASE WHEN protocol = 'meshcore' THEN 1 ELSE 0 END) AS meshcore,
  COUNT(*) AS total
FROM packets
WHERE timestamp >= ?
GROUP BY hour_start
ORDER BY hour_start ASC;
```

**Response:**

```json
[
  {
    "hour": "2026-06-02T14:00:00+00:00",
    "meshtastic": 312,
    "meshcore": 47,
    "total": 359,
    "toa_ms_estimated": 84200,
    "duty_cycle_pct": 2.34
  }
]
```

### Time-on-air estimate

- New small helper: `src/analytics/toa_estimate.py` (or method on `TrafficMonitor`)
- Inputs: `radio.spreading_factor`, `radio.bandwidth_khz`, `radio.coding_rate`, `radio.preamble_length` from loaded config + per-row `spreading_factor`/`bandwidth_khz` when present else regional default
- Sum per hour; label UI **“Duty cycle (est.)”** — does not drive TX throttle

### EU868 limit line

- Read `config.radio.region`
- If `EU_868`, draw dashed 1% reference on secondary axis
- US915: omit limit line (no false compliance warning)

### Frontend changes

| File | Change |
|------|--------|
| `frontend/js/stats_tab.js` | New section **“Traffic (24h)”** below existing 60-min chart; fetch `/api/stats/hourly` every 5 min while tab active |
| `frontend/css/stats.css` | Bar + dual-axis layout |

Use existing **Chart.js** (already on page) — same pattern as `_charts` in `StatsTab`.

### Performance target

- `< 100 ms` on Pi 4 with ~30k-row DB (indexed `timestamp`)
- No new index required unless profiling shows otherwise; document if adding `idx_packets_timestamp_protocol` composite later

### How to test

```text
1. Seed or use 72h DB (~28k packets)
2. Compare hourly counts to manual SQL
3. Toggle region EU_868 vs US in local.yaml → limit line appears/disappears
4. Empty hours → zero-height bars, not gaps
5. 5-min refresh: update data without destroying chart instance (Chart.js `data` patch)
```

### PR body checklist

- [ ] One new **read-only** GET route
- [ ] No schema migration
- [ ] Existing 60-min chart unchanged
- [ ] Duty cycle labelled estimate
- [ ] Unit test for SQL bucketing

---

## PR 3 of 4 — Per-Node Signal Health

| Field | Value |
|-------|-------|
| **Branch** | `feat/signal-health-tracking` |
| **Base** | `main` |
| **Type** | Frontend + read-only SQL + optional config |
| **Risk** | Low |
| **Touches relay/decoder/radio** | No |

### Title

```
feat(nodes): signal health sparklines and RSSI health badge on node cards
```

### Summary

Add **15-minute bucketed** RSSI/SNR sparklines and a Green/Yellow/Red health badge to node cards. Extend the existing node metrics API rather than inventing a parallel route.

### Motivation

Node cards (`node_cards.js`) show last-heard RSSI only. `NodeDrawer` already charts raw samples from `GET /api/nodes/{node_id}/metrics_history`. Operators need **trend at a glance** on the card list without opening the drawer.

### Backend changes

| File | Change |
|------|--------|
| `src/storage/packet_repository.py` | Add `get_signal_buckets(node_id, hours=24, bucket_minutes=15)` |
| `src/api/routes/nodes.py` | Extend `metrics_history` with optional `bucket_minutes` query param **or** add `GET /api/nodes/{node_id}/signal_buckets` |
| `src/config.py` | Optional `SignalHealthConfig` nested under `AppConfig` |
| `config/default.yaml` | Commented defaults |
| `tests/test_signal_buckets.py` | **New** |

**Preferred API** (extend existing route):

```
GET /api/nodes/{node_id}/metrics_history?hours=24&bucket_minutes=15
```

Add to response:

```json
{
  "signal_buckets": [
    { "bucket": "2026-06-02T14:00:00+00:00", "rssi_avg": -91.4, "snr_avg": 5.2, "packet_count": 3 }
  ]
}
```

Keep existing raw `signal` array for drawer backward compatibility.

### Config (optional keys)

```yaml
signal_health:
  green_rssi_floor: -100
  yellow_rssi_floor: -115
  min_packets_per_hour: 5   # suppress badge below this
```

Wire through `config_enrichment.py` for dashboard read.

### Frontend changes

| File | Change |
|------|--------|
| `frontend/js/signal_sparkline.js` | **New** — canvas sparkline (follow `sidebar/noise_floor_sparkline.js` pattern, or thin Chart.js line) |
| `frontend/js/node_cards.js` | Badge + lazy sparkline mount |
| `frontend/js/node_drawer.js` | Optional: reuse buckets for full-width chart |
| `frontend/css/node_cards.css` | Badge colours, sparkline slot |

### Lazy load

Use `IntersectionObserver` on each card — fetch buckets only when card enters viewport. Cards off-screen show badge only (from last-known rolling average in list payload if cheap, else neutral grey).

### Health badge logic

- Rolling **1-hour** average RSSI from buckets
- ≥ `green_rssi_floor` → Green; ≥ `yellow_rssi_floor` → Yellow; else Red
- Hide badge when packet count in last hour `< min_packets_per_hour`

### How to test

```text
1. Node with 72h continuous traffic — sparkline shape sane
2. 15-min bucket counts match SQL spot checks
3. Threshold edits in local.yaml → badge colour changes after refresh
4. Pass-through node (<5 pkts/hr) → no badge
5. 30-min beacon node → dashed gap between buckets in sparkline
6. Desktop + 375px drawer width
```

### PR body checklist

- [ ] Extends existing `metrics_history` (document new fields)
- [ ] Lazy-load documented
- [ ] Optional config with safe defaults
- [ ] No schema changes
- [ ] Unit tests for bucket aggregation

---

## PR 4 of 4 — Smart Relay Filter Controls

| Field | Value |
|-------|-------|
| **Branch** | `feat/relay-filter-controls` |
| **Base** | `main` |
| **Type** | Frontend + relay module + config |
| **Risk** | **Medium** (high-review per CONTRIBUTING) |
| **Touches relay** | **Yes** |

### Title

```
feat(relay): operator blocklist, priority list, and dedup TTL controls
```

### Summary

Expose three relay tuning parameters in the dashboard: **node blocklist**, **priority list**, and **deduplication TTL**. Extends existing `RelayConfig` and `PUT /api/config/relay` — no parallel `POST /api/relay/config` route.

### Motivation

`RelayManager.evaluate()` already filters by dedup, rate limit, hops, type, and RSSI window. Operators cannot suppress a noisy node without SSH. Remote rooftop nodes need dashboard control consistent with Meshpoint’s no-SSH operations goal.

### Correcting the draft spec

| Draft claim | Actual codebase |
|-------------|-----------------|
| Duplicate window default 30 s | `DeduplicationFilter(ttl_seconds=300.0)` — **5 minutes** |
| `relay_priority_list` skips “TX queue delay” | `RateLimiter` is a global sliding window + burst cap — priority means **bypass burst gate**, not bypass duty cycle |
| New `RelayPanel.js` tab | Add **`RelayFiltersCard`** under `frontend/js/configuration/` and mount from `configuration_panel.js` (or extend `advanced_card.js`) |
| `src/relay.py` | `src/relay/relay_manager.py`, `dedup_filter.py`, `rate_limiter.py` |

### Config additions (`RelayConfig` in `src/config.py`)

```yaml
relay:
  enabled: true
  # existing keys unchanged ...
  blocklist: []              # node_id strings, e.g. ["a3f2b1c0"]
  priority_list: []          # node_id strings relayed before burst throttle
  dedup_ttl_seconds: 300     # default 300 to preserve current behaviour
```

All optional — empty/absent = today’s behaviour.

### Relay logic (`src/relay/relay_manager.py`)

Insert checks in `evaluate()` **before** expensive work:

```python
# 1. Blocklist (earliest)
if packet.source_id in self._blocklist:
    return RelayDecision(False, "blocklisted")

# 2. Existing dedup (ttl now configurable)
if self._dedup.is_duplicate(packet.source_id, packet.packet_id):
    return RelayDecision(False, "duplicate")

# ... existing hop/type/RSSI checks ...

# 3. Priority: pass flag into rate limiter
if packet.source_id in self._priority_list:
    if self._limiter.allow_priority():
        return RelayDecision(True, "approved_priority")
# else normal limiter.allow()
```

### Rate limiter change (`rate_limiter.py`)

Add `allow_priority()` that enforces `_max_per_minute` but **skips burst_size** check — still respects per-minute cap and duty cycle at transmit layer.

### Hot reload

- On `PUT /api/config/relay`, after `save_section_to_yaml`, call `relay_manager.reload_filters(blocklist, priority_list, dedup_ttl)` — **no full service restart**
- `PipelineCoordinator` holds `relay_manager` — pass reload hook from `system_config_routes` init (same pattern as other config routes closing over coordinator)

### API changes (`src/api/routes/system_config_routes.py`)

Extend existing `RelaySettingsUpdate` model:

```python
blocklist: Optional[list[str]] = None
priority_list: Optional[list[str]] = None
dedup_ttl_seconds: Optional[int] = Field(None, ge=5, le=3600)
```

Validate node IDs: `^[0-9a-f]{8}$` (Meshtastic 4-byte hex **without** `!` prefix) — match how `Packet.source_id` is stored in DB.

Extend `config_enrichment.py` relay section for GET `/api/config`.

### Frontend (`relay_filters_card.js`)

| Control | Behaviour |
|---------|-------------|
| Blocklist | Dynamic list, add/remove, confirm on save |
| Priority list | Same |
| Dedup TTL | Number input, default 300, hint “current default 300 s” |

Copy note in UI: **“Blocklist affects relay only — packets still appear in the live feed.”**

### Out of scope (explicit)

- Per-channel duty throttle slider
- Meshradar sync of blocklist
- Native TX / concentrator changes

### How to test

```text
Hardware: RAK7248, US915, relay enabled (SX1262 USB or native path)

Blocklist:
1. Add test node ID via UI
2. Log shows relay rejected reason blocklisted
3. Packet still visible in live feed
4. Remove → relay resumes

Priority:
1. Two nodes TX under congestion
2. Priority node’s relay attempts appear sooner (log ordering)

Dedup TTL:
1. Set 10 s → fast re-relay possible
2. Set 600 s → suppression window widens
3. Omit key → 300 s default unchanged

Persistence:
1. Save → local.yaml valid
2. systemctl restart meshpoint → values persist
```

### PR body checklist

- [ ] Optional keys — default behaviour identical to main
- [ ] Node ID validation server-side
- [ ] Blocklist relay-only (documented in UI)
- [ ] Dedup default documented as **300 s** (not 30 s)
- [ ] Priority does not bypass per-minute limit or duty cycle
- [ ] Relay module called out for extra review
- [ ] Unit tests: `evaluate()` blocklist, priority burst bypass, ttl reload

---

## Suggested submission order

| Order | PR | Reviewer effort |
|-------|-----|----------------|
| 1 | Packet detail modal | Low — frontend only |
| 2 | 24h traffic histogram | Low — one SQL route |
| 3 | Signal health sparklines | Low–medium — SQL + lazy UI |
| 4 | Relay filter controls | **High** — relay module |

**None of these PRs modify the same files** if you land them sequentially on `main` and rebase each follow-up branch before opening the next PR.

---

## Issue ↔ PR mapping

| GitHub issue section | PR |
|----------------------|-----|
| §2 Deep Packet Inspection Modal | PR 1 |
| §4 24-Hour Traffic Histograms | PR 2 |
| §3 Signal Health | PR 3 |
| §5 Smart Relay Controls (blocklist/priority/window only) | PR 4 |
| §1 Visual Topology Graph | **Future issue** (not in this suite) |
| §6 REST API | **Future issue** (not in this suite) |

---

## Operator test environment (reference)

Use consistently across all four PRs:

| Item | Value |
|------|-------|
| Hardware | RAK Hotspot V2 (RAK7248) or Pi 4 + RAK2287/5146 Pi HAT |
| Region | US915 primary; EU868 re-test for PR 2 duty line |
| OS | Raspberry Pi OS 64-bit Bookworm |
| Meshpoint | Current `main` at branch time |
| Load | ~8k–12k packets/day backbone profile |

---

## Next step for you

1. Review this doc — flag anything you want scoped differently (especially PR 1 duplicate-RF deferral and PR 4 dedup default 300 s).
2. Open the GitHub issue on `KMX415/meshpoint`.
3. Say **“start PR 1”** when ready — implementation branches from `main` only.
