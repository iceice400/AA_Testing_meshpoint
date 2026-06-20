"""CLI: meshpoint hardware — show concentrator diagnostics."""

from __future__ import annotations

import json
import urllib.request

from src.cli.hardware_detect import detect_all, print_report


def show_hardware(*, json_output: bool = False) -> None:
    report = detect_all()
    if json_output:
        payload = {
            "spi_devices": report.spi_devices,
            "libloragw_installed": report.libloragw_installed,
            "concentrator_available": report.concentrator_available,
            "carrier_type": report.carrier_type,
            "hardware_description": report.hardware_description,
            "gps": {
                "available": report.gps.available,
                "uart_path": report.gps.uart_path,
                "got_fix": report.gps.got_fix,
            },
        }
        print(json.dumps(payload, indent=2))
        return

    print_report(report)

    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api/device/hardware")
        with urllib.request.urlopen(req, timeout=3) as resp:
            live = json.loads(resp.read().decode())
    except Exception:
        print("  Live API:        unavailable (service not running or auth required)")
        print()
        return

    conc = live.get("concentrator") or {}
    chip = conc.get("chip_name") or "unknown"
    hexv = conc.get("chip_version_hex") or "—"
    print("  Live service diagnostics")
    print("  " + "-" * 40)
    print(f"  Chip:            {chip} ({hexv})")
    print(f"  Module hint:     {conc.get('module_hint') or '—'}")
    print(f"  Running:         {'yes' if conc.get('running') else 'no'}")
    print(f"  SPI:             {conc.get('spi_path') or '—'}")
    hint = conc.get("module_hint")
    if hint:
        print(f"  Expected module: {hint}")
    print()
