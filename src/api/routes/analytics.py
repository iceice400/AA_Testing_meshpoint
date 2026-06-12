from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Query

from src.analytics.signal_analyzer import SignalAnalyzer
from src.analytics.traffic_monitor import TrafficMonitor
from src.storage.node_repository import NodeRepository
from src.storage.packet_repository import PacketRepository

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

_signal_analyzer: SignalAnalyzer | None = None
_traffic_monitor: TrafficMonitor | None = None
_packet_repo: PacketRepository | None = None
_node_repo: NodeRepository | None = None


def init_routes(
    signal_analyzer: SignalAnalyzer,
    traffic_monitor: TrafficMonitor,
    packet_repo: PacketRepository | None = None,
    node_repo: NodeRepository | None = None,
) -> None:
    global _signal_analyzer, _traffic_monitor, _packet_repo, _node_repo
    _signal_analyzer = signal_analyzer
    _traffic_monitor = traffic_monitor
    _packet_repo = packet_repo
    _node_repo = node_repo


@router.get("/traffic")
async def traffic_summary():
    return await _traffic_monitor.get_traffic_summary()


@router.get("/traffic/timeline")
async def traffic_timeline(minutes: int = 60, bucket_minutes: int = 5):
    return await _traffic_monitor.get_recent_activity(minutes, bucket_minutes)


@router.get("/signal/rssi")
async def rssi_distribution():
    return await _signal_analyzer.get_rssi_distribution()


@router.get("/signal/snr")
async def snr_distribution():
    return await _signal_analyzer.get_snr_distribution()


@router.get("/signal/summary")
async def signal_summary():
    return await _signal_analyzer.get_signal_summary()


def _empty_topology() -> dict:
    return {
        "nodes": [],
        "edges": [],
        "routes": [],
        "edge_sources": [],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": {
            "neighborinfo_packets": 0,
            "traceroute_packets": 0,
            "routing_packets": 0,
        },
    }


def _edge_key(a: str, b: str) -> str:
    return f"{min(a, b)}_{max(a, b)}"


def _is_weak(rssi: float | None) -> bool:
    return rssi is not None and rssi < -110


@router.get("/topology")
async def network_topology(hours: int = Query(24, ge=1, le=168)):
    """Force-graph topology from NEIGHBORINFO, TRACEROUTE, and ROUTING packets."""
    if not _packet_repo:
        return _empty_topology()

    since = (
        datetime.now(timezone.utc) - timedelta(hours=hours)
    ).isoformat()
    rows = await _packet_repo.get_topology_packets(since)
    node_counts = await _packet_repo.get_node_packet_counts_since(since)

    name_by_id: dict[str, str] = {}
    if _node_repo:
        for node in await _node_repo.get_all():
            label = node.display_name or node.long_name or node.short_name
            if label:
                name_by_id[node.node_id] = label

    nodes: dict[str, dict] = {}
    for row in node_counts:
        node_id = row["source_id"]
        protocol = row.get("protocol") or "meshtastic"
        existing = nodes.get(node_id)
        count = int(row.get("packet_count") or 0)
        rssi = row.get("latest_rssi")
        if existing:
            existing["packet_count"] += count
            if rssi is not None and (
                existing.get("latest_rssi") is None
                or rssi > existing["latest_rssi"]
            ):
                existing["latest_rssi"] = rssi
        else:
            nodes[node_id] = {
                "id": node_id,
                "label": name_by_id.get(node_id) or f"!{node_id[-4:]}",
                "protocol": protocol,
                "packet_count": count,
                "latest_rssi": rssi,
            }

    edges: dict[str, dict] = {}
    routes: list[dict] = []
    edge_sources: set[str] = set()
    stats = {
        "neighborinfo_packets": 0,
        "traceroute_packets": 0,
        "routing_packets": 0,
    }

    for row in rows:
        packet_type = row.get("packet_type") or ""
        try:
            payload = json.loads(row["decoded_payload"])
        except (json.JSONDecodeError, TypeError):
            continue

        source = row["source_id"]
        rssi = row.get("rssi")
        snr = row.get("snr")

        if packet_type == "neighborinfo":
            stats["neighborinfo_packets"] += 1
            neighbors = payload.get("neighbors", [])
            if not isinstance(neighbors, list):
                continue
            for neighbor in neighbors:
                nid = neighbor.get("node_id") or neighbor.get("id")
                if not nid:
                    continue
                target = str(nid)
                key = _edge_key(source, target)
                if key not in edges:
                    edge_sources.add("neighborinfo")
                    edges[key] = {
                        "source": source,
                        "target": target,
                        "edge_type": "neighborinfo",
                        "rssi": rssi,
                        "snr": neighbor.get("snr") if neighbor.get("snr") is not None else snr,
                        "weak": _is_weak(rssi),
                        "last_seen": row["timestamp"],
                    }
            continue

        if packet_type == "traceroute":
            stats["traceroute_packets"] += 1
            route = payload.get("route") or []
            if not isinstance(route, list) or len(route) < 2:
                continue
            route_ids = [str(node_id) for node_id in route]
            routes.append({
                "source_id": source,
                "route": route_ids,
                "last_seen": row["timestamp"],
            })
            for idx in range(len(route_ids) - 1):
                a, b = route_ids[idx], route_ids[idx + 1]
                key = _edge_key(a, b)
                if key not in edges:
                    edge_sources.add("traceroute")
                    edges[key] = {
                        "source": a,
                        "target": b,
                        "edge_type": "traceroute",
                        "rssi": rssi,
                        "snr": snr,
                        "weak": _is_weak(rssi),
                        "last_seen": row["timestamp"],
                    }
            continue

        if packet_type == "routing":
            stats["routing_packets"] += 1
            for field in ("route_reply", "route_request"):
                route = payload.get(field)
                if not isinstance(route, list) or len(route) < 2:
                    continue
                route_ids = [str(node_id) for node_id in route]
                routes.append({
                    "source_id": source,
                    "route": route_ids,
                    "last_seen": row["timestamp"],
                    "kind": field,
                })
                for idx in range(len(route_ids) - 1):
                    a, b = route_ids[idx], route_ids[idx + 1]
                    key = _edge_key(a, b)
                    if key not in edges:
                        edge_sources.add("routing")
                        edges[key] = {
                            "source": a,
                            "target": b,
                            "edge_type": "routing",
                            "rssi": rssi,
                            "snr": snr,
                            "weak": _is_weak(rssi),
                            "last_seen": row["timestamp"],
                        }

    return {
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "routes": routes,
        "edge_sources": sorted(edge_sources),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
    }
