"""Tests for topology position-request validation."""
from __future__ import annotations

import unittest

from src.relay.node_id import is_valid_meshtastic_node_id, normalize_node_id
from src.decode.crypto_service import CryptoService
from src.transmit.meshtastic_builder import MeshtasticPacketBuilder


class TestTopologyPositionNodeId(unittest.TestCase):
    def test_valid_meshtastic_id(self):
        self.assertTrue(is_valid_meshtastic_node_id("!abc12345"))
        self.assertEqual(normalize_node_id("!ABC12345"), "abc12345")

    def test_meshcore_pubkey_rejected(self):
        self.assertFalse(is_valid_meshtastic_node_id("a1b2c3d4e5f6"))

    def test_header_packs_oversized_dest_without_error(self):
        builder = MeshtasticPacketBuilder(CryptoService())
        header = builder._build_header(
            dest=int("a1b2c3d4e5f6", 16),
            source_id=0x12345678,
            packet_id=1,
        )
        self.assertEqual(len(header), 16)


if __name__ == "__main__":
    unittest.main()
