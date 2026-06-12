"""GPS reader for the ZOE-M8Q module on the RAK2287/5146 Pi HAT.

The u-blox speaks NMEA on the Pi UART (typically ``/dev/ttyAMA0`` after
``install.sh`` frees the primary serial port from Bluetooth). This is
separate from the SX1302/SX1303 concentrator SPI link — the "on-board GPS"
is a distinct chip wired to GPIO TX/RX, not exposed over the LoRa HAL.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class GpsPosition:
    latitude: float
    longitude: float
    altitude: float
    satellites: int
    fix_quality: int
    timestamp: datetime


class GpsReader:
    """Reads NMEA GGA sentences from an on-board UART GPS module."""

    def __init__(self, uart_path: str = "/dev/ttyAMA0", baud: int = 9600):
        self._uart_path = uart_path
        self._baud = baud
        self._running = False
        self._latest: Optional[GpsPosition] = None
        self._task: Optional[asyncio.Task] = None

    @property
    def latest_position(self) -> Optional[GpsPosition]:
        return self._latest

    @property
    def has_fix(self) -> bool:
        return self._latest is not None and self._latest.fix_quality > 0

    async def start(self) -> None:
        self._running = True
        self._task = asyncio.create_task(
            self._read_loop(), name="gps-reader"
        )
        logger.info("GPS reader started on %s @ %d baud", self._uart_path, self._baud)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("GPS reader stopped")

    async def _read_loop(self) -> None:
        """Read NMEA sentences from the GPS UART via pyserial."""
        try:
            import serial
        except ImportError:
            logger.warning(
                "pyserial not installed — GPS UART at %s unavailable",
                self._uart_path,
            )
            while self._running:
                await asyncio.sleep(10)
            return

        ser = None
        try:
            ser = serial.Serial(self._uart_path, self._baud, timeout=2)
            logger.info("GPS serial open on %s", self._uart_path)
            while self._running:
                line = await asyncio.to_thread(ser.readline)
                sentence = line.decode("ascii", errors="ignore").strip()
                if sentence:
                    self._parse_nmea(sentence)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.warning(
                "GPS UART not available at %s @ %d baud — %s",
                self._uart_path,
                self._baud,
                exc,
            )
            while self._running:
                await asyncio.sleep(10)
        finally:
            if ser is not None and ser.is_open:
                ser.close()

    def _parse_nmea(self, sentence: str) -> None:
        """Parse GGA sentences for position data."""
        if not sentence.startswith("$GPGGA") and not sentence.startswith("$GNGGA"):
            return

        try:
            parts = sentence.split(",")
            if len(parts) < 10:
                return

            fix_quality = int(parts[6]) if parts[6] else 0
            if fix_quality == 0:
                return

            lat = self._nmea_to_decimal(parts[2], parts[3])
            lon = self._nmea_to_decimal(parts[4], parts[5])
            alt = float(parts[9]) if parts[9] else 0.0
            sats = int(parts[7]) if parts[7] else 0

            self._latest = GpsPosition(
                latitude=lat,
                longitude=lon,
                altitude=alt,
                satellites=sats,
                fix_quality=fix_quality,
                timestamp=datetime.now(timezone.utc),
            )
        except (ValueError, IndexError):
            pass

    @staticmethod
    def _nmea_to_decimal(coord: str, direction: str) -> float:
        """Convert NMEA coordinate (ddmm.mmmm) to decimal degrees."""
        if not coord:
            return 0.0
        dot_pos = coord.index(".")
        degrees = float(coord[: dot_pos - 2])
        minutes = float(coord[dot_pos - 2 :])
        result = degrees + minutes / 60.0
        if direction in ("S", "W"):
            result = -result
        return round(result, 7)
