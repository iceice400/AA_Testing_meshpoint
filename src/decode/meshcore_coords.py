"""Shared MeshCore coordinate parsing from advert/contact payloads."""

from __future__ import annotations

from typing import Any, Optional


def meshcore_coords_from_mapping(payload: dict[str, Any]) -> Optional[tuple[float, float]]:
    """Return ``(lat, lon)`` when a MeshCore payload carries a valid fix."""
    if not isinstance(payload, dict):
        return None

    lat = _first_value(payload, "adv_lat", "advLat", "latitude", "lat")
    lon = _first_value(payload, "adv_lon", "advLon", "longitude", "lon", "lng")
    if lat is None or lon is None:
        for nested_key in ("advert", "advertisement", "adv"):
            nested = payload.get(nested_key)
            if isinstance(nested, dict):
                coords = meshcore_coords_from_mapping(nested)
                if coords:
                    return coords
        return None

    return _normalize_coord_pair(lat, lon)


def _first_value(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = payload.get(key)
        if value is None or value == "":
            continue
        return value
    return None


def _normalize_coord_pair(lat: Any, lon: Any) -> Optional[tuple[float, float]]:
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return None

    if abs(lat_f) > 90 or abs(lon_f) > 180:
        if abs(lat_f) > 1000 or abs(lon_f) > 1000:
            lat_f *= 1e-7
            lon_f *= 1e-7
        elif abs(lat_f) > 180 or abs(lon_f) > 360:
            lat_f *= 1e-6
            lon_f *= 1e-6

    if lat_f == 0.0 and lon_f == 0.0:
        return None
    if not (-90 <= lat_f <= 90 and -180 <= lon_f <= 180):
        return None
    return lat_f, lon_f
