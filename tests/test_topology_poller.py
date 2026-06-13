"""Tests for active topology traceroute polling."""
from __future__ import annotations

import time
import unittest
from unittest.mock import AsyncMock, MagicMock

from src.analytics.topology_poller import FIRMWARE_TR_LIMIT_S, TopologyPoller


class TestTopologyPollerTraceNode(unittest.IsolatedAsyncioTestCase):
    async def test_trace_node_uses_firmware_spacing_not_poll_interval(self):
        send = AsyncMock(return_value=MagicMock(success=True))
        poller = TopologyPoller(
            enabled=True,
            poll_interval_minutes=15,
            send_traceroute=send,
        )
        poller._last_poll["abc12345"] = time.time() - 5

        result = await poller.trace_node("abc12345", force=False)

        self.assertTrue(result["skipped"])
        self.assertLessEqual(result["cooldown_remaining_s"], FIRMWARE_TR_LIMIT_S)
        send.assert_not_awaited()

    async def test_trace_node_force_bypasses_cooldown(self):
        send = AsyncMock(return_value=MagicMock(success=True))
        poller = TopologyPoller(
            enabled=True,
            poll_interval_minutes=15,
            send_traceroute=send,
        )
        poller._last_poll["abc12345"] = time.time()

        result = await poller.trace_node("abc12345", force=True)

        self.assertTrue(result["success"])
        send.assert_awaited_once_with("abc12345")

    async def test_trace_node_after_firmware_spacing_succeeds(self):
        send = AsyncMock(return_value=MagicMock(success=True))
        poller = TopologyPoller(
            enabled=True,
            poll_interval_minutes=15,
            send_traceroute=send,
        )
        poller._last_poll["abc12345"] = time.time() - (FIRMWARE_TR_LIMIT_S + 1)

        result = await poller.trace_node("abc12345", force=False)

        self.assertTrue(result["success"])
        send.assert_awaited_once_with("abc12345")


if __name__ == "__main__":
    unittest.main()
