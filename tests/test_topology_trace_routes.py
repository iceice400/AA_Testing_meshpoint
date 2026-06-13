"""Tests for topology trace route extraction (mirrors topology_trace.js)."""
from __future__ import annotations

import unittest


def norm_route(route):
    if not isinstance(route, list):
        return []
    out = []
    for hop in route:
        if hop is None or hop == "":
            continue
        out.append(str(hop).strip().lower().replace("!", ""))
    return out


def is_valid_route(route):
    return len(norm_route(route)) >= 2


def extract_trace_routes(payload, source_id="", destination_id=""):
    if not payload or not isinstance(payload, dict):
        return []
    out = []
    seen = set()

    def norm_dest(dest):
        d = (dest or "").strip().lower().replace("!", "")
        if not d or d in ("ffffffff", "ffff", "00000000"):
            return ""
        return d

    def build_path(route):
        src = (source_id or "").strip().lower().replace("!", "")
        dest = norm_dest(destination_id)
        relays = norm_route(route)
        path = []
        if src:
            path.append(src)
        for hop in relays:
            if not path or path[-1] != hop:
                path.append(hop)
        if dest and (not path or path[-1] != dest):
            path.append(dest)
        return path

    def push(route, snr_t, snr_b):
        path = build_path(route if isinstance(route, list) else [])
        if len(path) < 2:
            return
        key = ">".join(path)
        if key in seen:
            return
        seen.add(key)
        out.append({"route": path, "snr_towards": snr_t or [], "snr_back": snr_b or []})

    for field in (payload.get("route"), payload.get("route_reply"), payload.get("route_request")):
        if isinstance(field, list):
            push(field, payload.get("snr_towards"), payload.get("snr_back"))
    return out


class TestTopologyTraceRoutes(unittest.TestCase):
    def test_ignores_empty_traceroute_probe_without_dest(self):
        routes = extract_trace_routes({"route": [], "snr_towards": []}, "f6acb04f", "ffffffff")
        self.assertEqual(routes, [])

    def test_direct_hop_from_empty_traceroute_probe(self):
        routes = extract_trace_routes(
            {"route": [], "snr_towards": []},
            "f6acb04f",
            "49b7a980",
        )
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["route"], ["f6acb04f", "49b7a980"])

    def test_accepts_traceroute_reply(self):
        routes = extract_trace_routes({
            "route": ["11223344", "deadbeef"],
            "snr_towards": [8.0, 6.5],
            "snr_back": [7.0, 5.0],
        }, "aabbccdd", "99887766")
        self.assertEqual(len(routes), 1)
        self.assertEqual(
            routes[0]["route"],
            ["aabbccdd", "11223344", "deadbeef", "99887766"],
        )

    def test_accepts_routing_route_reply(self):
        routes = extract_trace_routes({
            "route_reply": ["11223344"],
            "snr_towards": [4.0],
        }, "aabbccdd", "99887766")
        self.assertEqual(len(routes), 1)
        self.assertTrue(is_valid_route(routes[0]["route"]))


if __name__ == "__main__":
    unittest.main()
