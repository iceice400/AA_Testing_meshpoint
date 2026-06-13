"""Estimate positions for nodes without GPS using topology + mapped anchors."""

from __future__ import annotations

import math
from typing import Any


def _edge_key(a: str, b: str) -> str:
    return f"{min(a, b)}_{max(a, b)}"


def compute_topo_centroid_estimates(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    *,
    min_anchors: int = 2,
) -> list[dict[str, Any]]:
    """Place dark nodes at RSSI/SNR-weighted centroid of mapped neighbors."""
    by_id = {n["id"]: n for n in nodes if n.get("id")}
    mapped: dict[str, tuple[float, float]] = {}
    for nid, node in by_id.items():
        lat = node.get("latitude") or node.get("lat")
        lng = node.get("longitude") or node.get("lng")
        if lat is not None and lng is not None:
            mapped[nid] = (float(lat), float(lng))

    if not mapped:
        return []

    neighbor_weights: dict[str, dict[str, float]] = {}
    for edge in edges:
        a, b = edge.get("source"), edge.get("target")
        if not a or not b:
            continue
        weight = 1.0
        snr = edge.get("snr")
        rssi = edge.get("rssi")
        if snr is not None:
            weight = max(0.1, (float(snr) + 20.0) / 25.0)
        elif rssi is not None:
            weight = max(0.1, (float(rssi) + 140.0) / 50.0)

        if a in mapped and b not in mapped:
            neighbor_weights.setdefault(b, {})[a] = max(
                neighbor_weights.get(b, {}).get(a, 0.0), weight
            )
        if b in mapped and a not in mapped:
            neighbor_weights.setdefault(a, {})[b] = max(
                neighbor_weights.get(a, {}).get(b, 0.0), weight
            )

    estimates: list[dict[str, Any]] = []
    for dark_id, anchors in neighbor_weights.items():
        if dark_id in mapped or len(anchors) < min_anchors:
            continue
        total_w = sum(anchors.values())
        if total_w <= 0:
            continue
        lat = sum(mapped[aid][0] * w for aid, w in anchors.items()) / total_w
        lng = sum(mapped[aid][1] * w for aid, w in anchors.items()) / total_w
        spread_m = _max_anchor_distance_m(lat, lng, mapped, anchors)
        estimates.append({
            "id": dark_id,
            "lat": round(lat, 7),
            "lng": round(lng, 7),
            "radius_m": max(200.0, min(2500.0, spread_m * 1.5)),
            "method": "topo-centroid",
            "anchor_count": len(anchors),
            "confidence": min(1.0, len(anchors) / 4.0),
        })
    return estimates


def _max_anchor_distance_m(
    lat: float,
    lng: float,
    mapped: dict[str, tuple[float, float]],
    anchors: dict[str, float],
) -> float:
    m_per_deg = 111_320.0
    lat_rad = math.radians(lat)
    max_d = 0.0
    for aid in anchors:
        alat, alng = mapped[aid]
        dlat = (lat - alat) * m_per_deg
        dlng = (lng - alng) * m_per_deg * math.cos(lat_rad)
        max_d = max(max_d, math.hypot(dlat, dlng))
    return max_d
