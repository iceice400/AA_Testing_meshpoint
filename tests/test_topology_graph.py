"""Tests for in-memory topology graph used by topology-aware relay."""

from __future__ import annotations

import time
import unittest

from src.analytics.topology_graph import TopologyGraph
from src.models.packet import Packet, PacketType, Protocol


class TestTopologyGraph(unittest.TestCase):
    def test_neighborinfo_builds_edges(self) -> None:
        graph = TopologyGraph()
        packet = Packet(
            packet_id="01",
            source_id="aabbccdd",
            destination_id="ffffffff",
            protocol=Protocol.MESHTASTIC,
            packet_type=PacketType.NEIGHBORINFO,
            decoded_payload={
                "neighbors": [
                    {"node_id": "11223344"},
                    {"node_id": "55667788"},
                ],
            },
        )
        graph.observe_packet(packet)
        neighbors = graph.active_neighbors("aabbccdd", max_age_seconds=3600)
        self.assertEqual(neighbors, {"11223344", "55667788"})
        self.assertEqual(graph.snapshot_stats()["edge_count"], 2)

    def test_traceroute_builds_path_edges(self) -> None:
        graph = TopologyGraph()
        packet = Packet(
            packet_id="02",
            source_id="aabbccdd",
            destination_id="ffffffff",
            protocol=Protocol.MESHTASTIC,
            packet_type=PacketType.TRACEROUTE,
            decoded_payload={"route": ["aabbccdd", "11223344", "deadbeef"]},
        )
        graph.observe_packet(packet)
        self.assertIn("11223344", graph.active_neighbors("aabbccdd"))
        self.assertIn("deadbeef", graph.active_neighbors("11223344"))

    def test_redundancy_ratio_requires_neighbors(self) -> None:
        graph = TopologyGraph()
        now = time.monotonic()
        graph.add_edge("aaaa0001", "bbbb0002", now=now)
        overlap, count = graph.broadcast_redundancy_ratio(
            "aaaa0001",
            max_age_seconds=3600,
        )
        self.assertEqual(count, 1)
        self.assertEqual(overlap, 0.0)

    def test_listen_window_scales_with_neighbors(self) -> None:
        graph = TopologyGraph()
        now = time.monotonic()
        graph.add_edge("aaaa0001", "bbbb0002", now=now)
        graph.add_edge("aaaa0001", "cccc0003", now=now)
        graph.observe_node("dddd0004", now=now)
        short = graph.listen_window_ms(
            "aaaa0001",
            base_ms=100,
            max_ms=400,
            max_age_seconds=3600,
        )
        self.assertGreater(short, 100)
        self.assertLessEqual(short, 400)


if __name__ == "__main__":
    unittest.main()
