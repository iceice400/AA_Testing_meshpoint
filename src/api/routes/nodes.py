from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException

from src.analytics.network_mapper import NetworkMapper
from src.storage.node_repository import NodeRepository
from src.storage.packet_repository import PacketRepository
from src.storage.telemetry_repository import TelemetryRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/nodes", tags=["nodes"])

_node_repo: NodeRepository | None = None
_network_mapper: NetworkMapper | None = None
_packet_repo: PacketRepository | None = None
_telemetry_repo: TelemetryRepository | None = None


def init_routes(
    node_repo: NodeRepository,
    network_mapper: NetworkMapper,
    packet_repo: PacketRepository | None = None,
    telemetry_repo: TelemetryRepository | None = None,
) -> None:
    global _node_repo, _network_mapper, _packet_repo, _telemetry_repo
    _node_repo = node_repo
    _network_mapper = network_mapper
    _packet_repo = packet_repo
    _telemetry_repo = telemetry_repo


@router.get("")
async def list_nodes(limit: int = 500, enrich: bool = True):
    if enrich:
        try:
            return await _node_repo.get_all_with_signal(limit)
        except Exception as exc:
            logger.exception("Enriched nodes query failed; falling back to basic list")
            nodes = await _node_repo.get_all(limit)
            return [n.to_dict() for n in nodes]
    return [n.to_dict() for n in await _node_repo.get_all(limit)]


@router.get("/count")
async def node_count():
    count = await _node_repo.get_count()
    active = await _node_repo.get_active_count()
    return {"count": count, "active": active}


@router.get("/map")
async def map_data():
    return await _network_mapper.get_map_data()


@router.get("/coverage")
async def node_coverage(hours: float = 168):
    """GPS-plotted nodes with RSSI aggregates for the coverage map layer."""
    if _packet_repo is None or _node_repo is None:
        raise HTTPException(status_code=503, detail="Coverage not available")

    since = (
        datetime.now(timezone.utc) - timedelta(hours=hours)
    ).isoformat()
    rows = await _packet_repo.get_coverage_aggregates(since)
    total_nodes = await _node_repo.get_count()
    plotted = []
    for row in rows:
        avg_rssi = row.get("avg_rssi")
        best_rssi = row.get("best_rssi")
        packet_count = int(row.get("packet_count") or 0)
        plotted.append({
            "node_id": row["node_id"],
            "display_name": row.get("long_name") or row.get("short_name") or row["node_id"],
            "protocol": row.get("protocol") or "meshtastic",
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "packet_count": packet_count,
            "avg_rssi": round(avg_rssi, 1) if avg_rssi is not None else None,
            "best_rssi": round(best_rssi, 1) if best_rssi is not None else None,
            "quality": _coverage_quality(avg_rssi, packet_count),
        })

    return {
        "hours": hours,
        "plotted": plotted,
        "plotted_count": len(plotted),
        "unplotted_count": max(0, total_nodes - len(plotted)),
        "total_nodes": total_nodes,
    }


def _coverage_quality(avg_rssi: float | None, packet_count: int) -> str:
    if packet_count < 1 or avg_rssi is None:
        return "unknown"
    if avg_rssi >= -90:
        return "excellent"
    if avg_rssi >= -105:
        return "good"
    if avg_rssi >= -115:
        return "fair"
    return "poor"


@router.get("/summary")
async def network_summary():
    return await _network_mapper.get_network_summary()


@router.get("/{node_id}/metrics_history")
async def metrics_history(
    node_id: str,
    limit: int = 300,
    hours: float | None = 168,
    bucket_minutes: int | None = None,
):
    """Telemetry rows + RSSI samples for node drawer time-series charts."""
    if _packet_repo is None or _telemetry_repo is None:
        raise HTTPException(status_code=503, detail="Metrics not available")

    node = await _node_repo.get_by_id(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    telemetry = await _telemetry_repo.get_history(node_id, limit, hours)
    signal = await _packet_repo.get_signal_history(node_id, limit, hours)
    payload = {
        "node_id": node_id,
        "telemetry": [t.to_dict() for t in telemetry],
        "signal": signal,
    }
    if bucket_minutes is not None and bucket_minutes > 0:
        payload["signal_buckets"] = await _packet_repo.get_signal_buckets(
            node_id,
            hours=hours or 24,
            bucket_minutes=bucket_minutes,
        )
    return payload


@router.get("/{node_id}")
async def get_node(node_id: str):
    node = await _node_repo.get_by_id(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node.to_dict()
