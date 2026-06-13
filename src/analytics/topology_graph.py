"""In-memory mesh adjacency graph for topology-aware relay decisions."""

from __future__ import annotations

import time
from collections import defaultdict
from typing import TYPE_CHECKING

from src.models.packet import PacketType
from src.relay.node_id import normalize_node_id

if TYPE_CHECKING:
    from src.models.packet import Packet

BROADCAST_DESTS = frozenset({"ffffffff", "ffff", ""})


class TopologyGraph:
    """Undirected adjacency graph built from live NEIGHBORINFO / TRACEROUTE packets."""

    def __init__(self, *, max_edge_age_seconds: float = 86400.0) -> None:
        self._max_edge_age = max(60.0, float(max_edge_age_seconds))
        self._adj: dict[str, set[str]] = defaultdict(set)
        self._edge_ts: dict[tuple[str, str], float] = {}
        self._node_last_seen: dict[str, float] = {}

    @property
    def max_edge_age_seconds(self) -> float:
        return self._max_edge_age

    def _now(self) -> float:
        return time.monotonic()

    @staticmethod
    def _edge_key(a: str, b: str) -> tuple[str, str]:
        return (min(a, b), max(a, b))

    def add_edge(self, a: str, b: str, *, now: float | None = None) -> None:
        left = normalize_node_id(a)
        right = normalize_node_id(b)
        if not left or not right or left == right:
            return
        ts = self._now() if now is None else now
        self._adj[left].add(right)
        self._adj[right].add(left)
        self._edge_ts[self._edge_key(left, right)] = ts
        self._touch(left, ts)
        self._touch(right, ts)

    def _touch(self, node_id: str, ts: float) -> None:
        self._node_last_seen[node_id] = ts

    def observe_node(self, node_id: str, *, now: float | None = None) -> None:
        nid = normalize_node_id(node_id)
        if nid:
            self._touch(nid, self._now() if now is None else now)

    def observe_packet(self, packet: Packet) -> None:
        """Ingest topology hints from a decoded packet."""
        source = normalize_node_id(packet.source_id)
        if source:
            self.observe_node(source)

        payload = packet.decoded_payload
        if not payload:
            return

        if packet.packet_type == PacketType.NEIGHBORINFO:
            neighbors = payload.get("neighbors") or []
            if not isinstance(neighbors, list):
                return
            for neighbor in neighbors:
                if not isinstance(neighbor, dict):
                    continue
                target = neighbor.get("node_id") or neighbor.get("id")
                if target:
                    self.add_edge(source, str(target))
            return

        if packet.packet_type == PacketType.TRACEROUTE:
            self._ingest_route(payload.get("route"))
            return

        if packet.packet_type == PacketType.ROUTING:
            for field in ("route_reply", "route_request"):
                self._ingest_route(payload.get(field))

    def _ingest_route(self, route: object) -> None:
        if not isinstance(route, list) or len(route) < 2:
            return
        ids = [normalize_node_id(str(node_id)) for node_id in route]
        ids = [node_id for node_id in ids if node_id]
        for idx in range(len(ids) - 1):
            self.add_edge(ids[idx], ids[idx + 1])

    def active_neighbors(
        self,
        node_id: str,
        *,
        max_age_seconds: float | None = None,
    ) -> set[str]:
        """Return neighbors with a recent edge to *node_id*."""
        nid = normalize_node_id(node_id)
        if not nid:
            return set()

        max_age = self._max_edge_age if max_age_seconds is None else max_age_seconds
        cutoff = self._now() - max_age
        peers: set[str] = set()
        for peer in self._adj.get(nid, ()):
            if self._edge_ts.get(self._edge_key(nid, peer), 0.0) >= cutoff:
                peers.add(peer)
        return peers

    def broadcast_redundancy_ratio(
        self,
        source_id: str,
        *,
        max_age_seconds: float,
    ) -> tuple[float, int]:
        """Return ``(overlap_ratio, neighbor_count)`` for suppression heuristics."""
        source = normalize_node_id(source_id)
        if not source:
            return 0.0, 0

        neighbors = self.active_neighbors(source, max_age_seconds=max_age_seconds)
        neighbor_count = len(neighbors)
        if neighbor_count < 2:
            return 0.0, neighbor_count

        cutoff = self._now() - max_age_seconds
        active_cluster = {
            node_id
            for node_id, seen_at in self._node_last_seen.items()
            if seen_at >= cutoff and node_id != source
        }
        if not active_cluster:
            return 0.0, neighbor_count

        overlap = len(neighbors & active_cluster) / len(active_cluster)
        return overlap, neighbor_count

    def listen_window_ms(
        self,
        source_id: str,
        *,
        base_ms: int,
        max_ms: int,
        max_age_seconds: float,
    ) -> int:
        """Scale deferral by local mesh redundancy (more neighbors → longer wait)."""
        if base_ms <= 0:
            return 0
        _, neighbor_count = self.broadcast_redundancy_ratio(
            source_id,
            max_age_seconds=max_age_seconds,
        )
        extra = min(max(0, max_ms - base_ms), neighbor_count * 25)
        return min(max_ms, base_ms + extra)

    def snapshot_stats(self) -> dict[str, int]:
        return {
            "node_count": len(self._node_last_seen),
            "edge_count": len(self._edge_ts),
        }
