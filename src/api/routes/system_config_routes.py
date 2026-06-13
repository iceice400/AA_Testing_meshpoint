"""Storage, capture, relay, and radio advanced settings."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from src.api.audit import AuditLogWriter
from src.api.audit.dependencies import get_audit_writer
from src.api.auth.dependencies import require_admin
from src.api.auth.jwt_session import SessionClaims
from src.config import AppConfig, save_section_to_yaml, _validate_gps_pps_config
from src.relay.channel_budget import normalize_channel_throttle
from src.relay.node_id import validate_node_ids
from src.relay.relay_manager import RelayManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/config", tags=["config"])

_config: AppConfig | None = None
_relay_manager: RelayManager | None = None


def init_routes(
    config: AppConfig,
    relay_manager: RelayManager | None = None,
) -> None:
    global _config, _relay_manager
    _config = config
    _relay_manager = relay_manager


def reset_routes() -> None:
    global _config, _relay_manager
    _config = None
    _relay_manager = None


class StorageUpdate(BaseModel):
    max_packets_retained: Optional[int] = Field(None, ge=1000, le=10_000_000)
    cleanup_interval_seconds: Optional[int] = Field(None, ge=60, le=86400)


class MeshcoreUsbUpdate(BaseModel):
    serial_port: Optional[str] = None
    baud_rate: Optional[int] = Field(None, ge=9600, le=921600)
    auto_detect: Optional[bool] = None
    enable_source: Optional[bool] = None


class StormGuardUpdate(BaseModel):
    enabled: Optional[bool] = None
    window_seconds: Optional[int] = Field(None, ge=10, le=600)
    identical_packet_threshold: Optional[int] = Field(None, ge=2, le=50)
    rate_threshold_per_minute: Optional[int] = Field(None, ge=5, le=600)
    quarantine_duration_seconds: Optional[int] = Field(None, ge=30, le=3600)
    notify_dashboard: Optional[bool] = None


class RelayUpdate(BaseModel):
    enabled: Optional[bool] = None
    serial_port: Optional[str] = None
    serial_baud: Optional[int] = Field(None, ge=9600, le=921600)
    max_relay_per_minute: Optional[int] = Field(None, ge=0, le=600)
    burst_size: Optional[int] = Field(None, ge=1, le=50)
    min_relay_rssi: Optional[float] = Field(None, ge=-150, le=0)
    max_relay_rssi: Optional[float] = Field(None, ge=-150, le=0)
    blocklist: Optional[list[str]] = None
    priority_list: Optional[list[str]] = None
    dedup_ttl_seconds: Optional[int] = Field(None, ge=5, le=3600)
    channel_throttle_percent: Optional[dict[str, float]] = None
    storm_guard: Optional[StormGuardUpdate] = None


class RadioAdvancedUpdate(BaseModel):
    spectral_scan_interval_seconds: Optional[float] = Field(None, ge=0, le=3600)
    sx1261_spi_path: Optional[str] = None
    gps_pps_enabled: Optional[bool] = None
    gps_pps_tty_path: Optional[str] = None


class TopologyUpdate(BaseModel):
    poll_enabled: Optional[bool] = None
    poll_interval_minutes: Optional[int] = Field(None, ge=1, le=1440)
    max_polls_per_cycle: Optional[int] = Field(None, ge=1, le=100)
    infer_dark_positions: Optional[bool] = None


@router.put("/storage")
async def update_storage(
    req: StorageUpdate,
    _claims: SessionClaims = Depends(require_admin),
    audit: AuditLogWriter = Depends(get_audit_writer),
):
    if _config is None:
        raise HTTPException(503, "Config not loaded")

    updates: dict = {}
    storage = _config.storage
    restart_needed = False

    if req.max_packets_retained is not None:
        storage.max_packets_retained = req.max_packets_retained
        updates["max_packets_retained"] = req.max_packets_retained
    if req.cleanup_interval_seconds is not None:
        storage.cleanup_interval_seconds = req.cleanup_interval_seconds
        updates["cleanup_interval_seconds"] = req.cleanup_interval_seconds

    if not updates:
        return {"saved": False, "restart_required": False}

    with audit.timed_action(
        user=_claims.subject, action="config.storage_update", params=updates
    ):
        try:
            save_section_to_yaml("storage", updates)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

    return {"saved": True, "restart_required": restart_needed, "updates": updates}


@router.put("/capture/meshcore-usb")
async def update_meshcore_usb(
    req: MeshcoreUsbUpdate,
    _claims: SessionClaims = Depends(require_admin),
    audit: AuditLogWriter = Depends(get_audit_writer),
):
    if _config is None:
        raise HTTPException(503, "Config not loaded")

    mc_usb = _config.capture.meshcore_usb
    usb_updates: dict = {}
    capture_updates: dict = {}
    restart_needed = False

    if req.serial_port is not None:
        port = req.serial_port.strip() or None
        mc_usb.serial_port = port
        usb_updates["serial_port"] = port
        restart_needed = True
    if req.baud_rate is not None:
        mc_usb.baud_rate = req.baud_rate
        usb_updates["baud_rate"] = req.baud_rate
        restart_needed = True
    if req.auto_detect is not None:
        mc_usb.auto_detect = req.auto_detect
        usb_updates["auto_detect"] = req.auto_detect
        restart_needed = True

    sources = list(_config.capture.sources or [])
    if req.enable_source is not None:
        has_usb = "meshcore_usb" in sources
        if req.enable_source and not has_usb:
            sources.append("meshcore_usb")
            capture_updates["sources"] = sources
            _config.capture.sources = sources
            restart_needed = True
        elif not req.enable_source and has_usb:
            sources = [s for s in sources if s != "meshcore_usb"]
            capture_updates["sources"] = sources
            _config.capture.sources = sources
            restart_needed = True

    if not usb_updates and not capture_updates:
        return {"saved": False, "restart_required": False}

    with audit.timed_action(
        user=_claims.subject,
        action="config.meshcore_usb_update",
        params={"usb": usb_updates, "capture": capture_updates},
    ):
        try:
            if usb_updates:
                save_section_to_yaml(
                    "capture",
                    {"meshcore_usb": {**_meshcore_usb_dict(mc_usb), **usb_updates}},
                )
            if capture_updates:
                save_section_to_yaml("capture", capture_updates)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

    return {"saved": True, "restart_required": restart_needed}


@router.put("/relay")
async def update_relay(
    req: RelayUpdate,
    _claims: SessionClaims = Depends(require_admin),
    audit: AuditLogWriter = Depends(get_audit_writer),
):
    if _config is None:
        raise HTTPException(503, "Config not loaded")

    updates: dict = {}
    relay = _config.relay
    restart_needed = False

    if req.enabled is not None:
        relay.enabled = req.enabled
        updates["enabled"] = req.enabled
        restart_needed = True
    if req.serial_port is not None:
        relay.serial_port = req.serial_port.strip() or None
        updates["serial_port"] = relay.serial_port
        restart_needed = True
    if req.serial_baud is not None:
        relay.serial_baud = req.serial_baud
        updates["serial_baud"] = req.serial_baud
    if req.max_relay_per_minute is not None:
        relay.max_relay_per_minute = req.max_relay_per_minute
        updates["max_relay_per_minute"] = req.max_relay_per_minute
    if req.burst_size is not None:
        relay.burst_size = req.burst_size
        updates["burst_size"] = req.burst_size
    if req.min_relay_rssi is not None:
        relay.min_relay_rssi = req.min_relay_rssi
        updates["min_relay_rssi"] = req.min_relay_rssi
    if req.max_relay_rssi is not None:
        if req.max_relay_rssi <= relay.min_relay_rssi:
            raise HTTPException(400, "max_relay_rssi must be greater than min_relay_rssi")
        relay.max_relay_rssi = req.max_relay_rssi
        updates["max_relay_rssi"] = req.max_relay_rssi

    hot_reload = False
    if req.blocklist is not None:
        try:
            relay.blocklist = validate_node_ids(req.blocklist)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        updates["blocklist"] = relay.blocklist
        hot_reload = True
    if req.priority_list is not None:
        try:
            relay.priority_list = validate_node_ids(req.priority_list)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        updates["priority_list"] = relay.priority_list
        hot_reload = True
    if req.dedup_ttl_seconds is not None:
        relay.dedup_ttl_seconds = req.dedup_ttl_seconds
        updates["dedup_ttl_seconds"] = req.dedup_ttl_seconds
        hot_reload = True
    if req.channel_throttle_percent is not None:
        try:
            relay.channel_throttle_percent = normalize_channel_throttle(
                req.channel_throttle_percent
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        updates["channel_throttle_percent"] = relay.channel_throttle_percent
        hot_reload = True

    storm_guard_hot_reload = False
    if req.storm_guard is not None:
        sg = relay.storm_guard
        sg_updates: dict = {}
        sg_req = req.storm_guard
        if sg_req.enabled is not None:
            sg.enabled = sg_req.enabled
            sg_updates["enabled"] = sg.enabled
            storm_guard_hot_reload = True
        if sg_req.window_seconds is not None:
            sg.window_seconds = sg_req.window_seconds
            sg_updates["window_seconds"] = sg.window_seconds
            storm_guard_hot_reload = True
        if sg_req.identical_packet_threshold is not None:
            sg.identical_packet_threshold = sg_req.identical_packet_threshold
            sg_updates["identical_packet_threshold"] = sg.identical_packet_threshold
            storm_guard_hot_reload = True
        if sg_req.rate_threshold_per_minute is not None:
            sg.rate_threshold_per_minute = sg_req.rate_threshold_per_minute
            sg_updates["rate_threshold_per_minute"] = sg.rate_threshold_per_minute
            storm_guard_hot_reload = True
        if sg_req.quarantine_duration_seconds is not None:
            sg.quarantine_duration_seconds = sg_req.quarantine_duration_seconds
            sg_updates["quarantine_duration_seconds"] = sg.quarantine_duration_seconds
            storm_guard_hot_reload = True
        if sg_req.notify_dashboard is not None:
            sg.notify_dashboard = sg_req.notify_dashboard
            sg_updates["notify_dashboard"] = sg.notify_dashboard
            storm_guard_hot_reload = True
        if sg_updates:
            updates["storm_guard"] = {
                "enabled": sg.enabled,
                "window_seconds": sg.window_seconds,
                "identical_packet_threshold": sg.identical_packet_threshold,
                "rate_threshold_per_minute": sg.rate_threshold_per_minute,
                "quarantine_duration_seconds": sg.quarantine_duration_seconds,
                "notify_dashboard": sg.notify_dashboard,
            }

    if not updates:
        return {"saved": False, "restart_required": False}

    with audit.timed_action(
        user=_claims.subject, action="config.relay_update", params=updates
    ):
        try:
            save_section_to_yaml("relay", updates)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

    if storm_guard_hot_reload and _relay_manager is not None:
        _relay_manager.reload_storm_guard(relay.storm_guard)

    if hot_reload and _relay_manager is not None:
        _relay_manager.reload_filters(
            blocklist=relay.blocklist if req.blocklist is not None else None,
            priority_list=relay.priority_list if req.priority_list is not None else None,
            dedup_ttl_seconds=(
                relay.dedup_ttl_seconds if req.dedup_ttl_seconds is not None else None
            ),
            channel_throttle_percent=(
                relay.channel_throttle_percent
                if req.channel_throttle_percent is not None
                else None
            ),
            region=_config.radio.region if _config is not None else None,
        )

    return {"saved": True, "restart_required": restart_needed, "updates": updates}


@router.put("/radio/advanced")
async def update_radio_advanced(
    req: RadioAdvancedUpdate,
    _claims: SessionClaims = Depends(require_admin),
    audit: AuditLogWriter = Depends(get_audit_writer),
):
    if _config is None:
        raise HTTPException(503, "Config not loaded")

    updates: dict = {}
    radio = _config.radio
    restart_needed = False

    if req.spectral_scan_interval_seconds is not None:
        radio.spectral_scan_interval_seconds = req.spectral_scan_interval_seconds
        updates["spectral_scan_interval_seconds"] = req.spectral_scan_interval_seconds
        restart_needed = True
    if req.sx1261_spi_path is not None:
        path = req.sx1261_spi_path.strip()
        radio.sx1261_spi_path = path
        updates["sx1261_spi_path"] = path
        restart_needed = True
    if req.gps_pps_enabled is not None:
        radio.gps_pps_enabled = req.gps_pps_enabled
        updates["gps_pps_enabled"] = req.gps_pps_enabled
        restart_needed = True
    if req.gps_pps_tty_path is not None:
        path = req.gps_pps_tty_path.strip() or "/dev/ttyAMA0"
        radio.gps_pps_tty_path = path
        updates["gps_pps_tty_path"] = path
        restart_needed = True

    if not updates:
        return {"saved": False, "restart_required": False}

    try:
        _validate_gps_pps_config(_config)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    with audit.timed_action(
        user=_claims.subject, action="config.radio_advanced_update", params=updates
    ):
        try:
            save_section_to_yaml("radio", updates)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

    return {"saved": True, "restart_required": restart_needed, "updates": updates}


@router.put("/topology")
async def update_topology(
    req: TopologyUpdate,
    _claims: SessionClaims = Depends(require_admin),
    audit: AuditLogWriter = Depends(get_audit_writer),
):
    if _config is None:
        raise HTTPException(503, "Config not loaded")

    updates: dict = {}
    topo = _config.topology
    restart_needed = False

    if req.poll_enabled is not None:
        topo.poll_enabled = req.poll_enabled
        updates["poll_enabled"] = req.poll_enabled
        restart_needed = True
    if req.poll_interval_minutes is not None:
        topo.poll_interval_minutes = req.poll_interval_minutes
        updates["poll_interval_minutes"] = req.poll_interval_minutes
        restart_needed = True
    if req.max_polls_per_cycle is not None:
        topo.max_polls_per_cycle = req.max_polls_per_cycle
        updates["max_polls_per_cycle"] = req.max_polls_per_cycle
        restart_needed = True
    if req.infer_dark_positions is not None:
        topo.infer_dark_positions = req.infer_dark_positions
        updates["infer_dark_positions"] = req.infer_dark_positions

    if not updates:
        return {"saved": False, "restart_required": False}

    with audit.timed_action(
        user=_claims.subject, action="config.topology_update", params=updates
    ):
        try:
            save_section_to_yaml("topology", updates)
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

    return {"saved": True, "restart_required": restart_needed, "updates": updates}


def _meshcore_usb_dict(mc_usb) -> dict:
    return {
        "serial_port": mc_usb.serial_port,
        "baud_rate": mc_usb.baud_rate,
        "auto_detect": mc_usb.auto_detect,
    }
