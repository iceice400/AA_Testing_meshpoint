"""Firmware catalog: board profiles, GitHub release resolution, secure download."""
from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml

logger = logging.getLogger(__name__)

_CATALOG_PATH = Path(__file__).resolve().parents[2] / "config" / "firmware_catalog.yaml"
_RELEASE_CACHE_TTL = 300.0
_release_cache: dict[str, Any] = {"fetched_at": 0.0, "payload": None}

# MeshPoint only flashes MeshCore **USB serial companion** firmware — never BLE.
USB_COMPANION_VARIANT = "companion_radio_usb"
_BLE_MARKERS = ("companion_radio_ble", "_companion_radio_ble")


def is_usb_companion_firmware(name: str) -> bool:
    """True when *name* looks like a MeshCore USB companion .bin (not BLE)."""
    lower = (name or "").strip().lower()
    if not lower.endswith(".bin"):
        return False
    if any(marker in lower for marker in _BLE_MARKERS):
        return False
    return USB_COMPANION_VARIANT in lower


def assert_usb_companion_firmware(name: str) -> None:
    """Raise ValueError if *name* is not an accepted USB companion image."""
    lower = (name or "").strip().lower()
    if any(marker in lower for marker in _BLE_MARKERS):
        raise ValueError(
            "BLE companion firmware cannot be flashed here. "
            "MeshPoint requires companion_radio_usb (USB serial) images only."
        )
    if not is_usb_companion_firmware(name):
        raise ValueError(
            "Firmware filename must include companion_radio_usb. "
            "MeshPoint only flashes MeshCore USB serial companion builds — not BLE, "
            "not repeater/router, and not Meshtastic handset firmware."
        )


@dataclass(frozen=True)
class BoardProfile:
    id: str
    label: str
    asset_prefix: str
    baud_rate: int
    partition_offset: str
    recommended: bool = False
    notes: str = ""
    default_revision: str | None = None
    revisions: tuple[dict[str, str], ...] = field(default_factory=tuple)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_catalog_config(path: Path | None = None) -> dict[str, Any]:
    catalog_path = path or _CATALOG_PATH
    with catalog_path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError("firmware catalog must be a mapping")
    return data


def _board_profiles(cfg: dict[str, Any]) -> list[BoardProfile]:
    profiles: list[BoardProfile] = []
    for raw in cfg.get("boards") or []:
        if not isinstance(raw, dict):
            continue
        revs = tuple(
            {
                "id": str(r.get("id", "")),
                "label": str(r.get("label", "")),
                "notes": str(r.get("notes", "")),
                "warning": str(r.get("warning", "")),
                "community_url": str(r.get("community_url", "")),
            }
            for r in (raw.get("revisions") or [])
            if isinstance(r, dict)
        )
        asset_prefix = str(raw["asset_prefix"])
        if USB_COMPANION_VARIANT not in asset_prefix:
            raise ValueError(
                f"Board {raw.get('id')}: asset_prefix must include {USB_COMPANION_VARIANT}"
            )
        profiles.append(
            BoardProfile(
                id=str(raw["id"]),
                label=str(raw.get("label", raw["id"])),
                asset_prefix=asset_prefix,
                baud_rate=int(raw.get("baud_rate", 460800)),
                partition_offset=str(raw.get("partition_offset", "0x10000")),
                recommended=bool(raw.get("recommended")),
                notes=str(raw.get("notes", "")),
                default_revision=raw.get("default_revision"),
                revisions=revs,
            )
        )
    return profiles


def get_board(cfg: dict[str, Any], board_id: str) -> BoardProfile | None:
    for board in _board_profiles(cfg):
        if board.id == board_id:
            return board
    return None


def _match_asset_name(
    assets: list[dict[str, Any]],
    prefix: str,
    *,
    prefer_merged: bool,
    variant: str,
) -> dict[str, Any] | None:
    candidates = [
        a
        for a in assets
        if isinstance(a, dict)
        and str(a.get("name", "")).startswith(prefix)
        and variant == USB_COMPANION_VARIANT
        and is_usb_companion_firmware(str(a.get("name", "")))
    ]
    if not candidates:
        return None
    if prefer_merged:
        merged = [a for a in candidates if "merged" in str(a.get("name", ""))]
        if merged:
            return merged[0]
    return candidates[0]


async def fetch_github_release(repo: str, tag: str) -> dict[str, Any]:
    cache_key = f"{repo}:{tag}"
    now = time.monotonic()
    cached = _release_cache.get("payload")
    if (
        cached
        and _release_cache.get("key") == cache_key
        and now - float(_release_cache.get("fetched_at", 0)) < _RELEASE_CACHE_TTL
    ):
        return cached

    url = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            url,
            headers={"Accept": "application/vnd.github+json"},
        )
        resp.raise_for_status()
        payload = resp.json()

    _release_cache["key"] = cache_key
    _release_cache["fetched_at"] = now
    _release_cache["payload"] = payload
    return payload


async def build_catalog_payload(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or load_catalog_config()
    rel_cfg = cfg.get("release") or {}
    repo = str(rel_cfg.get("github_repo", "meshcore-dev/MeshCore"))
    tag = str(rel_cfg.get("release_tag", "companion-v1.16.0"))
    prefer_merged = bool(rel_cfg.get("prefer_merged", True))
    variant = str(rel_cfg.get("variant", USB_COMPANION_VARIANT))
    if variant != USB_COMPANION_VARIANT:
        logger.warning(
            "Catalog variant %r overridden to %s",
            variant,
            USB_COMPANION_VARIANT,
        )
        variant = USB_COMPANION_VARIANT

    release_error: str | None = None
    release_tag = tag
    assets: list[dict[str, Any]] = []
    try:
        release = await fetch_github_release(repo, tag)
        release_tag = str(release.get("tag_name", tag))
        assets = list(release.get("assets") or [])
    except Exception as exc:
        logger.warning("Firmware catalog: GitHub release fetch failed: %s", exc)
        release_error = str(exc)

    boards_out: list[dict[str, Any]] = []
    recommended_id: str | None = None
    for board in _board_profiles(cfg):
        entry: dict[str, Any] = {
            "id": board.id,
            "label": board.label,
            "baud_rate": board.baud_rate,
            "partition_offset": board.partition_offset,
            "recommended": board.recommended,
            "notes": board.notes,
            "default_revision": board.default_revision,
            "revisions": list(board.revisions),
        }
        if assets:
            asset = _match_asset_name(
                assets,
                board.asset_prefix,
                prefer_merged=prefer_merged,
                variant=variant,
            )
            if asset:
                entry["artifact"] = {
                    "filename": asset.get("name"),
                    "url": asset.get("browser_download_url"),
                    "size_bytes": asset.get("size"),
                    "merged": "merged" in str(asset.get("name", "")),
                    "variant": USB_COMPANION_VARIANT,
                }
        if board.recommended and recommended_id is None and entry.get("artifact"):
            recommended_id = board.id
        boards_out.append(entry)

    return {
        "version": cfg.get("version", 1),
        "release_tag": release_tag,
        "release_error": release_error,
        "recommended_board_id": recommended_id,
        "firmware_variant": USB_COMPANION_VARIANT,
        "external_flashers": list(cfg.get("external_flashers") or []),
        "boards": boards_out,
        "manual_upload": True,
        "manual_upload_requires_usb_companion_name": True,
    }


async def download_firmware_artifact(
    url: str,
    *,
    expected_sha256: str | None = None,
    max_bytes: int = 10 * 1024 * 1024,
) -> tuple[Path, str, int, str]:
    """Download firmware to a temp file; return path, filename, size, sha256 hex."""
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            filename = _filename_from_url(url, resp.headers.get("content-disposition"))
            assert_usb_companion_firmware(filename)
            hasher = hashlib.sha256()
            size = 0
            tmp = tempfile.NamedTemporaryFile(
                suffix=".bin",
                prefix="mp_fw_cat_",
                delete=False,
            )
            try:
                async for chunk in resp.aiter_bytes():
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError(
                            f"Firmware download exceeds {max_bytes // (1024 * 1024)} MB limit."
                        )
                    hasher.update(chunk)
                    tmp.write(chunk)
                tmp.flush()
                tmp.close()
            except Exception:
                tmp.close()
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass
                raise

    digest = hasher.hexdigest()
    if expected_sha256 and digest.lower() != expected_sha256.lower():
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise ValueError(
            f"SHA256 mismatch (expected {expected_sha256[:12]}…, got {digest[:12]}…)."
        )

    return Path(tmp.name), filename, size, digest


def _filename_from_url(url: str, content_disposition: str | None) -> str:
    if content_disposition and "filename=" in content_disposition:
        part = content_disposition.split("filename=", 1)[1].strip().strip('"')
        if part.lower().endswith(".bin"):
            return part
    name = url.rsplit("/", 1)[-1].split("?", 1)[0]
    return name if name.lower().endswith(".bin") else "companion-firmware.bin"


def revision_for_board(
    cfg: dict[str, Any],
    board_id: str,
    revision_id: str | None,
) -> dict[str, str] | None:
    board = get_board(cfg, board_id)
    if board is None or not board.revisions:
        return None
    rid = revision_id or board.default_revision
    if not rid:
        return None
    for rev in board.revisions:
        if rev.get("id") == rid:
            return rev
    return None
