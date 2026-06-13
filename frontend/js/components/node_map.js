/**
 * Leaflet map with marker clustering and smart topology overlays.
 */

const MAP_VIEW_STORAGE_KEY = 'meshpoint.nodeMap.view';
const MAP_DEFAULT_CENTER = [39.8, -98.5];
const MAP_DEFAULT_ZOOM = 4;

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
        this._darkStubMarkers = new Map();
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
            this._hasFitBounds = true;
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
            const res = await fetch('/api/analytics/topology?hours=24');
            if (!res.ok) return;
            const payload = await res.json();
            const links = Array.isArray(payload)
                ? payload
                : (payload.edges || []);
            this._topologyLayer.clearLayers();

            let drawn = 0;
            for (const link of links) {
                const src = link.source;
                const tgt = link.target;
                const srcMarker = this._markers[src];
                const tgtMarker = this._markers[tgt];
                if (!srcMarker || !tgtMarker) continue;
                drawn += 1;

                const line = L.polyline(
                    [srcMarker.getLatLng(), tgtMarker.getLatLng()],
                    {
                        color: '#f59e0b',
                        weight: 1.5,
                        opacity: 0.6,
                        dashArray: '4, 4',
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

    _buildMapChrome() {
        if (!this._mapWrap || !this._topologyEnabled) return;

        this._badgesEl = document.createElement('div');
        this._badgesEl.className = 'map-status-badges';
        this._badgesEl.innerHTML = `
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
            if (lat == null || lon == null) continue;

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

        this._renderEdges(snap.edges, showEdges, mode);
        this._renderDarkStubs(snap.unplotted, snap.estimates || [], showDark);
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
            const srcMarker = this._markers[edge.nodeA];
            const tgtMarker = this._markers[edge.nodeB];
            if (!srcMarker || !tgtMarker) continue;

            drawn += 1;
            activeKeys.add(edge.key);

            const color = this._resolveEdgeColor(edge, mode);
            const weight = this._store.edgeWeight(edge);
            const dash = this._store.edgeDash(edge);
            const latlngs = [srcMarker.getLatLng(), tgtMarker.getLatLng()];

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
        const mesh = this._lastNodes?.find((n) => n.node_id === nodeId);
        if (mesh) return mesh.long_name || mesh.display_name || mesh.short_name || nodeId;
        const stored = this._store?.getSnapshot()?.nodes?.find((n) => n.id === nodeId);
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

        const estimateById = new Map((estimates || []).map((e) => [e.id, e]));
        const device = this._lastDevice;
        const hasDeviceGps = device?.latitude && device?.longitude;
        const stubCenter = hasDeviceGps ? [device.latitude, device.longitude] : null;

        let stubIndex = 0;
        let usedStubRing = false;

        for (const node of unplotted.slice(0, 32)) {
            const est = estimateById.get(node.id);
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
                    html: '<div class="dark-stub-marker"></div>',
                    className: '',
                    iconSize: [10, 10],
                    iconAnchor: [5, 5],
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
                if (this._store) this._store.setSelectedNode(node.id);
            });
            marker.addTo(this._darkStubLayer);
            this._darkStubMarkers.set(node.id, marker);
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
            const mesh = this._lastNodes?.find((n) => n.node_id === id);
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
        const linksEl = document.getElementById('map-badge-links');
        const darkEl = document.getElementById('map-badge-dark');
        const warnWrap = document.getElementById('map-badge-warn');
        const warnTxt = document.getElementById('map-badge-warn-txt');
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
        const isMeshtastic = (n.protocol || 'meshtastic') === 'meshtastic';
        const protoColor = isMeshtastic ? '#06b6d4' : '#a855f7';

        const heard = n.last_heard || n.last_seen;
        const isRecent = heard && (Date.now() - new Date(heard).getTime()) < 60000;
        const isFav = !!(window.MeshpointNodeFavorites && window.MeshpointNodeFavorites.has(n.node_id));
        const isSelected = this._store?.selectedNodeId === n.node_id;

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

        const name = n.long_name || n.name || n.node_id || '--';
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
            if (this._store) this._store.setSelectedNode(n.node_id);
        });

        this._markerGroup.addLayer(marker);
        this._markers[n.node_id] = marker;
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
        const srcMarker = this._markers[sourceNodeId];
        if (!srcMarker) return;

        this._focusLine = L.polyline(
            [srcMarker.getLatLng(), this._deviceMarker.getLatLng()],
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

        const payload = packet.decoded_payload || {};
        const type = (packet.packet_type || '').toLowerCase();
        const lat = payload.latitude ?? payload.adv_lat;
        const lon = payload.longitude ?? payload.adv_lon;
        const hasCoords = lat != null && lon != null && !(lat === 0 && lon === 0);

        if (!this._markers[packet.source_id] && hasCoords
            && (type === 'nodeinfo' || type === 'position')) {
            const node = {
                node_id: packet.source_id,
                latitude: lat,
                longitude: lon,
                protocol: packet.protocol || 'meshtastic',
                long_name: payload.long_name || payload.short_name,
                last_heard: packet.timestamp,
                latest_rssi: packet.rssi ?? packet.signal?.rssi,
            };
            this._addNodeMarker(node);
            if (Array.isArray(this._lastNodes)) {
                this._lastNodes.push(node);
            } else {
                this._lastNodes = [node];
            }
            if (this._topologyEnabled) {
                this.renderTopology();
            }
            return;
        }

        const marker = this._markers[packet.source_id];
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
        const show = this._topologyVisible && totalLinks > 0 && drawnLinks === 0;
        this._topologyHintEl.hidden = !show;
    }

    _esc(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }
}
