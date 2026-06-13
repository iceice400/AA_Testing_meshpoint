from src.analytics.dark_node_locator import compute_topo_centroid_estimates


def test_centroid_places_dark_node_between_anchors():
    nodes = [
        {"id": "aaa", "latitude": 28.0, "longitude": -82.0},
        {"id": "bbb", "latitude": 28.01, "longitude": -82.01},
        {"id": "dark", "latitude": None, "longitude": None},
    ]
    edges = [
        {"source": "dark", "target": "aaa", "snr": 8.0},
        {"source": "dark", "target": "bbb", "snr": 6.0},
    ]
    estimates = compute_topo_centroid_estimates(nodes, edges, min_anchors=2)
    assert len(estimates) == 1
    est = estimates[0]
    assert est["id"] == "dark"
    assert 27.99 < est["lat"] < 28.02
    assert -82.02 < est["lng"] < -81.99
    assert est["method"] == "topo-centroid"
