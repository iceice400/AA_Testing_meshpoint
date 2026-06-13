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


def extract_trace_routes(payload):
    if not payload or not isinstance(payload, dict):
        return []
    out = []

    def push(route, snr_t, snr_b):
        path = norm_route(route)
        if len(path) < 2:
            return
        out.append({"route": path, "snr_towards": snr_t or [], "snr_back": snr_b or []})

    push(payload.get("route"), payload.get("snr_towards"), payload.get("snr_back"))
    push(payload.get("route_reply"), payload.get("snr_towards"), payload.get("snr_back"))
    push(payload.get("route_request"), payload.get("snr_towards"), payload.get("snr_back"))
    return out


class TestTopologyTraceRoutes(unittest.TestCase):
    def test_ignores_empty_traceroute_probe(self):
        routes = extract_trace_routes({"route": [], "snr_towards": []})
        self.assertEqual(routes, [])

    def test_accepts_traceroute_reply(self):
        routes = extract_trace_routes({
            "route": ["aabbccdd", "11223344", "deadbeef"],
            "snr_towards": [8.0, 6.5],
            "snr_back": [7.0, 5.0],
        })
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["route"][-1], "deadbeef")

    def test_accepts_routing_route_reply(self):
        routes = extract_trace_routes({
            "route_reply": ["aabbccdd", "99887766"],
            "snr_towards": [4.0],
        })
        self.assertEqual(len(routes), 1)
        self.assertTrue(is_valid_route(routes[0]["route"]))


if __name__ == "__main__":
    unittest.main()
