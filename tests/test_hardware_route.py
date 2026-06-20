"""Tests for GET /api/device/hardware."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.routes import hardware_routes
from src.config import AppConfig


class TestHardwareRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()
        self.app.include_router(hardware_routes.router)
        self.config = AppConfig()
        self.config.device.hardware_description = "RAK5146 (SX1303) test rig"
        self.wrapper = MagicMock()
        self.wrapper.started = True
        self.wrapper.chip_version = 0x12
        self.wrapper.spi_path = "/dev/spidev0.0"
        self.wrapper.lib_path = "/usr/local/lib/libloragw.so"
        self.wrapper.crc_bad_count = 2
        self.wrapper.no_crc_count = 1
        self.wrapper.unknown_status_count = 0
        self.wrapper.spectral_scan_supported = False
        hardware_routes.init_routes(
            config=self.config,
            get_wrapper=lambda: self.wrapper,
            get_gps_status=lambda: {"source": "static", "fix_mode": "static"},
            get_pps_status=lambda: {"enabled": False},
        )
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        hardware_routes.reset_routes()

    def test_hardware_endpoint_returns_concentrator_chip(self) -> None:
        res = self.client.get("/api/device/hardware")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        conc = body["concentrator"]
        self.assertEqual(conc["chip_name"], "SX1303")
        self.assertEqual(conc["chip_version_hex"], "0x12")
        self.assertTrue(conc["running"])
        self.assertIn("RAK5146", conc["module_hint"] or "")
        self.assertEqual(body["hardware_description"], "RAK5146 (SX1303) test rig")
        self.assertEqual(conc["rx_stats"]["crc_bad_total"], 2)


class TestConcentratorIdentity(unittest.TestCase):
    def test_chip_name_mapping(self) -> None:
        from src.hal.concentrator_identity import (
            chip_name,
            concentrator_source_label,
            module_hint,
            relay_backend_label,
        )

        self.assertEqual(chip_name(0x12), "SX1303")
        self.assertEqual(chip_name(0x10), "SX1302")
        self.assertIn("RAK5146", module_hint(0x12, "rak") or "")
        self.assertEqual(
            concentrator_source_label(0x12),
            "concentrator (8-ch SX1303)",
        )
        self.assertEqual(relay_backend_label(0x12), "native onboard SX1303")


if __name__ == "__main__":
    unittest.main()
