"""Tests for firmware catalog."""
from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from src.firmware.catalog import (
    _match_asset_name,
    build_catalog_payload,
    get_board,
    load_catalog_config,
    revision_for_board,
)


class TestFirmwareCatalog(unittest.TestCase):
    def test_load_catalog_has_boards(self) -> None:
        cfg = load_catalog_config()
        self.assertIn("boards", cfg)
        self.assertGreaterEqual(len(cfg["boards"]), 3)

    def test_get_board_heltec_v3(self) -> None:
        cfg = load_catalog_config()
        board = get_board(cfg, "heltec_v3")
        self.assertIsNotNone(board)
        assert board is not None
        self.assertEqual(board.asset_prefix, "Heltec_v3_companion_radio_usb")
        self.assertEqual(board.partition_offset, "0x10000")

    def test_match_asset_prefers_merged(self) -> None:
        assets = [
            {"name": "Heltec_v3_companion_radio_usb-v1.0.bin"},
            {"name": "Heltec_v3_companion_radio_usb-v1.0-merged.bin"},
        ]
        hit = _match_asset_name(
            assets,
            "Heltec_v3_companion_radio_usb",
            prefer_merged=True,
            variant="companion_radio_usb",
        )
        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertIn("merged", hit["name"])

    def test_revision_warning_for_v4(self) -> None:
        cfg = load_catalog_config()
        rev = revision_for_board(cfg, "heltec_v4", "v4_2_v4_3")
        self.assertIsNotNone(rev)
        assert rev is not None
        self.assertTrue(rev.get("warning"))

    def test_build_catalog_payload_resolves_artifact(self) -> None:
        async def _run() -> dict:
            with patch(
                "src.firmware.catalog.fetch_github_release",
                new_callable=AsyncMock,
            ) as mock_fetch:
                mock_fetch.return_value = {
                    "tag_name": "companion-v1.16.0",
                    "assets": [
                        {
                            "name": "Heltec_v3_companion_radio_usb-v1.16.0-merged.bin",
                            "browser_download_url": "https://example.com/v3.bin",
                            "size": 1234,
                        },
                    ],
                }
                return await build_catalog_payload()

        payload = asyncio.run(_run())
        heltec = next(b for b in payload["boards"] if b["id"] == "heltec_v3")
        self.assertIsNotNone(heltec.get("artifact"))
        self.assertTrue(heltec["artifact"]["merged"])


if __name__ == "__main__":
    unittest.main()
