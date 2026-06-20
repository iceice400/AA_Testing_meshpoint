"""Concentrator chip identity helpers (SX1302 / SX1303)."""

from __future__ import annotations

import os
import re
import subprocess
from typing import Optional

# Semtech HAL log lines: "concentrator chip version is 0xNN"
CHIP_VERSION_SX1302 = 0x10
CHIP_VERSION_SX1303 = 0x12

_JOURNAL_CHIP_RE = re.compile(
    r"chip version is 0x([0-9A-Fa-f]{2})",
    re.IGNORECASE,
)

_CHIP_NAMES: dict[int, str] = {
    CHIP_VERSION_SX1302: "SX1302",
    CHIP_VERSION_SX1303: "SX1303",
}

_MODULE_HINTS: dict[int, str] = {
    CHIP_VERSION_SX1302: "RAK2287 / RAK7248 (Hotspot V2)",
    CHIP_VERSION_SX1303: "RAK5146 / WM1303 (SenseCap M1)",
}


def read_chip_version_from_journal(
    unit: str = "meshpoint",
) -> Optional[int]:
    """Best-effort parse of the last HAL chip-version line from journald."""
    if os.name != "posix":
        return None
    try:
        result = subprocess.run(
            ["journalctl", "-u", unit, "--no-pager", "-o", "cat", "-n", "4000"],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
        if result.returncode != 0:
            return None
        for line in reversed(result.stdout.splitlines()):
            match = _JOURNAL_CHIP_RE.search(line)
            if match:
                return int(match.group(1), 16)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None


def chip_name(version: Optional[int]) -> Optional[str]:
    if version is None:
        return None
    return _CHIP_NAMES.get(version)


def module_hint(version: Optional[int], carrier_type: str = "") -> Optional[str]:
    if version in _MODULE_HINTS:
        hint = _MODULE_HINTS[version]
        if carrier_type == "sensecap_m1" and version == CHIP_VERSION_SX1303:
            return "SenseCap M1 (WM1303 / SX1303)"
        if carrier_type == "rak" and version == CHIP_VERSION_SX1303:
            return "RAK5146 / RAK2287 Pi HAT (SX1303)"
        if carrier_type == "rak" and version == CHIP_VERSION_SX1302:
            return "RAK2287 / RAK7248 (SX1302)"
        return hint
    if version == 0:
        return "Concentrator not responding (check SPI seating and antenna)"
    return None


def chip_status_label(version: Optional[int]) -> str:
    if version is None:
        return "unknown"
    if version == 0:
        return "not_responding"
    if version in _CHIP_NAMES:
        return "ok"
    return "unrecognized"
