"""Build hop paths from Meshtastic TRACEROUTE / ROUTING RouteDiscovery payloads."""

from __future__ import annotations

from src.relay.node_id import normalize_node_id

BROADCAST_DESTS = frozenset({"ffffffff", "ffff", "00000000", ""})


def normalize_trace_dest(destination: str | None) -> str:
    dest = normalize_node_id(destination or "")
    if not dest or dest in BROADCAST_DESTS:
        return ""
    return dest


def build_trace_path(
    source: str | None,
    destination: str | None,
    route: list | None,
) -> list[str]:
    """Chain source, relay node ids, and destination into a drawable path."""
    src = normalize_node_id(source or "")
    dest = normalize_trace_dest(destination)
    relays: list[str] = []
    for hop in route or []:
        node_id = normalize_node_id(str(hop))
        if node_id:
            relays.append(node_id)

    path: list[str] = []
    if src:
        path.append(src)
    for hop in relays:
        if not path or path[-1] != hop:
            path.append(hop)
    if dest and (not path or path[-1] != dest):
        path.append(dest)
    return path


def trace_path_edges(path: list[str]) -> list[tuple[str, str]]:
    if len(path) < 2:
        return []
    return [(path[i], path[i + 1]) for i in range(len(path) - 1)]
