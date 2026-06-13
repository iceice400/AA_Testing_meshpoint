"""Topology-aware relay heuristics (suppression + listen-before-relay)."""

from __future__ import annotations

from src.analytics.topology_graph import BROADCAST_DESTS, TopologyGraph
from src.models.packet import Packet
from src.relay.node_id import normalize_node_id


def is_broadcast_packet(packet: Packet) -> bool:
    dest = (packet.destination_id or "").lower()
    return dest in BROADCAST_DESTS


def should_suppress_broadcast(
    graph: TopologyGraph,
    packet: Packet,
    *,
    min_neighbors: int,
    overlap_percent: float,
    max_age_seconds: float,
) -> bool:
    """Skip base-station relay when the sender's local mesh looks redundant."""
    if not is_broadcast_packet(packet):
        return False

    overlap, neighbor_count = graph.broadcast_redundancy_ratio(
        packet.source_id,
        max_age_seconds=max_age_seconds,
    )
    if neighbor_count < min_neighbors:
        return False
    return overlap * 100.0 >= overlap_percent


def compute_listen_delay_ms(
    graph: TopologyGraph,
    packet: Packet,
    *,
    base_ms: int,
    max_ms: int,
    max_age_seconds: float,
) -> int:
    """Defer relay so nearby routers can repeat first."""
    if base_ms <= 0:
        return 0
    return graph.listen_window_ms(
        packet.source_id,
        base_ms=base_ms,
        max_ms=max(max_ms, base_ms),
        max_age_seconds=max_age_seconds,
    )


def is_priority_source(packet: Packet, priority_ids: set[str]) -> bool:
    source = normalize_node_id(packet.source_id)
    return bool(source and source in priority_ids)
