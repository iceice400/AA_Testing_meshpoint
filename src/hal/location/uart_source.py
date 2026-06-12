"""UART location source: direct on-board NMEA from the RAK Pi HAT GPS."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from src.hal.gps_reader import GpsReader
from src.hal.location.base import LocationSource
from src.hal.location.models import GpsDeviceInfo, GpsStatus, LocationFix

logger = logging.getLogger(__name__)


class UartSource(LocationSource):
    """Read NMEA from an on-board UART GPS module."""

    def __init__(
        self,
        uart_path: str = "/dev/ttyAMA0",
        uart_baud: int = 9600,
        min_fix_quality: int = 1,
    ) -> None:
        self._uart_path = uart_path
        self._reader = GpsReader(uart_path=uart_path, baud=uart_baud)
        self._min_fix_quality = min_fix_quality

    @property
    def source_name(self) -> str:
        return "uart"

    async def start(self) -> None:
        await self._reader.start()

    async def stop(self) -> None:
        await self._reader.stop()

    def get_status(self) -> GpsStatus:
        pos = self._reader.latest_position
        now = datetime.now(timezone.utc)
        if pos is None or pos.fix_quality < self._min_fix_quality:
            return GpsStatus(
                source="uart",
                available=True,
                fix=None,
                satellites=None,
                device=GpsDeviceInfo(
                    driver="uart-nmea",
                    path=self._uart_path,
                    model="on-board GPS",
                    subtype=None,
                ),
                last_update=now,
                error=(
                    None
                    if pos is None
                    else f"fix quality {pos.fix_quality} below minimum {self._min_fix_quality}"
                ),
            )

        mode = 3 if pos.fix_quality >= 2 else 2
        fix = LocationFix(
            mode=mode,
            mode_label="3D" if mode == 3 else "2D",
            latitude=pos.latitude,
            longitude=pos.longitude,
            altitude_m=pos.altitude,
            speed_mps=None,
            track_deg=None,
            time=pos.timestamp,
            epx_m=None,
            epy_m=None,
            epv_m=None,
            hdop=None,
            pdop=None,
            vdop=None,
        )
        return GpsStatus(
            source="uart",
            available=True,
            fix=fix,
            satellites=None,
            device=GpsDeviceInfo(
                driver="uart-nmea",
                path=self._reader._uart_path,
                model="on-board GPS",
                subtype=None,
            ),
            last_update=pos.timestamp,
            error=None,
        )
