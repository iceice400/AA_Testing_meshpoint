"""Build a JSON snapshot of Meshpoint host + concentrator hardware."""

from __future__ import annotations

import logging
import os
from typing import Callable, Optional

from src.cli.hardware_detect import (
    CARRIER_SENSECAP_M1,
    detect_all,
)
from src.config import AppConfig
from src.hal.concentrator_identity import (
    chip_name,
    chip_status_label,
    module_hint,
    read_chip_version_from_journal,
)
from src.hal.sx1302_wrapper import SX1302Wrapper

logger = logging.getLogger(__name__)


def probe_chip_version(wrapper: Optional[SX1302Wrapper]) -> Optional[int]:
    if wrapper is None:
        return read_chip_version_from_journal()
    cached = wrapper.chip_version
    if cached is not None:
        return cached
    return read_chip_version_from_journal()


def build_hardware_snapshot(
    config: AppConfig,
    get_wrapper: Callable[[], Optional[SX1302Wrapper]],
    *,
    gps_status: Optional[dict] = None,
    pps_status: Optional[dict] = None,
    spectral_supported: Optional[bool] = None,
) -> dict:
    report = detect_all()
    wrapper = get_wrapper()
    chip_version = probe_chip_version(wrapper)

    capture_sources = list(getattr(config.capture, "sources", []) or [])
    concentrator_enabled = "concentrator" in capture_sources
    running = bool(wrapper and wrapper.started)

    rx_stats = {}
    if wrapper is not None:
        rx_stats = {
            "crc_bad_total": wrapper.crc_bad_count,
            "no_crc_total": wrapper.no_crc_count,
            "unknown_status_total": wrapper.unknown_status_count,
        }

    if spectral_supported is None and wrapper is not None:
        spectral_supported = wrapper.spectral_scan_supported

    gps = report.gps
    return {
        "platform": "raspberry_pi" if os.path.exists("/proc/device-tree/model") else "other",
        "hardware_description": config.device.hardware_description,
        "carrier_type": report.carrier_type,
        "carrier_label": report.hardware_description,
        "spi_devices": report.spi_devices,
        "libloragw_installed": report.libloragw_installed,
        "libloragw_path": wrapper.lib_path if wrapper else _libloragw_path(),
        "concentrator": {
            "enabled": concentrator_enabled,
            "running": running,
            "spi_path": (
                wrapper.spi_path
                if wrapper
                else getattr(config.capture, "concentrator_spi_device", "/dev/spidev0.0")
            ),
            "chip_version": chip_version,
            "chip_version_hex": (
                f"0x{chip_version:02x}" if chip_version is not None else None
            ),
            "chip_name": chip_name(chip_version),
            "module_hint": module_hint(chip_version, report.carrier_type),
            "status": chip_status_label(chip_version),
            "spectral_scan_supported": bool(spectral_supported),
            "rx_stats": rx_stats,
        },
        "gps_probe": {
            "uart_path": gps.uart_path,
            "uart_present": gps.available,
            "has_fix": gps.got_fix,
            "latitude": gps.latitude,
            "longitude": gps.longitude,
            "satellites": gps.satellites,
        },
        "gps_runtime": gps_status or {},
        "pps_runtime": pps_status or {},
        "serial_ports": report.serial_ports,
        "meshcore_usb_candidates": report.meshcore_usb_candidates,
        "capture_sources": capture_sources,
        "is_sensecap": report.carrier_type == CARRIER_SENSECAP_M1,
    }


def _libloragw_path() -> Optional[str]:
    for path in (
        "/usr/local/lib/libloragw.so",
        "/usr/lib/libloragw.so",
        "./libloragw.so",
    ):
        if os.path.exists(path):
            return path
    return None
