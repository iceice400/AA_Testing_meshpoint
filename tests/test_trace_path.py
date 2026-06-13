"""Tests for Meshtastic traceroute path reconstruction."""

from __future__ import annotations

import unittest

from src.analytics.trace_path import build_trace_path, trace_path_edges


class TestTracePath(unittest.TestCase):
    def test_empty_route_probe_yields_direct_hop(self) -> None:
        path = build_trace_path("f6acb04f", "49b7a980", [])
        self.assertEqual(path, ["f6acb04f", "49b7a980"])
        self.assertEqual(
            trace_path_edges(path),
            [("f6acb04f", "49b7a980")],
        )

    def test_relay_hops_chain_source_and_destination(self) -> None:
        path = build_trace_path(
            "7d8b98a9",
            "c0ffee42",
            ["11223344", "55667788"],
        )
        self.assertEqual(
            path,
            ["7d8b98a9", "11223344", "55667788", "c0ffee42"],
        )
        self.assertEqual(len(trace_path_edges(path)), 3)

    def test_ignores_broadcast_destination(self) -> None:
        path = build_trace_path("aabbccdd", "ffffffff", [])
        self.assertEqual(path, ["aabbccdd"])

    def test_full_path_in_route_still_works(self) -> None:
        path = build_trace_path(
            "aabbccdd",
            "ffffffff",
            ["aabbccdd", "11223344", "deadbeef"],
        )
        self.assertEqual(path, ["aabbccdd", "11223344", "deadbeef"])


if __name__ == "__main__":
    unittest.main()
