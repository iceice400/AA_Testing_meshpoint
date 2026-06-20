"""Read-only concentrator / host hardware diagnostics."""

from __future__ import annotations

import logging
from typing import Callable, Optional

from fastapi import APIRouter

from src.api.services.hardware_snapshot import build_hardware_snapshot
from src.config import AppConfig
from src.hal.sx1302_wrapper import SX1302Wrapper

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/device", tags=["device"])

_config: AppConfig | None = None
_get_wrapper: Callable[[], Optional[SX1302Wrapper]] | None = None
_get_gps_status: Callable[[], dict] | None = None
_get_pps_status: Callable[[], dict] | None = None


def init_routes(
    config: AppConfig,
    get_wrapper: Callable[[], Optional[SX1302Wrapper]],
    *,
    get_gps_status: Callable[[], dict] | None = None,
    get_pps_status: Callable[[], dict] | None = None,
) -> None:
    global _config, _get_wrapper, _get_gps_status, _get_pps_status
    _config = config
    _get_wrapper = get_wrapper
    _get_gps_status = get_gps_status
    _get_pps_status = get_pps_status


def reset_routes() -> None:
    global _config, _get_wrapper, _get_gps_status, _get_pps_status
    _config = None
    _get_wrapper = None
    _get_gps_status = None
    _get_pps_status = None


@router.get("/hardware")
async def device_hardware() -> dict:
    if _config is None or _get_wrapper is None:
        return {"error": "routes not initialized"}

    gps_status = {}
    pps_status = {}
    if _get_gps_status is not None:
        try:
            gps_status = _get_gps_status() or {}
        except Exception:
            logger.debug("hardware: gps status unavailable", exc_info=True)
    if _get_pps_status is not None:
        try:
            pps_status = _get_pps_status() or {}
        except Exception:
            logger.debug("hardware: pps status unavailable", exc_info=True)

    wrapper = _get_wrapper()
    spectral = wrapper.spectral_scan_supported if wrapper else False

    return build_hardware_snapshot(
        _config,
        _get_wrapper,
        gps_status=gps_status,
        pps_status=pps_status,
        spectral_supported=spectral,
    )
