"""USB companion firmware upload, flash, and live log WebSocket (PR 14)."""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel, Field

from src.api.audit import AuditLogWriter
from src.api.audit.dependencies import get_audit_writer
from src.api.auth.dependencies import require_admin
from src.api.auth.jwt_session import ROLE_ADMIN, JwtSessionService, SessionClaims
from src.api.auth.ws_guard import WS_AUTH_CLOSE_CODE, authenticate_websocket
from src.firmware.catalog import (
    assert_usb_companion_firmware,
    build_catalog_payload,
    download_firmware_artifact,
    get_board,
    is_usb_companion_firmware,
    load_catalog_config,
    revision_for_board,
)
from src.firmware.flasher import FlashJob, get_port_lock, run_flash_job
from src.firmware.log_broadcast import FlashLogBroadcaster
from src.firmware.upload_store import FirmwareUploadStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/firmware", tags=["firmware"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
DEFAULT_BAUD = 460800
DEFAULT_OFFSET = "0x10000"
_RECONNECT_POLL_SECONDS = 2
_RECONNECT_POLL_ATTEMPTS = 45

_upload_store = FirmwareUploadStore()
_broadcaster = FlashLogBroadcaster()
_jwt_service: JwtSessionService | None = None
_suspend_meshcore: Callable[[str], Awaitable[None]] | None = None
_resume_meshcore: Callable[[str], Awaitable[None]] | None = None
_companion_status: Callable[[], Awaitable[dict]] | None = None
_default_port: str = "/dev/ttyUSB0"
_flash_in_progress: bool = False


def init_routes(
    *,
    jwt_service: JwtSessionService | None,
    suspend_meshcore: Callable[[str], Awaitable[None]] | None = None,
    resume_meshcore: Callable[[str], Awaitable[None]] | None = None,
    companion_status: Callable[[], Awaitable[dict]] | None = None,
    default_serial_port: str | None = None,
) -> None:
    global _jwt_service, _suspend_meshcore, _resume_meshcore, _companion_status, _default_port
    _jwt_service = jwt_service
    _suspend_meshcore = suspend_meshcore
    _resume_meshcore = resume_meshcore
    _companion_status = companion_status
    if default_serial_port:
        _default_port = default_serial_port


def reset_routes() -> None:
    global _jwt_service, _suspend_meshcore, _resume_meshcore, _companion_status
    _jwt_service = None
    _suspend_meshcore = None
    _resume_meshcore = None
    _companion_status = None


class FlashRequest(BaseModel):
    upload_id: str = Field(..., min_length=8, max_length=64)
    serial_port: str = Field(default="/dev/ttyUSB0", min_length=1, max_length=128)
    baud_rate: int = Field(default=DEFAULT_BAUD, ge=9600, le=921600)
    partition_offset: str = Field(default=DEFAULT_OFFSET, min_length=3, max_length=16)
    catalog_board_id: str | None = Field(default=None, max_length=64)


class CatalogFetchRequest(BaseModel):
    board_id: str = Field(..., min_length=1, max_length=64)
    revision_id: str | None = Field(default=None, max_length=32)


class CatalogFlashRequest(BaseModel):
    board_id: str = Field(..., min_length=1, max_length=64)
    serial_port: str = Field(default="/dev/ttyUSB0", min_length=1, max_length=128)
    revision_id: str | None = Field(default=None, max_length=32)
    baud_rate: int | None = Field(default=None, ge=9600, le=921600)
    partition_offset: str | None = Field(default=None, min_length=3, max_length=16)


@router.websocket("/ws/flash-log")
async def flash_log_ws(websocket: WebSocket) -> None:
    if _jwt_service is None:
        await websocket.accept()
        await websocket.close(code=WS_AUTH_CLOSE_CODE)
        return

    claims = authenticate_websocket(websocket, _jwt_service)
    if claims is None or claims.role != ROLE_ADMIN:
        await websocket.accept()
        await websocket.close(code=WS_AUTH_CLOSE_CODE)
        return

    await websocket.accept()
    await _broadcaster.subscribe(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await _broadcaster.unsubscribe(websocket)


@router.get("/catalog")
async def firmware_catalog(_claims: SessionClaims = Depends(require_admin)):
    return await build_catalog_payload()


@router.get("/companion-status")
async def companion_status(_claims: SessionClaims = Depends(require_admin)):
    status = {
        "serial_port": _default_port,
        "flash_in_progress": _flash_in_progress,
        "meshcore": {"enabled": False, "connected": False, "companion_name": ""},
    }
    if _companion_status is not None:
        try:
            mc = await _companion_status()
            if isinstance(mc, dict):
                status["meshcore"] = mc
        except Exception as exc:
            logger.debug("companion-status probe failed: %s", exc)
            status["meshcore"]["status_error"] = str(exc)
    return status


@router.post("/fetch-catalog")
async def fetch_catalog_firmware(
    req: CatalogFetchRequest,
    _claims: SessionClaims = Depends(require_admin),
):
    cfg = load_catalog_config()
    board = get_board(cfg, req.board_id)
    if board is None:
        raise HTTPException(status_code=404, detail=f"Unknown board_id: {req.board_id}")

    catalog = await build_catalog_payload(cfg)
    board_entry = next(
        (b for b in catalog.get("boards", []) if b.get("id") == req.board_id),
        None,
    )
    artifact = (board_entry or {}).get("artifact")
    if not artifact or not artifact.get("url"):
        detail = catalog.get("release_error") or "No firmware artifact for this board."
        raise HTTPException(status_code=503, detail=detail)
    artifact_name = str(artifact.get("filename") or "")
    if not is_usb_companion_firmware(artifact_name):
        raise HTTPException(
            status_code=500,
            detail=(
                f"Catalog resolved a non-USB companion asset ({artifact_name}). "
                "Only companion_radio_usb builds are allowed."
            ),
        )

    rev = revision_for_board(cfg, req.board_id, req.revision_id)
    try:
        path, filename, size, sha256 = await download_firmware_artifact(
            str(artifact["url"]),
            max_bytes=MAX_UPLOAD_BYTES,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Download failed: {exc}") from exc

    upload_id = _upload_store.store(path, filename, size)
    return {
        "upload_id": upload_id,
        "filename": filename,
        "size_bytes": size,
        "sha256": sha256,
        "board_id": req.board_id,
        "board_label": board.label,
        "revision": rev,
        "baud_rate": board.baud_rate,
        "partition_offset": board.partition_offset,
        "merged": artifact.get("merged"),
        "release_tag": catalog.get("release_tag"),
    }


@router.post("/upload")
async def upload_firmware(
    firmware_file: UploadFile = File(...),
    _claims: SessionClaims = Depends(require_admin),
):
    filename = (firmware_file.filename or "").strip()
    if not filename.lower().endswith(".bin"):
        raise HTTPException(status_code=400, detail="Only .bin firmware files are accepted.")
    try:
        assert_usb_companion_firmware(filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    content = await firmware_file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Firmware file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )
    if not content:
        raise HTTPException(status_code=400, detail="Empty firmware file.")

    tmp = tempfile.NamedTemporaryFile(
        suffix=".bin",
        prefix="mp_fw_",
        delete=False,
    )
    try:
        tmp.write(content)
        tmp.flush()
        tmp.close()
        upload_id = _upload_store.store(
            Path(tmp.name),
            filename,
            len(content),
        )
    except Exception as exc:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to store upload: {exc}") from exc

    return {
        "upload_id": upload_id,
        "filename": filename,
        "size_bytes": len(content),
    }


@router.get("/defaults")
async def firmware_defaults(_claims: SessionClaims = Depends(require_admin)):
    return {
        "serial_port": _default_port,
        "baud_rate": DEFAULT_BAUD,
        "partition_offset": DEFAULT_OFFSET,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
    }


async def _poll_companion_reconnect(port: str) -> None:
    await _broadcaster.broadcast(
        "[flasher] Waiting for companion to reboot and reconnect…"
    )
    for attempt in range(_RECONNECT_POLL_ATTEMPTS):
        await asyncio.sleep(_RECONNECT_POLL_SECONDS)
        if _companion_status is None:
            continue
        try:
            mc = await _companion_status()
        except Exception:
            continue
        if mc.get("connected"):
            name = mc.get("companion_name") or "companion"
            await _broadcaster.broadcast(
                f"[flasher] Companion reconnected on {port} ({name})."
            )
            return
        if attempt > 0 and attempt % 5 == 0:
            await _broadcaster.broadcast(
                f"[flasher] Still waiting… ({attempt * _RECONNECT_POLL_SECONDS}s)"
            )
    await _broadcaster.broadcast(
        "[flasher] Reconnect timeout — check USB cable and refresh the dashboard."
    )


async def _run_flash_task(
    *,
    record_path: Path,
    record_filename: str,
    record_size: int,
    port: str,
    baud: int,
    offset: str,
    claims: SessionClaims,
    audit: AuditLogWriter,
    extra_params: dict | None = None,
) -> None:
    global _flash_in_progress
    _flash_in_progress = True
    port_lock = get_port_lock(port)
    async with port_lock:
        params = {
            "filename": record_filename,
            "port": port,
            "baud": baud,
            "offset": offset,
            "size_bytes": record_size,
            **(extra_params or {}),
        }
        with audit.timed_action(
            user=claims.subject,
            action="firmware_flash",
            params=params,
        ) as ctx:
            try:
                if _suspend_meshcore is not None:
                    await _broadcaster.broadcast(
                        f"[flasher] releasing MeshCore serial on {port}…"
                    )
                    await _suspend_meshcore(port)

                job = FlashJob(
                    port=port,
                    baud=baud,
                    offset=offset,
                    bin_path=record_path,
                    log_callback=_broadcaster.broadcast,
                )
                success = await run_flash_job(job)
                ctx.params["exit_code"] = 0 if success else 1
                ctx.params["success"] = success
                if not success:
                    ctx.set_result("error")
                elif _resume_meshcore is not None:
                    await _broadcaster.broadcast(
                        "[flasher] Resuming MeshCore USB capture…"
                    )
                    await _resume_meshcore(port)
                    await _poll_companion_reconnect(port)
            except Exception as exc:
                logger.exception("Firmware flash task failed")
                await _broadcaster.broadcast(f"[flasher] EXCEPTION: {exc}")
                ctx.set_result("error")
                ctx.params["error"] = str(exc)
            finally:
                try:
                    os.unlink(record_path)
                except OSError:
                    pass
                _flash_in_progress = False


@router.post("/flash")
async def flash_companion(
    req: FlashRequest,
    claims: SessionClaims = Depends(require_admin),
    audit: AuditLogWriter = Depends(get_audit_writer),
):
    record = _upload_store.pop(req.upload_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Unknown or expired upload_id.")

    port = req.serial_port.strip()
    if not port:
        raise HTTPException(status_code=400, detail="serial_port is required.")

    port_lock = get_port_lock(port)
    if port_lock.locked():
        _upload_store.store(record.path, record.filename, record.size_bytes)
        raise HTTPException(
            status_code=409,
            detail=f"A flash operation is already in progress on {port}.",
        )

    extra = {}
    if req.catalog_board_id:
        extra["catalog_board_id"] = req.catalog_board_id

    asyncio.create_task(
        _run_flash_task(
            record_path=record.path,
            record_filename=record.filename,
            record_size=record.size_bytes,
            port=port,
            baud=req.baud_rate,
            offset=req.partition_offset,
            claims=claims,
            audit=audit,
            extra_params=extra,
        ),
        name="firmware-flash",
    )

    return {
        "status": "queued",
        "port": port,
        "filename": record.filename,
        "ws_path": "/api/firmware/ws/flash-log",
    }


@router.post("/flash-catalog")
async def flash_catalog_one_click(
    req: CatalogFlashRequest,
    claims: SessionClaims = Depends(require_admin),
    audit: AuditLogWriter = Depends(get_audit_writer),
):
    """Tier C: download catalog artifact from GitHub and flash in one step."""
    fetch = await fetch_catalog_firmware(
        CatalogFetchRequest(board_id=req.board_id, revision_id=req.revision_id),
        _claims=claims,
    )
    cfg = load_catalog_config()
    board = get_board(cfg, req.board_id)
    baud = req.baud_rate or (board.baud_rate if board else DEFAULT_BAUD)
    offset = req.partition_offset or (
        board.partition_offset if board else DEFAULT_OFFSET
    )
    port = req.serial_port.strip()
    if not port:
        raise HTTPException(status_code=400, detail="serial_port is required.")

    port_lock = get_port_lock(port)
    if port_lock.locked():
        raise HTTPException(
            status_code=409,
            detail=f"A flash operation is already in progress on {port}.",
        )

    record = _upload_store.pop(fetch["upload_id"])
    if record is None:
        raise HTTPException(status_code=500, detail="Staged firmware missing after fetch.")

    asyncio.create_task(
        _run_flash_task(
            record_path=record.path,
            record_filename=record.filename,
            record_size=record.size_bytes,
            port=port,
            baud=baud,
            offset=offset,
            claims=claims,
            audit=audit,
            extra_params={
                "catalog_board_id": req.board_id,
                "sha256": fetch.get("sha256"),
                "release_tag": fetch.get("release_tag"),
                "one_click": True,
            },
        ),
        name="firmware-flash-catalog",
    )

    return {
        "status": "queued",
        "port": port,
        "filename": record.filename,
        "board_id": req.board_id,
        "sha256": fetch.get("sha256"),
        "release_tag": fetch.get("release_tag"),
        "ws_path": "/api/firmware/ws/flash-log",
    }
