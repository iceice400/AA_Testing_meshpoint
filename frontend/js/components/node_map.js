/**
 * Leaflet map with marker clustering and smart topology overlays.
 */

const MAP_VIEW_STORAGE_KEY = 'meshpoint.nodeMap.view';
const MAP_DEFAULT_CENTER = [39.8, -98.5];
const MAP_DEFAULT_ZOOM = 4;

function _normNodeId(id) {
    if (typeof window.normalizeNodeId === 'function') {
        return window.normalizeNodeId(id);
    }
    if (id == null || id === '') return '';
    return String(id).trim().toLowerCase().replace(/^!/, '');
}

function _isValidGps(lat, lon) {
    if (lat == null || lon == null) return false;
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
    if (la === 0 && lo === 0) return false;
    return la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
}

class NodeMap {
    constructor(containerId, options = {}) {
        this._containerId = containerId;
        this._store = options.store || null;
        this._topologyEnabled = options.topology === true;
        this._viewStorageKey = options.viewStorageKey || MAP_VIEW_STORAGE_KEY;
        this._map = null;
        this._markerGroup = null;
        this._deviceMarker = null;
        this._markers = {};
        this._edgeLines = new Map();
        this._routeLines = [];
        this._hopSegmentLines = new Map();
        this._darkStubMarkers = new Map();
        this._localNodeId = options.localNodeId || null;
        this._darkOrbitLayer = null;
        this._initialized = false;
        this._hasFitBounds = false;
        this._statusStrip = null;
        this._unsubStore = null;
        this._init();
    }

    _init() {
        const el = document.getElementById(this._containerId);
        if (!el) return;

        this._mapWrap = el.closest('.map-panel__map-wrap')
            || el.closest('.topo-map-panel')
            || el.parentElement;

        this._map = L.map(this._containerId, {
            zoomControl: true,
            scrollWheelZoom: true,
        });

        const savedView = this._loadSavedView();
        if (savedView) {
            this._map.setView(savedView.center, savedView.zoom);
        } else {
            this._map.setView(MAP_DEFAULT_CENTER, MAP_DEFAULT_ZOOM);
        }

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CARTO',
            subdomains: 'abcd',
            maxZoom: 19,
        }).addTo(this._map);

        this._wireResizeRecalc();

        this._topologyLayer = L.layerGroup();
        this._routeLayer = L.layerGroup();
        this._topologyVisible = false;
        this._darkStubLayer = L.layerGroup();
        this._coverageLayer = L.layerGroup();
        this._coverageVisible = false;
        this._focusLine = null;

        this._markerGroup = L.markerClusterGroup({
            maxClusterRadius: 50,
            disableClusteringAtZoom: 13,
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
            iconCreateFunction: (cluster) => {
                const count = cluster.getChildCount();
                let size = 'small';
                if (count > 50) size = 'large';
                else if (count > 10) size = 'medium';
                return L.divIcon({
                    html: `<div><span>${count}</span></div>`,
                    className: `marker-cluster marker-cluster-${size}`,
                    iconSize: L.point(40, 40),
                });
            },
        });
        this._map.addLayer(this._markerGroup);

        if (this._topologyEnabled) {
            this._map.addLayer(this._topologyLayer);
            this._map.addLayer(this._routeLayer);
            this._darkOrbitLayer = L.layerGroup().addTo(this._map);

            this._topologyHintEl = document.createElement('div');
            this._topologyHintEl.className = 'map-topology-hint';
            this._topologyHintEl.hidden = true;
            this._topologyHintEl.setAttribute('role', 'status');
            this._topologyHintEl.innerHTML =
                'Topology links need GPS on both nodes — use the sidebar list for unplotted nodes.';
            el.appendChild(this._topologyHintEl);

            this._buildMapChrome();

            if (this._store) {
                this._unsubStore = this._store.onChange(() => {
                    this.renderTopology();
                });
            }
        } else {
            this._initDashboardOverlays(el);
        }

        this._initialized = true;

        this._map.on('moveend', () => this._saveCurrentView());
        this._map.on('zoomend', () => this._saveCurrentView());

        if (window.MeshpointNodeFavorites) {
            window.MeshpointNodeFavorites.onChange(() => {
                if (this._lastNodes) {
                    this.loadNodes(this._lastNodes, this._lastDevice);
                }
            });
        }

        document.addEventListener('meshpoint:nodeCardsFilter', () => {
            if (this._lastNodes) {
                this.loadNodes(this._lastNodes, this._lastDevice);
            }
        });
    }

    _initDashboardOverlays(el) {
        this._topologyHintEl = document.createElement('div');
        this._topologyHintEl.className = 'map-topology-hint';
        this._topologyHintEl.hidden = true;
        this._topologyHintEl.setAttribute('role', 'status');
        this._topologyHintEl.textContent =
            'Topology links need GPS on both nodes — open the Topology tab for the logical graph.';
        el.appendChild(this._topologyHintEl);

        const overlays = {
            'Topology Links': this._topologyLayer,
            'Coverage View': this._coverageLayer,
        };
        L.control.layers(null, overlays, { position: 'topright', collapsed: false }).addTo(this._map);

        this._map.on('overlayadd', (e) => {
            if (e.layer === this._topologyLayer) {
                this._topologyVisible = true;
                this._loadTopology();
            }
            if (e.layer === this._coverageLayer) {
                this._coverageVisible = true;
                this._loadCoverage();
            }
        });
        this._map.on('overlayremove', (e) => {
            if (e.layer === this._topologyLayer) {
                this._topologyVisible = false;
                if (this._topologyHintEl) this._topologyHintEl.hidden = true;
            }
            if (e.layer === this._coverageLayer) {
                this._coverageVisible = false;
            }
        });
    }

    async _loadTopology() {
        try {
            let links = [];
            let unplotted = [];
            let estimates = [];

            if (this._store) {
                await this._store.refreshFromApi();
                const snap = this._store.getSnapshot();
                links = (snap.edges || []).map((e) => ({
                    source: e.nodeA,
                    target: e.nodeB,
                    rssi: e.rssi,
                    snr: e.snr,
                    edge_type: e.edge_type,
                }));
                unplotted = snap.unplotted || [];
                estimates = snap.estimates || [];
            } else {
                const res = await fetch('/api/analytics/topology?hours=24');
                if (!res.ok) {
                    console.warn('Topology overlay: API failed', res.status);
                    return;
                }
                const payload = await res.json();
                links = Array.isArray(payload)
                    ? payload
                    : (payload.edges || []);
                unplotted = (payload.unplotted || []).map((u) => ({
                    id: u.id,
                    label: u.label || u.id,
                    edge_count: u.edge_count || 0,
                    latest_rssi: u.latest_rssi,
                }));
                estimates = payload.estimates || [];
            }

            const stubPool = this._mergeUnplottedEdgeEndpoints(unplotted, links);
            this._renderDarkStubs(stubPool, estimates, true);

            this._topologyLayer.clearLayers();
            this._edgeLines?.clear?.();

            let drawn = 0;
            for (const link of links) {
                const src = _normNodeId(link.source || link.nodeA);
                const tgt = _normNodeId(link.target || link.nodeB);
                const srcLl = this._resolveLatLng(src);
                const tgtLl = this._resolveLatLng(tgt);
                if (!srcLl || !tgtLl) continue;
                drawn += 1;

                const color = link.edge_type === 'neighborinfo'
                    ? this._cssToken('--accent-cyan', '#06b6d4')
                    : '#f59e0b';
                const line = L.polyline(
                    [srcLl, tgtLl],
                    {
                        color,
                        weight: link.edge_type === 'neighborinfo' ? 2 : 1.5,
                        opacity: 0.75,
                        dashArray: link.edge_type === 'neighborinfo' ? null : '4, 4',
                    },
                );

                const rssiLabel = link.rssi != null ? `RSSI: ${link.rssi} dBm` : '';
                const snrLabel = link.snr != null ? `SNR: ${link.snr} dB` : '';
                line.bindTooltip([
                    `${src} ↔ ${tgt}`,
                    rssiLabel,
                    snrLabel,
                ].filter(Boolean).join('<br>'));

                this._topologyLayer.addLayer(line);
            }

            this._updateTopologyHint(links.length, drawn);
        } catch (e) {
            console.error('Topology load failed:', e);
        }
    }

    refreshTopologyOverlay() {
        if (this._topologyEnabled) {
            this.renderTopology();
        } else if (this._topologyVisible) {
            this._loadTopology();
        }
    }

    setStore(store) {
        if (this._unsubStore) {
            this._unsubStore();
            this._unsubStore = null;
        }
        this._store = store || null;
        if (this._topologyEnabled && this._store) {
            this._unsubStore = this._store.onChange(() => {
                this.renderTopology();
            });
            this.renderTopology();
        }
    }

    setLocalNodeId(nodeId) {
        this._localNodeId = nodeId ? _normNodeId(nodeId) : null;
        if (this._topologyEnabled) this.renderTopology();
    }

    _resolveLatLng(nodeId) {
        const id = _normNodeId(nodeId);
        if (!id) return null;
        const marker = this._markers[id];
        if (marker) return marker.getLatLng();
        const stub = this._darkStubMarkers.get(id);
        if (stub) return stub.getLatLng();
        if (this._localNodeId && id === this._localNodeId && this._deviceMarker) {
            return this._deviceMarker.getLatLng();
        }
        const coords = this._lookupNodeCoords(id);
        if (coords) return L.latLng(coords.lat, coords.lng);
        return null;
    }

    _lookupNodeCoords(id) {
        if (this._store?.getNodeCoords) {
            const stored = this._store.getNodeCoords(id);
            if (stored) return stored;
        }
        const mesh = this._lastNodes?.find(
            (n) => _normNodeId(n.node_id || n.id) === id,
        );
        if (mesh && _isValidGps(mesh.latitude, mesh.longitude)) {
            return { lat: Number(mesh.latitude), lng: Number(mesh.longitude) };
        }
        return null;
    }

    _ensureMarkersPlotted(nodes) {
        for (const n of nodes || []) {
            const id = _normNodeId(n.node_id || n.id);
            if (!id || this._markers[id]) continue;
            const lat = n.latitude ?? n.lat;
            const lon = n.longitude ?? n.lng;
            if (!_isValidGps(lat, lon)) continue;
            this._addNodeMarker({ ...n, latitude: lat, longitude: lon });
        }
    }

    refitToMarkers() {
        if (!this._map) return;
        const bounds = [];
        if (this._deviceMarker) {
            bounds.push(this._deviceMarker.getLatLng());
        }
        for (const marker of Object.values(this._markers)) {
            bounds.push(marker.getLatLng());
        }
        for (const stub of this._darkStubMarkers.values()) {
            bounds.push(stub.getLatLng());
        }
        if (!bounds.length) return;
        if (bounds.length > 1) {
            this._map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 14 });
        } else {
            this._map.setView(bounds[0], 13);
        }
        this._hasFitBounds = true;
    }

    _mergeUnplottedEdgeEndpoints(unplotted, edges) {
        const byId = new Map(
            (unplotted || []).map((u) => [_normNodeId(u.id), { ...u, id: _normNodeId(u.id) }]),
        );
        for (const edge of edges || []) {
            for (const raw of [edge.nodeA, edge.nodeB, edge.source, edge.target]) {
                const id = _normNodeId(raw);
                if (!id || this._resolveLatLng(id)) continue;
                if (!byId.has(id)) {
                    byId.set(id, {
                        id,
                        label: `!${id.slice(-4)}`,
                        edge_count: 1,
                        latest_rssi: null,
                    });
                }
            }
        }
        return [...byId.values()];
    }

    _buildMapChrome() {
        if (!this._mapWrap || !this._topologyEnabled) return;

        this._badgesEl = document.createElement('div');
        this._badgesEl.className = 'map-status-badges';
        this._badgesEl.innerHTML = `
            <span class="map-status-badge">Nodes <strong id="map-badge-nodes">0</strong></span>
            <span class="map-status-badge">Links <strong id="map-badge-links">0</strong></span>
            <span class="map-status-badge">Dark <strong id="map-badge-dark">0</strong></span>
            <span class="map-status-badge map-status-badge--warn" id="map-badge-warn" hidden>
                ⚠ <strong id="map-badge-warn-txt"></strong>
            </span>
        `;
        this._mapWrap.appendChild(this._badgesEl);

        this._modeBarEl = document.createElement('div');
        this._modeBarEl.className = 'map-mode-bar';
        this._modeBarEl.innerHTML = `
            <button type="button" class="map-mode-btn map-mode-btn--active" data-mode="topology">Topology</button>
            <button type="button" class="map-mode-btn" data-mode="signal">Signal</button>
            <button type="button" class="map-mode-btn" data-mode="hop">Hop paths</button>
            <button type="button" class="map-mode-btn" data-mode="coverage">Coverage</button>
        `;
        this._mapWrap.appendChild(this._modeBarEl);

        this._modeBarEl.querySelectorAll('[data-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                this._modeBarEl.querySelectorAll('[data-mode]').forEach((b) => {
                    b.classList.toggle('map-mode-btn--active', b === btn);
                });
                if (this._store) {
                    this._store.mapMode = mode;
                    if (mode === 'coverage') {
                        this._store.layers.coverage = true;
                        this._setCoverageVisible(true);
                    } else if (this._coverageVisible) {
                        this._store.layers.coverage = false;
                        this._setCoverageVisible(false);
                    }
                    this._store.notifyChange();
                }
            });
        });

        const stripHost = document.getElementById('topo-map-status-host');
        if (stripHost && window.StatusStrip) {
            this._statusStrip = new window.StatusStrip(stripHost, 'TOPO');
            this._statusStrip.mount();
        }
    }

    _cssToken(name, fallback) {
        return getComputedStyle(document.documentElement)
            .getPropertyValue(name).trim() || fallback;
    }

    _nodesForMapMarkers(nodes) {
        const filter = window.MeshpointNodeCardsSort
            ? window.MeshpointNodeCardsSort.readSavedFilter()
            : 'all';
        if (filter === 'all' || !window.MeshpointNodeCardsSort) {
            return nodes;
        }
        return window.MeshpointNodeCardsSort.applyFilter(nodes, filter);
    }

    _loadSavedView() {
        try {
            const raw = localStorage.getItem(this._viewStorageKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const lat = Number(parsed.lat);
            const lon = Number(parsed.lon);
            const zoom = Number(parsed.zoom);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(zoom)) {
                return null;
            }
            if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
            if (zoom < 0 || zoom > 19) return null;
            return { center: [lat, lon], zoom };
        } catch (_e) {
            return null;
        }
    }

    _saveCurrentView() {
        if (!this._map) return;
        try {
            const c = this._map.getCenter();
            localStorage.setItem(this._viewStorageKey, JSON.stringify({
                lat: c.lat,
                lon: c.lng,
                zoom: this._map.getZoom(),
            }));
        } catch (_e) {
            /* best-effort */
        }
    }

    loadNodes(nodes, device) {
        if (!this._initialized) return;

        this._lastNodes = nodes;
        this._lastDevice = device;

        this._markerGroup.clearLayers();
        this._markers = {};

        const bounds = [];

        if (device && device.latitude && device.longitude) {
            this._addDeviceMarker(device);
            bounds.push([device.latitude, device.longitude]);
        }

        const mapNodes = this._nodesForMapMarkers(nodes);
        for (const n of mapNodes) {
            const lat = n.latitude;
            const lon = n.longitude;
            if (!_isValidGps(lat, lon)) continue;

            bounds.push([lat, lon]);
            this._addNodeMarker(n);
        }

        if (!this._hasFitBounds && bounds.length > 0) {
            if (bounds.length > 1) {
                this._map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
            } else {
                this._map.setView(bounds[0], 13);
            }
            this._hasFitBounds = true;
        }

        if (this._topologyEnabled) {
            this.renderTopology();
        } else if (this._topologyVisible) {
            this._loadTopology();
        }
    }

    renderTopology() {
        if (!this._topologyEnabled || !this._initialized || !this._store) return;

        const snap = this._store.getSnapshot();
        const showEdges = this._store.layers.edges !== false;
        const showDark = this._store.layers.darkStubs !== false;
        const showLabels = this._store.layers.labels !== false;
        const mode = this._store.mapMode || 'topology';

        if (this._store.layers.coverage) {
            this._setCoverageVisible(true);
        }

        this._ensureMarkersPlotted(this._store.getPlottedMeshNodes?.() || []);
        const stubPool = this._mergeUnplottedEdgeEndpoints(
            snap.unplotted,
            snap.edges || [],
        );
        this._renderDarkStubs(stubPool, snap.estimates || [], showDark);
        this._renderEdges(snap.edges, showEdges, mode);
        this._renderRoutePaths(snap.routes, showEdges && mode !== 'coverage');
        this._updateLabels(showLabels);
        this._updateBadges(snap);
        this._updateStatusStrip(snap);
    }

    _renderEdges(edges, showEdges, mode) {
        if (!showEdges || mode === 'coverage') {
            this._topologyLayer.clearLayers();
            this._edgeLines.clear();
            this._updateTopologyHint(edges.length, 0);
            return;
        }

        const activeKeys = new Set();
        let drawn = 0;

        for (const edge of edges) {
            const srcLl = this._resolveLatLng(edge.nodeA);
            const tgtLl = this._resolveLatLng(edge.nodeB);
            if (!srcLl || !tgtLl) continue;

            drawn += 1;
            activeKeys.add(edge.key);

            const color = this._resolveEdgeColor(edge, mode);
            const weight = this._store.edgeWeight(edge);
            const dash = this._store.edgeDash(edge);
            const latlngs = [srcLl, tgtLl];

            if (this._edgeLines.has(edge.key)) {
                const line = this._edgeLines.get(edge.key);
                line.setLatLngs(latlngs);
                line.setStyle({ color, weight, dashArray: dash, opacity: 0.85 });
            } else {
                const line = L.polyline(latlngs, {
                    color,
                    weight,
                    opacity: 0.85,
                    dashArray: dash,
                    lineCap: 'round',
                });
                line.bindTooltip(this._edgeTooltip(edge), {
                    sticky: true,
                    className: 'map-edge-tooltip',
                });
                line.addTo(this._topologyLayer);
                this._edgeLines.set(edge.key, line);
            }
        }

        for (const [key, line] of this._edgeLines) {
            if (!activeKeys.has(key)) {
                this._topologyLayer.removeLayer(line);
                this._edgeLines.delete(key);
            }
        }

        this._updateTopologyHint(edges.length, drawn);
    }

    _renderRoutePaths(routes, showRoutes) {
        this._routeLayer.clearLayers();
        this._routeLines = [];
        for (const lines of this._hopSegmentLines.values()) {
            for (const line of lines) {
                this._routeLayer.removeLayer(line);
            }
        }
        this._hopSegmentLines.clear();
        if (!showRoutes || !routes?.length) return;

        const selected = this._store?.selectedNodeId;
        const pool = selected
            ? routes.filter((r) => (r.route || []).includes(selected))
            : routes;
        const now = Date.now();
        const hopLiveMs = 120_000;

        for (const route of pool.slice(0, 12)) {
            const path = route.route || [];
            const snrTowards = route.snr_towards || [];
            const routeTs = route.ts
                || (route.last_seen ? new Date(route.last_seen).getTime() : 0);
            const isRecent = routeTs > 0 && (now - routeTs) < hopLiveMs;
            const routeKey = `rt:${path.join('>')}`;

            let drewSegment = false;
            for (let i = 0; i < path.length - 1; i += 1) {
                const a = this._resolveLatLng(path[i]);
                const b = this._resolveLatLng(path[i + 1]);
                if (!a || !b) continue;

                const snr = snrTowards[i];
                const color = this._snrHopColor(snr);
                const line = L.polyline([a, b], {
                    color,
                    weight: 4,
                    opacity: 0.9,
                    lineCap: 'round',
                    className: isRecent ? 'topo-hop-live' : '',
                });
                const snrTxt = snr != null ? `${Number(snr).toFixed(1)} dB` : '—';
                line.bindTooltip(`Hop ${i + 1}→${i + 2}<br>SNR: ${snrTxt}`, {
                    sticky: true,
                    className: 'map-edge-tooltip',
                });
                line.addTo(this._routeLayer);
                if (!this._hopSegmentLines.has(routeKey)) {
                    this._hopSegmentLines.set(routeKey, []);
                }
                this._hopSegmentLines.get(routeKey).push(line);
                this._routeLines.push(line);
                drewSegment = true;
            }

            if (!drewSegment && path.length >= 2) {
                const latlngs = [];
                for (const hop of path) {
                    const ll = this._resolveLatLng(hop);
                    if (ll) latlngs.push(ll);
                }
                if (latlngs.length >= 2) {
                    const line = L.polyline(latlngs, {
                        color: this._cssToken('--accent-amber', '#f59e0b'),
                        weight: 3,
                        opacity: 0.72,
                        dashArray: '10, 6',
                        lineCap: 'round',
                        className: isRecent ? 'topo-hop-live' : '',
                    });
                    const hops = path.map((h) => `!${_normNodeId(h).slice(-4)}`).join(' → ');
                    line.bindTooltip(`Traceroute<br>${hops}`, {
                        sticky: true,
                        className: 'map-edge-tooltip',
                    });
                    line.addTo(this._routeLayer);
                    this._routeLines.push(line);
                }
            }
        }
    }

    _snrHopColor(snr) {
        if (snr == null) return this._cssToken('--text-muted', '#64748b');
        if (snr > 10) return this._cssToken('--accent-green', '#00e5a0');
        if (snr > 5) return '#a3e635';
        if (snr > 0) return this._cssToken('--accent-amber', '#f59e0b');
        return this._cssToken('--accent-red', '#ef4444');
    }

    _resolveEdgeColor(edge, mode) {
        if (mode === 'signal') {
            const snr = edge.snr;
            if (snr == null) return this._cssToken('--text-muted', '#64748b');
            if (snr > 5) return this._cssToken('--accent-green', '#00e5a0');
            if (snr >= 0) return this._cssToken('--accent-amber', '#f59e0b');
            return this._cssToken('--accent-red', '#ef4444');
        }
        const rssi = edge.rssi;
        if (rssi == null) {
            return edge.edge_type === 'neighborinfo'
                ? this._cssToken('--accent-cyan', '#06b6d4')
                : this._cssToken('--accent-amber', '#f59e0b');
        }
        if (rssi > -90) return this._cssToken('--accent-green', '#00e5a0');
        if (rssi > -110) return this._cssToken('--accent-amber', '#f59e0b');
        return this._cssToken('--accent-red', '#ef4444');
    }

    _edgeTooltip(edge) {
        const nameA = this._nodeLabel(edge.nodeA);
        const nameB = this._nodeLabel(edge.nodeB);
        const rssi = edge.rssi != null ? `${edge.rssi} dBm` : '—';
        const snr = edge.snr != null ? `${edge.snr} dB` : '—';
        const age = this._formatRelativeTime(edge.ts);
        return `${nameA} ↔ ${nameB}<br>RSSI: ${rssi} · SNR: ${snr}<br>${edge.edge_type || edge.source_kind || 'link'} · ${age}`;
    }

    _nodeLabel(nodeId) {
        const id = _normNodeId(nodeId);
        const mesh = this._lastNodes?.find(
            (n) => _normNodeId(n.node_id || n.id) === id,
        );
        if (mesh) return mesh.long_name || mesh.display_name || mesh.short_name || nodeId;
        const stored = this._store?.getSnapshot()?.nodes?.find((n) => _normNodeId(n.id) === id);
        return stored?.label || nodeId;
    }

    _renderDarkStubs(unplotted, estimates, showDark) {
        this._darkStubLayer.clearLayers();
        this._darkOrbitLayer.clearLayers();
        this._darkStubMarkers.clear();

        if (!showDark || !unplotted?.length) {
            if (this._map.hasLayer(this._darkStubLayer)) {
                this._map.removeLayer(this._darkStubLayer);
            }
            return;
        }

        const estimateById = new Map(
            (estimates || []).map((e) => [_normNodeId(e.id), e]),
        );
        const device = this._lastDevice;
        const hasDeviceGps = device?.latitude && device?.longitude;
        const stubCenter = hasDeviceGps ? [device.latitude, device.longitude] : null;

        let stubIndex = 0;
        let usedStubRing = false;

        for (const node of unplotted.slice(0, 32)) {
            const nid = _normNodeId(node.id);
            const est = estimateById.get(nid);
            let pos;
            let popupNote;

            if (est?.lat != null && est.lng != null) {
                pos = [est.lat, est.lng];
                popupNote = `Estimated (${est.method || 'inference'}) · ±${Math.round(est.radius_m || 500)} m`;
                if (est.radius_m) {
                    L.circle(pos, {
                        radius: est.radius_m,
                        color: '#9b8aff',
                        weight: 1,
                        fillColor: '#9b8aff',
                        fillOpacity: 0.08,
                        dashArray: '4, 4',
                    }).addTo(this._darkOrbitLayer);
                }
            } else if (stubCenter) {
                if (!usedStubRing) {
                    L.circle(stubCenter, {
                        radius: 450,
                        className: 'dark-stub-orbit',
                        color: '#9b8aff',
                        weight: 1,
                        fill: false,
                        dashArray: '4, 4',
                        opacity: 0.45,
                    }).addTo(this._darkOrbitLayer);
                    usedStubRing = true;
                }
                pos = this._stubPosition(stubCenter, node.id, stubIndex);
                stubIndex += 1;
                popupNote = '<em>Stub position — not a GPS fix</em>';
            } else {
                continue;
            }

            const marker = L.marker(pos, {
                icon: L.divIcon({
                    html: '<div class="dark-stub-marker dark-stub-marker--unknown"><span>?</span></div>',
                    className: '',
                    iconSize: [18, 18],
                    iconAnchor: [9, 9],
                }),
                zIndexOffset: 200,
            });
            marker.bindPopup(
                `<strong>${this._esc(node.label)}</strong><br>` +
                `GPS: off / unplotted<br>` +
                `Links: ${node.edge_count || 0}<br>` +
                `RSSI: ${node.latest_rssi != null ? `${node.latest_rssi} dBm` : '—'}<br>` +
                popupNote,
            );
            marker.on('click', () => {
                if (this._store) this._store.setSelectedNode(nid);
            });
            marker.addTo(this._darkStubLayer);
            this._darkStubMarkers.set(nid, marker);
        }

        if (!this._map.hasLayer(this._darkStubLayer) && this._darkStubMarkers.size) {
            this._map.addLayer(this._darkStubLayer);
        }
    }

    _stubPosition(center, nodeId, index) {
        const angle = this._hashAngle(nodeId) + (index * 0.35);
        const radiusM = 320 + (index % 6) * 65;
        const latRad = center[0] * Math.PI / 180;
        const dLat = (radiusM / 111320) * Math.cos(angle);
        const dLng = (radiusM / (111320 * Math.cos(latRad || 1e-6))) * Math.sin(angle);
        return [center[0] + dLat, center[1] + dLng];
    }

    _hashAngle(str) {
        let h = 0;
        const s = String(str);
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) >>> 0;
        }
        return (h % 360) * Math.PI / 180;
    }

    _updateLabels(showLabels) {
        for (const [id, marker] of this._markers) {
            if (!showLabels) {
                marker.unbindTooltip();
                continue;
            }
            const mesh = this._lastNodes?.find(
                (n) => _normNodeId(n.node_id || n.id) === id,
            );
            const name = mesh?.short_name || mesh?.long_name?.slice(0, 6) || id.slice(-4);
            marker.unbindTooltip();
            marker.bindTooltip(name, {
                permanent: true,
                direction: 'top',
                offset: [0, -8],
                opacity: 0.9,
            });
            if (marker.openTooltip) marker.openTooltip();
        }
    }

    _updateBadges(snap) {
        const nodesEl = document.getElementById('map-badge-nodes');
        const linksEl = document.getElementById('map-badge-links');
        const darkEl = document.getElementById('map-badge-dark');
        const warnWrap = document.getElementById('map-badge-warn');
        const warnTxt = document.getElementById('map-badge-warn-txt');
        if (nodesEl) nodesEl.textContent = String(snap.mapped ?? snap.nodes?.length ?? 0);
        if (linksEl) linksEl.textContent = String(snap.edges.length);
        if (darkEl) darkEl.textContent = String(snap.dark);

        const unplottedEl = document.getElementById('map-unplotted');
        if (unplottedEl) {
            if (snap.dark > 0) {
                unplottedEl.hidden = false;
                unplottedEl.classList.add('map-unplotted--visible');
                unplottedEl.textContent = `${snap.dark} unplotted`;
            } else {
                unplottedEl.hidden = true;
                unplottedEl.classList.remove('map-unplotted--visible');
                unplottedEl.textContent = '';
            }
        }

        if (warnWrap && warnTxt) {
            if (snap.poor_edges > 0) {
                warnWrap.hidden = false;
                warnTxt.textContent = `${snap.poor_edges} poor link${snap.poor_edges > 1 ? 's' : ''}`;
            } else {
                warnWrap.hidden = true;
            }
        }
    }

    _updateStatusStrip(snap) {
        if (!this._statusStrip) return;
        const sources = (snap.edge_sources || []).join('+') || 'awaiting data';
        this._statusStrip.update(
            [
                `${snap.mapped} mapped`,
                `${snap.edges.length} links`,
                `${snap.dark} dark`,
                `${snap.hours}h window`,
                sources,
            ],
            snap.fetched_at,
        );
    }

    _addDeviceMarker(device) {
        if (this._deviceMarker) {
            const cur = this._deviceMarker.getLatLng();
            if (
                Math.abs(cur.lat - device.latitude) < 1e-6
                && Math.abs(cur.lng - device.longitude) < 1e-6
            ) {
                return;
            }
            this._map.removeLayer(this._deviceMarker);
        }

        this._deviceMarker = L.marker([device.latitude, device.longitude], {
            icon: L.divIcon({
                html: '<div class="device-marker"></div>',
                className: '',
                iconSize: [16, 16],
                iconAnchor: [8, 8],
            }),
            zIndexOffset: 1000,
        });

        const name = device.device_name || 'Meshpoint';
        this._deviceMarker.bindPopup(
            `<strong>${this._esc(name)}</strong><br>` +
            `Type: Meshpoint base<br>` +
            `Lat: ${device.latitude.toFixed(4)}<br>` +
            `Lon: ${device.longitude.toFixed(4)}`,
        );

        this._deviceMarker.addTo(this._map);
    }

    _addNodeMarker(n) {
        const nodeId = _normNodeId(n.node_id || n.id);
        if (!nodeId) return;

        const isMeshtastic = (n.protocol || 'meshtastic') === 'meshtastic';
        const protoColor = isMeshtastic ? '#06b6d4' : '#a855f7';

        const heard = n.last_heard || n.last_seen;
        const isRecent = heard && (Date.now() - new Date(heard).getTime()) < 60000;
        const isFav = !!(window.MeshpointNodeFavorites && window.MeshpointNodeFavorites.has(nodeId));
        const isSelected = this._store?.selectedNodeId === nodeId;

        let marker;
        if (isMeshtastic) {
            let borderColor = protoColor;
            if (isFav) borderColor = '#f59e0b';
            if (isRecent) borderColor = '#00ff88';
            if (isSelected) borderColor = '#e2e8f0';
            marker = L.circleMarker([n.latitude, n.longitude], {
                radius: isSelected ? 8 : 6,
                fillColor: protoColor,
                fillOpacity: 0.8,
                color: borderColor,
                weight: (isRecent || isFav || isSelected) ? 2 : 1,
                className: isRecent ? 'node-pulse' : '',
            });
            marker._meshpointKind = 'circle';
        } else {
            const recentClass = isRecent ? ' node-marker__diamond--recent' : '';
            const favClass = isFav ? ' node-marker__diamond--fav' : '';
            marker = L.marker([n.latitude, n.longitude], {
                icon: L.divIcon({
                    html: `<div class="node-marker__diamond${favClass}${recentClass}"></div>`,
                    className: '',
                    iconSize: [12, 12],
                    iconAnchor: [6, 6],
                }),
            });
            marker._meshpointKind = 'diamond';
        }

        const name = n.long_name || n.name || nodeId || '--';
        const rssi = (n.rssi ?? n.latest_rssi) != null
            ? `${Number(n.rssi ?? n.latest_rssi).toFixed(0)} dBm` : '--';
        const lastHeard = this._formatRelativeTime(heard);

        marker.bindPopup(
            `<strong>${this._esc(name)}</strong><br>` +
            `Protocol: ${n.protocol || 'meshtastic'}<br>` +
            `RSSI: ${rssi}<br>` +
            `Last heard: ${lastHeard}`,
        );

        marker.on('click', () => {
            if (this._store) this._store.setSelectedNode(nodeId);
        });

        this._markerGroup.addLayer(marker);
        this._markers[nodeId] = marker;
    }

    _formatRelativeTime(timestamp) {
        if (!timestamp) return 'unknown';
        const t = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
        if (Number.isNaN(t)) return 'unknown';
        const diffMs = Date.now() - t;
        if (diffMs < 0) return 'just now';
        const sec = Math.floor(diffMs / 1000);
        if (sec < 60) return `${sec}s ago`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        return `${Math.floor(hr / 24)}d ago`;
    }

    drawFocusLine(sourceNodeId) {
        this.clearFocusLine();
        if (!this._initialized || !this._deviceMarker) return;
        const srcLl = this._resolveLatLng(sourceNodeId);
        if (!srcLl) return;

        this._focusLine = L.polyline(
            [srcLl, this._deviceMarker.getLatLng()],
            { color: '#f59e0b', weight: 3, opacity: 0.9 },
        ).addTo(this._map);
    }

    clearFocusLine() {
        if (this._focusLine) {
            this._map.removeLayer(this._focusLine);
            this._focusLine = null;
        }
    }

    centerOn(lat, lng, zoom = 15) {
        if (this._map) this._map.flyTo([lat, lng], zoom);
    }

    _wireResizeRecalc() {
        if (!this._map) return;

        requestAnimationFrame(() => {
            if (this._map) this._map.invalidateSize();
        });

        let resizeTimer = null;
        const recalc = () => {
            if (this._map) this._map.invalidateSize();
        };

        window.addEventListener('resize', () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(recalc, 150);
        });

        document.addEventListener('sidebar:routeActivated', (event) => {
            if (event.detail && event.detail.route === 'dashboard') {
                requestAnimationFrame(recalc);
            }
        });

        if (typeof ResizeObserver === 'function') {
            const el = document.getElementById(this._containerId);
            if (el) {
                this._resizeObserver = new ResizeObserver(() => {
                    if (resizeTimer) clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(recalc, 150);
                });
                this._resizeObserver.observe(el);
            }
        }
    }

    updateFromPacket(packet) {
        if (!packet.source_id || !this._initialized) return;

        const sourceId = _normNodeId(packet.source_id);
        const payload = packet.decoded_payload || {};
        const type = (packet.packet_type || '').toLowerCase();
        const lat = payload.latitude ?? payload.adv_lat;
        const lon = payload.longitude ?? payload.adv_lon;
        const hasCoords = _isValidGps(lat, lon);

        if (!this._markers[sourceId] && hasCoords
            && (type === 'nodeinfo' || type === 'position')) {
            const node = {
                node_id: sourceId,
                latitude: lat,
                longitude: lon,
                protocol: packet.protocol || 'meshtastic',
                long_name: payload.long_name || payload.short_name,
                last_heard: packet.timestamp,
                latest_rssi: packet.rssi ?? packet.signal?.rssi,
            };
            this._addNodeMarker(node);
            if (Array.isArray(this._lastNodes)) {
                const idx = this._lastNodes.findIndex(
                    (n) => _normNodeId(n.node_id || n.id) === sourceId,
                );
                if (idx >= 0) {
                    this._lastNodes[idx] = { ...this._lastNodes[idx], ...node };
                } else {
                    this._lastNodes.push(node);
                }
            } else {
                this._lastNodes = [node];
            }
            this.refreshTopologyOverlay();
            return;
        }

        if (hasCoords && type === 'position') {
            const mesh = this._lastNodes?.find(
                (n) => _normNodeId(n.node_id || n.id) === sourceId,
            );
            if (mesh) {
                mesh.latitude = lat;
                mesh.longitude = lon;
            }
            this.refreshTopologyOverlay();
        }

        const marker = this._markers[sourceId];
        if (!marker) return;

        const isMeshtastic = (packet.protocol || 'meshtastic') === 'meshtastic';
        const proto = isMeshtastic ? '#06b6d4' : '#a855f7';

        if (marker._meshpointKind === 'diamond') {
            const el = marker.getElement()?.querySelector('.node-marker__diamond');
            if (el) el.classList.add('node-marker__diamond--recent');
            this._drawPacketLine(marker);
            setTimeout(() => {
                const el2 = marker.getElement()?.querySelector('.node-marker__diamond');
                if (el2) el2.classList.remove('node-marker__diamond--recent');
            }, 5000);
            return;
        }

        marker.setStyle({ color: '#00ff88', weight: 2 });
        this._drawPacketLine(marker);
        setTimeout(() => {
            const isFav = !!(window.MeshpointNodeFavorites
                && window.MeshpointNodeFavorites.has(packet.source_id));
            marker.setStyle({
                color: isFav ? '#f59e0b' : proto,
                weight: isFav ? 2 : 1,
            });
        }, 5000);
    }

    _drawPacketLine(sourceMarker) {
        if (!this._deviceMarker) return;
        const line = L.polyline(
            [sourceMarker.getLatLng(), this._deviceMarker.getLatLng()],
            {
                color: '#00e5a0',
                weight: 2,
                opacity: 0.8,
                dashArray: '6, 4',
                className: 'packet-line',
            },
        ).addTo(this._map);

        let opacity = 0.8;
        const fade = setInterval(() => {
            opacity -= 0.1;
            if (opacity <= 0) {
                clearInterval(fade);
                this._map.removeLayer(line);
            } else {
                line.setStyle({ opacity });
            }
        }, 200);
    }

    _setCoverageVisible(visible) {
        this._coverageVisible = visible;
        if (visible) {
            if (!this._map.hasLayer(this._coverageLayer)) {
                this._map.addLayer(this._coverageLayer);
            }
            this._loadCoverage();
        } else if (this._map.hasLayer(this._coverageLayer)) {
            this._map.removeLayer(this._coverageLayer);
        }
    }

    async _loadCoverage() {
        try {
            const res = await fetch('/api/nodes/coverage?hours=168');
            if (!res.ok) return;
            const data = await res.json();
            this._coverageLayer.clearLayers();

            const colors = {
                excellent: '#00e5a0',
                good: '#06b6d4',
                fair: '#f59e0b',
                poor: '#ef4444',
                unknown: '#64748b',
            };

            for (const node of data.plotted || []) {
                const quality = node.quality || 'unknown';
                const radius = Math.min(8000, Math.max(400, (node.packet_count || 1) * 25));
                const circle = L.circle(
                    [node.latitude, node.longitude],
                    {
                        radius,
                        color: colors[quality] || colors.unknown,
                        fillColor: colors[quality] || colors.unknown,
                        fillOpacity: 0.12,
                        weight: 1.5,
                        className: `coverage-circle coverage-circle--${quality}`,
                    },
                );
                const label = node.display_name || node.node_id;
                const rssi = node.avg_rssi != null ? `${node.avg_rssi} dBm avg` : 'no RSSI';
                circle.bindTooltip(`${label}<br>${rssi}<br>${node.packet_count || 0} pkts`);
                this._coverageLayer.addLayer(circle);
            }

            const unplottedEl = document.getElementById('map-unplotted');
            if (unplottedEl) {
                const count = data.unplotted_count || 0;
                if (count > 0) {
                    unplottedEl.hidden = false;
                    unplottedEl.textContent = `${count} unplotted`;
                    unplottedEl.classList.add('map-unplotted--visible');
                } else {
                    unplottedEl.hidden = true;
                    unplottedEl.classList.remove('map-unplotted--visible');
                }
            }
        } catch (e) {
            console.error('Coverage load failed:', e);
        }
    }

    _updateTopologyHint(totalLinks, drawnLinks) {
        if (!this._topologyHintEl) return;
        const active = this._topologyEnabled || this._topologyVisible;
        if (!active) return;
        const show = totalLinks > 0 && drawnLinks === 0;
        this._topologyHintEl.hidden = !show;
        if (show) {
            this._topologyHintEl.textContent =
                `${totalLinks} link(s) in graph — none drawn on map yet. `
                + 'Nodes need GPS coordinates (or dark stubs) at both ends.';
        }
    }

    _esc(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }
}
