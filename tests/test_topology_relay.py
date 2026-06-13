"""Tests for topology-aware relay decisions."""

from __future__ import annotations

import asyncio
import time
import unittest
from unittest.mock import AsyncMock

from src.analytics.topology_graph import TopologyGraph
from src.config import TopologyRelayConfig
from src.models.packet import Packet, PacketType, Protocol
from src.models.signal import SignalMetrics
from src.relay.relay_manager import RelayManager
from src.relay.topology_relay import should_suppress_broadcast


def _packet(
    *,
    source_id: str = "aabbccdd",
    packet_id: str = "aa",
    destination_id: str = "ffffffff",
) -> Packet:
    return Packet(
        packet_id=packet_id,
        source_id=source_id,
        destination_id=destination_id,
        protocol=Protocol.MESHTASTIC,
        packet_type=PacketType.TEXT,
        hop_limit=3,
        signal=SignalMetrics(
            rssi=-80.0,
            snr=8.0,
            frequency_mhz=906.875,
            spreading_factor=11,
            bandwidth_khz=250.0,
        ),
    )


class TestTopologyRelayHeuristics(unittest.TestCase):
    def test_suppresses_redundant_broadcast(self) -> None:
        graph = TopologyGraph()
        now = time.monotonic()
        graph.add_edge("aabbccdd", "11111111", now=now)
        graph.add_edge("aabbccdd", "22222222", now=now)
        graph.observe_node("33333333", now=now)
        graph.observe_node("44444444", now=now)

        packet = _packet()
        self.assertTrue(
            should_suppress_broadcast(
                graph,
                packet,
                min_neighbors=2,
                overlap_percent=40.0,
                max_age_seconds=3600,
            )
        )

    def test_skips_unicast_suppression(self) -> None:
        graph = TopologyGraph()
        now = time.monotonic()
        graph.add_edge("aabbccdd", "11111111", now=now)
        graph.add_edge("aabbccdd", "22222222", now=now)
        packet = _packet(destination_id="deadbeef")
        self.assertFalse(
            should_suppress_broadcast(
                graph,
                packet,
                min_neighbors=2,
                overlap_percent=40.0,
                max_age_seconds=3600,
            )
        )


class TestRelayManagerTopology(unittest.IsolatedAsyncioTestCase):
    async def test_topology_redundant_rejection(self) -> None:
        graph = TopologyGraph()
        now = time.monotonic()
        graph.add_edge("aabbccdd", "11111111", now=now)
        graph.add_edge("aabbccdd", "22222222", now=now)
        graph.observe_node("33333333", now=now)

        manager = RelayManager(
            enabled=True,
            topology_graph=graph,
            topology_relay=TopologyRelayConfig(
                enabled=True,
                suppression_enabled=True,
                suppression_min_neighbors=2,
                suppression_overlap_percent=40.0,
            ),
        )
        decision = manager.evaluate(_packet())
        self.assertFalse(decision.should_relay)
        self.assertEqual(decision.reason, "topology_redundant")

    async def test_listen_before_relay_cancels_on_duplicate(self) -> None:
        graph = TopologyGraph()
        manager = RelayManager(
            enabled=True,
            topology_graph=graph,
            topology_relay=TopologyRelayConfig(
                enabled=True,
                listen_window_ms=200,
                listen_window_max_ms=200,
            ),
        )
        tx = AsyncMock()
        manager.set_transmit_function(tx)

        first = _packet(packet_id="dup01")
        second = _packet(packet_id="dup01")

        await manager.process_packet(first)
        await manager.process_packet(second)

        await asyncio.sleep(0.25)
        tx.assert_not_awaited()
        stats = manager.get_stats()
        self.assertEqual(stats["deferred_cancelled"], 1)
        self.assertEqual(stats["relayed"], 0)

    async def test_listen_before_relay_transmits_when_no_duplicate(self) -> None:
        graph = TopologyGraph()
        manager = RelayManager(
            enabled=True,
            topology_graph=graph,
            topology_relay=TopologyRelayConfig(
                enabled=True,
                listen_window_ms=50,
                listen_window_max_ms=50,
            ),
        )
        tx = AsyncMock()
        manager.set_transmit_function(tx)

        await manager.process_packet(_packet(packet_id="solo01"))
        await asyncio.sleep(0.08)
        tx.assert_awaited_once()
        self.assertEqual(manager.get_stats()["relayed"], 1)

    async def test_priority_bypasses_topology_suppression(self) -> None:
        graph = TopologyGraph()
        now = time.monotonic()
        graph.add_edge("aabbccdd", "11111111", now=now)
        graph.add_edge("aabbccdd", "22222222", now=now)
        graph.observe_node("33333333", now=now)

        manager = RelayManager(
            enabled=True,
            priority_list=["aabbccdd"],
            topology_graph=graph,
            topology_relay=TopologyRelayConfig(
                enabled=True,
                suppression_enabled=True,
                suppression_min_neighbors=2,
                suppression_overlap_percent=40.0,
            ),
        )
        decision = manager.evaluate(_packet(source_id="aabbccdd"))
        self.assertTrue(decision.should_relay)
        self.assertEqual(decision.reason, "approved_priority")


if __name__ == "__main__":
    unittest.main()
