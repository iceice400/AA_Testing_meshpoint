/**
 * Shared topology graph for the dashboard map and Topology tab.
 * Merges REST snapshots from GET /api/analytics/topology with live
 * NEIGHBORINFO / TRACEROUTE / ROUTING packets from the WebSocket.
 */
(function () {
    const RSSI_GOOD = -90;
    const RSSI_MED = -110;

    function normalizeNodeId(id) {
        if (id == null || id === '') return '';
        return String(id).trim().toLowerCase().replace(/^!/, '');
    }

    function edgeKey(a, b) {
        const x = normalizeNodeId(a);
        const y = normalizeNodeId(b);
        if (!x || !y) return '';
        return x < y ? `${x}:${y}` : `${y}:${x}`;
    }

    function parseTs(value) {
        if (!value) return Date.now();
        const t = new Date(value).getTime();
        return Number.isFinite(t) ? t : Date.now();
    }

    function _coordsValid(lat, lon) {
        if (lat == null || lon == null) return false;
        const la = Number(lat);
        const lo = Number(lon);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
        if (la === 0 && lo === 0) return false;
        return la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
    }

    class TopologyStore {
        constructor(options = {}) {
            this.hours = options.hours ?? 24;
            this.staleEdgeMs = options.staleEdgeMs ?? 30 * 60 * 1000;
            this._nodes = new Map();
            this._edges = new Map();
            this._routes = [];
            this._edgeSources = [];
            this._stats = {};
            this._meshNodes = new Map();
            this._knownNodeIds = new Set();
            this._fetchedAt = null;
            this._listeners = new Set();
            this._selectedNodeId = null;

            this._estimates = new Map();

            this.filters = {
                minRssi: -130,
                minSnr: -20,
                maxHops: 7,
                roles: new Set(['ROUTER', 'CLIENT', 'REPEATER', 'TRACKER', 'SENSOR', 'DARK']),
                channels: new Set(['all']),
            };

            this.layers = {
                edges: true,
                darkStubs: true,
                labels: true,
                coverage: false,
            };

            this.mapMode = 'topology';
        }

        onChange(fn) {
            this._listeners.add(fn);
            return () => this._listeners.delete(fn);
        }

        notifyChange() {
            this._emit();
        }

        _emit() {
            this._listeners.forEach((fn) => {
                try { fn(this.getSnapshot()); } catch (e) { console.error('TopologyStore listener:', e); }
            });
        }

        setHours(hours) {
            const h = Number(hours);
            this.hours = Number.isFinite(h) && h > 0 ? h : 24;
            this._pruneStaleEdges();
            this._emit();
        }

        setSelectedNode(nodeId) {
            this._selectedNodeId = nodeId ? normalizeNodeId(nodeId) : null;
            this._emit();
        }

        get selectedNodeId() {
            return this._selectedNodeId;
        }

        getNodeCoords(nodeId) {
            const id = normalizeNodeId(nodeId);
            if (!id) return null;
            const mesh = this._meshNodes.get(id);
            if (mesh && _coordsValid(mesh.latitude, mesh.longitude)) {
                return { lat: Number(mesh.latitude), lng: Number(mesh.longitude) };
            }
            const node = this._nodes.get(id);
            if (node && _coordsValid(node.lat, node.lng)) {
                return { lat: Number(node.lat), lng: Number(node.lng) };
            }
            if (node && _coordsValid(node.latitude, node.longitude)) {
                return { lat: Number(node.latitude), lng: Number(node.longitude) };
            }
            const est = this._estimates.get(id);
            if (est && _coordsValid(est.lat, est.lng)) {
                return { lat: Number(est.lat), lng: Number(est.lng) };
            }
            return null;
        }

        /** Mesh nodes with valid GPS for map plotting. */
        getPlottedMeshNodes() {
            const out = [];
            for (const n of this._meshNodes.values()) {
                if (_coordsValid(n.latitude, n.longitude)) {
                    out.push(n);
                }
            }
            return out;
        }

        getMeshNodeList() {
            return [...this._meshNodes.values()];
        }

        /** Mesh nodes from GET /api/nodes — GPS, names, roles. */
        syncMeshNodes(nodes) {
            this._meshNodes.clear();
            for (const n of nodes || []) {
                const id = normalizeNodeId(n.node_id || n.id);
                if (!id) continue;
                this._knownNodeIds.add(id);
                this._meshNodes.set(id, n);
                const existing = this._nodes.get(id) || {};
                this._nodes.set(id, {
                    ...existing,
                    id,
                    label: n.display_name || n.long_name || n.short_name || existing.label || `!${String(id).slice(-4)}`,
                    shortName: n.short_name || existing.shortName,
                    longName: n.long_name || n.long_name,
                    protocol: n.protocol || existing.protocol || 'meshtastic',
                    role: n.role || existing.role || 'CLIENT',
                    lat: n.latitude ?? existing.lat ?? null,
                    lng: n.longitude ?? existing.lng ?? null,
                    latest_rssi: n.rssi ?? n.latest_rssi ?? existing.latest_rssi ?? null,
                    packet_count: existing.packet_count ?? 0,
                });
            }
            this._emit();
        }

        async refreshFromApi() {
            try {
                const res = await fetch(`/api/analytics/topology?hours=${this.hours}`);
                if (!res.ok) return;
                const data = await res.json();
                this.loadFromApi(data);
            } catch (e) {
                console.error('TopologyStore refresh failed:', e);
            }
        }

        loadFromApi(data) {
            if (!data || typeof data !== 'object') return;
            this._fetchedAt = Date.now();
            this._edges.clear();
            this._routes = Array.isArray(data.routes)
                ? data.routes.map((r) => ({
                    ...r,
                    source_id: normalizeNodeId(r.source_id),
                    route: (r.route || []).map((hop) => normalizeNodeId(hop)).filter(Boolean),
                    ts: parseTs(r.last_seen),
                }))
                : [];
            this._edgeSources = Array.isArray(data.edge_sources) ? data.edge_sources.slice() : [];
            this._stats = data.stats || {};
            this._estimates = new Map();
            for (const est of data.estimates || []) {
                if (est?.id) {
                    const eid = normalizeNodeId(est.id);
                    this._estimates.set(eid, { ...est, id: eid });
                }
            }

            for (const n of data.nodes || []) {
                const id = normalizeNodeId(n.id);
                if (!id) continue;
                this._knownNodeIds.add(id);
                const mesh = this._meshNodes.get(id);
                const existing = this._nodes.get(id) || {};
                this._nodes.set(id, {
                    ...existing,
                    id,
                    label: n.label || existing.label || `!${String(id).slice(-4)}`,
                    protocol: n.protocol || existing.protocol || 'meshtastic',
                    packet_count: n.packet_count ?? existing.packet_count ?? 0,
                    latest_rssi: n.latest_rssi ?? existing.latest_rssi ?? null,
                    lat: mesh?.latitude ?? existing.lat ?? null,
                    lng: mesh?.longitude ?? existing.lng ?? null,
                    role: mesh?.role || existing.role || 'CLIENT',
                });
            }

            for (const e of data.edges || []) {
                this._upsertEdge(e.source, e.target, {
                    rssi: e.rssi,
                    snr: e.snr,
                    hops: 1,
                    edge_type: e.edge_type || 'unknown',
                    weak: !!e.weak,
                    source_kind: e.edge_type || 'api',
                    ts: parseTs(e.last_seen),
                    channel: e.channel ?? null,
                });
            }

            for (const r of this._routes) {
                if (r.last_seen && !r.ts) {
                    r.ts = parseTs(r.last_seen);
                }
            }

            this._pruneStaleEdges();
            this._emit();
        }

        ingestPacket(packet) {
            if (!packet) return false;
            const type = (packet.packet_type || '').toLowerCase();
            if (!['neighborinfo', 'traceroute', 'routing', 'position'].includes(type)) {
                return false;
            }

            const sourceId = normalizeNodeId(packet.source_id);
            if (sourceId) {
                this._knownNodeIds.add(sourceId);
                const existing = this._nodes.get(sourceId) || { id: sourceId };
                const mesh = this._meshNodes.get(sourceId) || {};
                const payload = packet.decoded_payload;
                let lat = mesh.latitude ?? existing.lat ?? null;
                let lng = mesh.longitude ?? existing.lng ?? null;
                if (type === 'position' && payload && typeof payload === 'object') {
                    const plat = payload.latitude ?? payload.adv_lat;
                    const plng = payload.longitude ?? payload.adv_lon;
                    if (_coordsValid(plat, plng)) {
                        lat = plat;
                        lng = plng;
                        mesh.latitude = plat;
                        mesh.longitude = plng;
                        this._meshNodes.set(sourceId, { ...mesh, node_id: sourceId, id: sourceId });
                    }
                }
                this._nodes.set(sourceId, {
                    ...existing,
                    id: sourceId,
                    latest_rssi: packet.rssi ?? packet.signal?.rssi ?? existing.latest_rssi,
                    lat,
                    lng,
                    role: mesh?.role || existing.role || 'CLIENT',
                });
            }

            if (type === 'position') {
                this._emit();
                return true;
            }

            const payload = packet.decoded_payload;
            if (!payload || typeof payload !== 'object') return true;

            const rssi = packet.rssi ?? packet.signal?.rssi ?? null;
            const snr = packet.snr ?? packet.signal?.snr ?? null;
            const ts = packet.rx_time
                ? packet.rx_time * 1000
                : parseTs(packet.timestamp);

            if (type === 'neighborinfo') {
                const neighbors = payload.neighbors || [];
                if (!Array.isArray(neighbors)) return true;
                for (const nb of neighbors) {
                    const target = normalizeNodeId(nb.node_id || nb.id);
                    if (!target) continue;
                    this._knownNodeIds.add(target);
                    this._upsertEdge(sourceId, target, {
                        rssi,
                        snr: nb.snr != null ? nb.snr : snr,
                        hops: 1,
                        edge_type: 'neighborinfo',
                        weak: rssi != null && rssi < RSSI_MED,
                        source_kind: 'neighborinfo',
                        ts,
                    });
                }
                this._emit();
                return true;
            }

            const traceRoutes = window.TopologyTrace?.extractTraceRoutes?.(packet) || [];
            let addedRoute = false;
            for (const trace of traceRoutes) {
                const routeIds = trace.route;
                if (!Array.isArray(routeIds) || routeIds.length < 2) continue;
                for (let i = 0; i < routeIds.length - 1; i++) {
                    this._upsertEdge(routeIds[i], routeIds[i + 1], {
                        rssi,
                        snr,
                        hops: 1,
                        edge_type: type === 'traceroute' ? 'traceroute' : 'routing',
                        weak: rssi != null && rssi < RSSI_MED,
                        source_kind: type,
                        ts,
                    });
                }
                if (!addedRoute) {
                    this._routes.unshift({
                        source_id: sourceId,
                        route: routeIds,
                        snr_towards: trace.snr_towards || [],
                        snr_back: trace.snr_back || [],
                        ts,
                        last_seen: packet.timestamp || new Date(ts).toISOString(),
                    });
                    if (this._routes.length > 80) this._routes.length = 80;
                    addedRoute = true;
                }
            }

            this._pruneStaleEdges();
            this._emit();
            return true;
        }

        _upsertEdge(a, b, data) {
            const na = normalizeNodeId(a);
            const nb = normalizeNodeId(b);
            if (!na || !nb || na === nb) return;
            const key = edgeKey(na, nb);
            const existing = this._edges.get(key) || {};
            this._edges.set(key, {
                ...existing,
                ...data,
                nodeA: na < nb ? na : nb,
                nodeB: na < nb ? nb : na,
                key,
            });
        }

        _pruneStaleEdges() {
            const windowMs = Math.max(this.hours || 24, 1) * 60 * 60 * 1000;
            const cutoff = Date.now() - windowMs;
            for (const [key, edge] of this._edges) {
                if ((edge.ts || 0) < cutoff) {
                    this._edges.delete(key);
                }
            }
        }

        getFilteredEdges() {
            const f = this.filters;
            const selected = this._selectedNodeId;
            const routeKeys = selected && this.mapMode === 'hop'
                ? this._routeEdgeKeys(selected)
                : null;

            return [...this._edges.values()].filter((edge) => {
                if (this.mapMode === 'hop' && !routeKeys) {
                    const kind = edge.edge_type || edge.source_kind || '';
                    if (kind !== 'traceroute' && kind !== 'routing') return false;
                }
                if (edge.rssi != null && edge.rssi < f.minRssi) return false;
                if (edge.snr != null && edge.snr < f.minSnr) return false;
                if ((edge.hops || 1) > f.maxHops) return false;
                if (routeKeys && !routeKeys.has(edge.key)) return false;
                return true;
            });
        }

        _routeEdgeKeys(nodeId) {
            const keys = new Set();
            for (const route of this._routes) {
                const path = route.route || [];
                if (!path.includes(nodeId)) continue;
                for (let i = 0; i < path.length - 1; i++) {
                    keys.add(edgeKey(path[i], path[i + 1]));
                }
            }
            return keys;
        }

        getUnplotted() {
            const out = [];
            const ids = new Set([...this._knownNodeIds, ...this._meshNodes.keys()]);
            for (const id of ids) {
                const mesh = this._meshNodes.get(id);
                const node = this._nodes.get(id) || {};
                const lat = mesh?.latitude ?? node.lat ?? node.latitude;
                const lng = mesh?.longitude ?? node.lng ?? node.longitude;
                if (_coordsValid(lat, lng)) continue;
                const edgeCount = [...this._edges.values()].filter(
                    (e) => e.nodeA === id || e.nodeB === id,
                ).length;
                out.push({
                    id,
                    label: mesh?.display_name || mesh?.long_name || node.label || id,
                    role: mesh?.role || node.role || 'CLIENT',
                    latest_rssi: mesh?.rssi ?? mesh?.latest_rssi ?? node.latest_rssi,
                    edge_count: edgeCount,
                });
            }
            out.sort((a, b) => (b.edge_count || 0) - (a.edge_count || 0));
            return out;
        }

        getSnapshot() {
            const edges = this.getFilteredEdges();
            const nodes = [...this._nodes.values()];
            const mapped = this.getPlottedMeshNodes().length;
            const unplotted = this.getUnplotted();
            const poorEdges = edges.filter((e) => (e.rssi ?? 0) < RSSI_MED).length;

            return {
                nodes,
                edges,
                routes: this._routes,
                edge_sources: this._edgeSources,
                stats: this._stats,
                unplotted,
                estimates: [...this._estimates.values()],
                mapped,
                dark: unplotted.length,
                poor_edges: poorEdges,
                fetched_at: this._fetchedAt,
                hours: this.hours,
            };
        }

        exportJson() {
            const snap = this.getSnapshot();
            return {
                exported_at: new Date().toISOString(),
                hours: this.hours,
                nodes: snap.nodes,
                edges: snap.edges,
                routes: snap.routes,
                unplotted: snap.unplotted,
                stats: snap.stats,
            };
        }

        edgeColor(edge, mode) {
            if (mode === 'signal') {
                const snr = edge.snr;
                if (snr == null) return 'var(--text-muted)';
                if (snr > 5) return 'var(--accent-green)';
                if (snr >= 0) return 'var(--accent-amber)';
                return 'var(--accent-red)';
            }
            const rssi = edge.rssi;
            if (rssi == null) {
                return edge.edge_type === 'neighborinfo'
                    ? 'var(--accent-cyan)' : 'var(--accent-amber)';
            }
            if (rssi > RSSI_GOOD) return 'var(--accent-green)';
            if (rssi > RSSI_MED) return 'var(--accent-amber)';
            return 'var(--accent-red)';
        }

        edgeWeight(edge) {
            const rssi = edge.rssi ?? -130;
            return Math.max(1, Math.min(4, (Number(rssi) + 140) / 15));
        }

        edgeDash(edge) {
            if (edge.weak) return '4, 4';
            if (edge.edge_type && edge.edge_type !== 'neighborinfo') return '6, 4';
            return null;
        }
    }

    window.TopologyStore = TopologyStore;
    window.normalizeNodeId = normalizeNodeId;
})();
