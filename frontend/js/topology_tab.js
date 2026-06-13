/**
 * Topology tab — MeshSense-inspired three-panel operator workspace.
 *
 * [NODE ROSTER] | [MAP / GRAPH] | [SMART POLLER + INTEL]
 * [CHANNEL UTILIZATION BAR — full width bottom]
 */
class TopologyTab {
    constructor(containerId) {
        this._container = document.getElementById(containerId);
        this._hours = this._settings.get('hours') || 24;
        this._rendered = false;
        this._viewMode = 'map';
        this._observer = this._detectObserver();
        this._meshNodes = [];
        this._device = null;
        this._selectedNode = null;
        this._topoMap = null;
        this._fetchedAt = null;
        this._loading = false;

        this._settings = new TopologySettings();
        this._audio = new TopologyAudio(this._settings);
        this._poller = new SmartPoller({
            settings: this._settings,
            store: window.topologyStore,
            observer: this._observer,
            onAlert: (a) => this._intel?.pushAlert(a),
            onQueueChange: (queue, state) => this._intel?.updateQueueStatus(queue, state),
        });
        this._roster = null;
        this._intel = null;
        this._chBar = null;

        // D3 graph state (Graph view)
        this._simulation = null;
        this._graph = { nodes: [], edges: [], routes: [] };
        this._svg = null;
        this._zoomTransform = null;
        this._minSnr = -99;
        this._multiHop = true;
        this._hopFilterEnabled = false;
        this._hopLimit = 3;
        this._search = '';
        this._physics = { charge: -220, distance: 85, gravity: 0.08, frozen: false };
        this._centrality = {};
        this._statusStrip = null;
    }

    _detectObserver() {
        if (new URLSearchParams(location.search).has('observer')) return true;
        const role = window.sidebar?.identity?.role;
        return role === 'viewer';
    }

    async refresh() {
        if (!this._container) return;
        if (!this._rendered) {
            this._buildLayout();
            this._rendered = true;
        }
        this._setLoading(true);
        try {
            await this._loadData();
            this._renderAll();
        } catch (e) {
            console.error('Topology refresh failed:', e);
        } finally {
            this._setLoading(false);
        }
    }

    async _loadData() {
        const [topoRes, nodesRes, deviceRes] = await Promise.all([
            fetch(`/api/analytics/topology?hours=${this._hours}`),
            fetch('/api/nodes?enrich=true'),
            fetch('/api/device'),
        ]);
        if (topoRes.ok) {
            this._graph = await topoRes.json();
            this._fetchedAt = Date.now();
            if (window.topologyStore) {
                window.topologyStore.setHours(this._hours);
                window.topologyStore.loadFromApi(this._graph);
            }
        }
        const nodesData = nodesRes.ok ? await nodesRes.json() : { nodes: [] };
        this._meshNodes = nodesData.nodes || nodesData || [];
        this._device = deviceRes.ok ? await deviceRes.json() : null;
        if (window.topologyStore) {
            window.topologyStore.syncMeshNodes(this._meshNodes);
        }
        if (this._intel && this._device?.node_id) {
            this._intel.setDeviceId(this._device.node_id);
        }
    }

    _renderAll() {
        this._roster?.render(this._meshNodes);
        this._chBar?.refresh(this._hours);
        if (this._viewMode === 'map') {
            this._ensureTopoMap();
        } else {
            this._renderGraph();
        }
        this._intel?.setSelectedNode(this._selectedNode);
        this._updateStatusStrip();
    }

    _buildLayout() {
        const observerBanner = this._observer
            ? '<div class="topo-observer-banner">Observer mode: read-only access, TX and config actions disabled</div>'
            : '';

        this._container.innerHTML = `
            <div class="topo-workspace topo-workspace--meshsense">
                ${observerBanner}
                <div class="topo-three-panel">
                    <aside class="topo-panel topo-panel--roster" id="topo-roster-host"></aside>
                    <main class="topo-panel topo-panel--center">
                        <div class="topo-view topo-view--map topo-view--active" id="topo-view-map">
                            <div class="topo-map-panel">
                                <div id="topo-loading" class="topo-loading" hidden>Loading topology…</div>
                                <div id="topo-map" class="map-container"></div>
                            </div>
                        </div>
                        <div class="topo-view topo-view--graph" id="topo-view-graph" hidden>
                            <div class="topo-graph-toolbar">
                                <button type="button" class="topo-btn topo-btn--sm" id="topo-back-map">← Map</button>
                            </div>
                            <div class="topo-canvas-wrap">
                                <svg id="topo-svg" class="topo-svg" aria-label="Mesh topology graph"></svg>
                                <div id="topo-empty" class="topo-empty" hidden>No topology data in this window.</div>
                            </div>
                        </div>
                    </main>
                    <aside class="topo-panel topo-panel--intel" id="topo-intel-host"></aside>
                </div>
                <div id="topo-chbar-host" class="topo-chbar-host"></div>
            </div>
            <div id="topo-json-modal" class="topo-json-modal" hidden>
                <div class="topo-json-modal__backdrop"></div>
                <div class="topo-json-modal__panel" role="dialog" aria-label="Node JSON">
                    <header class="topo-json-modal__header">
                        <strong>Node JSON</strong>
                        <button type="button" class="topo-json-modal__close" id="topo-json-close">×</button>
                    </header>
                    <pre class="topo-json-modal__body" id="topo-json-body"></pre>
                </div>
            </div>
        `;

        const stripHost = document.getElementById('topo-status-strip-host');
        if (stripHost) stripHost.remove();

        this._roster = new TopologyRoster('topo-roster-host', {
            store: window.topologyStore,
            settings: this._settings,
            poller: this._poller,
            observer: this._observer,
            onSelect: (node) => this._selectNode(node),
            onAction: (act, node) => this._nodeAction(act, node),
        });

        this._intel = new TopologyIntel('topo-intel-host', {
            store: window.topologyStore,
            settings: this._settings,
            poller: this._poller,
            audio: this._audio,
            observer: this._observer,
        });
        this._intel.setOnAction((name) => this._intelAction(name));

        this._chBar = new TopologyChannelBar('topo-chbar-host');

        this._svg = typeof d3 !== 'undefined' ? d3.select('#topo-svg') : null;
        this._emptyEl = document.getElementById('topo-empty');

        document.getElementById('topo-json-close')?.addEventListener('click', () => this._hideJsonModal());
        document.querySelector('#topo-json-modal .topo-json-modal__backdrop')
            ?.addEventListener('click', () => this._hideJsonModal());
        document.getElementById('topo-back-map')?.addEventListener('click', () => this._setViewMode('map'));

        window.addEventListener('resize', () => {
            if (this._viewMode === 'graph') this._renderGraph();
            if (this._topoMap?._map) setTimeout(() => this._topoMap._map.invalidateSize(), 120);
        });
    }

    ingestPacket(packet) {
        const src = packet?.source_id;
        if (!src || !this._poller) return;
        const node = this._meshNodes.find((n) => (n.node_id || n.id) === src)
            || { node_id: src, id: src };
        this._poller.notePacket(node, packet);
        if ((packet.packet_type || '').toLowerCase() === 'traceroute' && packet.decoded_payload) {
            const route = packet.decoded_payload.route || [];
            const dest = route.length ? String(route[route.length - 1]) : src;
            this._poller.recordTraceReply(dest, packet.decoded_payload);
            if (this._rendered) {
                this._intel?.pushAlert({
                    type: 'route',
                    node_id: src,
                    node_name: src,
                    message: `Traceroute reply → !${dest.slice(-4)}`,
                });
                const mesh = this._meshNodes.find((n) => (n.node_id || n.id) === dest);
                if (mesh) {
                    this._selectedNode = mesh;
                    this._intel?.setSelectedNode(mesh);
                } else if (this._selectedNode) {
                    this._intel.setSelectedNode(this._selectedNode);
                }
            }
        }
    }

    _selectNode(node) {
        this._selectedNode = node;
        const id = node.node_id || node.id;
        if (window.topologyStore) window.topologyStore.setSelectedNode(id);
        this._roster?.setSelected(id);
        this._intel?.setSelectedNode(node);
        if (this._viewMode === 'map' && node.latitude && node.longitude) {
            this._topoMap?.centerOn(node.latitude, node.longitude);
        }
        if (this._viewMode === 'graph') this._renderGraph();
    }

    async _nodeAction(act, node) {
        const id = node.node_id || node.id;
        if (act === 'trace') {
            this._poller?.enqueue(id, 'manual', 10);
            return;
        }
        if (act === 'json') {
            this._showJsonModal(node);
            return;
        }
        if (act === 'center') {
            if (node.latitude && node.longitude) {
                this._topoMap?.centerOn(node.latitude, node.longitude);
            } else {
                this._intel?.pushAlert({
                    type: 'warn', node_id: id, node_name: id, message: 'No GPS for this node.',
                });
            }
            return;
        }
        if (act === 'position') {
            try {
                const res = await fetch(`/api/admin/nodes/${encodeURIComponent(id)}/config/request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ section: 'position' }),
                });
                const data = await res.json().catch(() => ({}));
                this._intel?.pushAlert({
                    type: res.ok ? 'info' : 'warn',
                    node_id: id,
                    node_name: node.display_name || id,
                    message: res.ok ? 'Position config request sent.' : (data.detail || 'Request failed'),
                });
            } catch (e) {
                this._intel?.pushAlert({ type: 'warn', node_id: id, message: String(e.message || e) });
            }
        }
    }

    _intelAction(name) {
        if (name === 'pollAll') {
            const n = this._poller?.pollAll(this._meshNodes) || 0;
            this._intel?.pushAlert({
                type: 'info', node_id: 'system', node_name: 'TOPOLOGY',
                message: `Queued ${n} trace${n === 1 ? '' : 's'}.`,
            });
            return;
        }
        if (name === 'pollRouters') {
            const n = this._poller?.pollAllRouters(this._meshNodes) || 0;
            this._intel?.pushAlert({
                type: 'info', node_id: 'system', node_name: 'TOPOLOGY',
                message: `Queued ${n} router trace${n === 1 ? '' : 's'}.`,
            });
            return;
        }
        if (name === 'export') {
            const data = window.topologyStore?.exportJson();
            if (!data) return;
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `meshpoint-topology-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this._intel?.pushAlert({ type: 'info', node_id: 'system', node_name: 'TOPOLOGY', message: 'Snapshot exported.' });
            return;
        }
        if (name === 'graph') {
            this._setViewMode('graph');
            return;
        }
        if (name === 'refresh' || name === 'hoursChanged') {
            this._hours = this._settings.get('hours') || 24;
            this.refresh();
            return;
        }
        if (name === 'inactChanged') {
            this._renderAll();
        }
    }

    _showJsonModal(node) {
        const modal = document.getElementById('topo-json-modal');
        const body = document.getElementById('topo-json-body');
        if (!modal || !body) return;
        body.textContent = JSON.stringify(node, null, 2);
        modal.hidden = false;
    }

    _hideJsonModal() {
        const modal = document.getElementById('topo-json-modal');
        if (modal) modal.hidden = true;
    }

    _setViewMode(mode) {
        this._viewMode = mode === 'graph' ? 'graph' : 'map';
        const mapView = document.getElementById('topo-view-map');
        const graphView = document.getElementById('topo-view-graph');
        const isMap = this._viewMode === 'map';
        if (mapView) {
            mapView.hidden = !isMap;
            mapView.classList.toggle('topo-view--active', isMap);
        }
        if (graphView) {
            graphView.hidden = isMap;
            graphView.classList.toggle('topo-view--active', !isMap);
        }
        if (isMap) this._ensureTopoMap();
        else this._renderGraph();
    }

    async _ensureTopoMap() {
        if (typeof NodeMap === 'undefined' || !window.topologyStore) return;
        if (!this._topoMap) {
            this._topoMap = new NodeMap('topo-map', {
                store: window.topologyStore,
                topology: true,
                viewStorageKey: 'meshpoint.topoMap.view',
                inactMin: this._settings.get('inactMin'),
            });
        }
        this._topoMap.loadNodes(this._filterActiveNodes(this._meshNodes), this._device);
        setTimeout(() => this._topoMap?._map?.invalidateSize(), 150);
    }

    _filterActiveNodes(nodes) {
        const inactMs = (this._settings.get('inactMin') || 60) * 60_000;
        const now = Date.now();
        return (nodes || []).filter((n) => {
            if (!n.last_seen) return true;
            const t = new Date(n.last_seen).getTime();
            return !Number.isFinite(t) || (now - t) <= inactMs;
        });
    }

    _setLoading(on) {
        this._loading = on;
        const el = document.getElementById('topo-loading');
        if (el) {
            el.hidden = !on;
            el.classList.toggle('topo-loading--visible', on);
        }
    }

    _updateStatusStrip() {
        /* Map HUD badges updated by NodeMap via topologyStore */
    }

    // ── D3 force graph (Graph view) ─────────────────────────────────────

    _filteredEdges() {
        let edges = (this._graph.edges || []).map((e) => ({ ...e }));
        if (!this._multiHop) edges = edges.filter((e) => e.edge_type === 'neighborinfo');
        return edges.filter((e) => {
            const snr = e.snr;
            if (snr == null) return this._minSnr <= -90;
            return snr >= this._minSnr;
        });
    }

    _renderGraph() {
        if (typeof d3 === 'undefined' || !this._svg) return;
        const wrap = this._container.querySelector('.topo-canvas-wrap');
        if (!wrap) return;

        const width = Math.max(wrap.clientWidth, 320);
        const height = Math.max(wrap.clientHeight, 320);
        let edges = this._filteredEdges();
        let nodes = (this._graph.nodes || []).map((n) => ({ ...n }));

        const sel = this._selectedNode?.node_id || this._selectedNode?.id;
        if (sel) {
            const connected = new Set([sel]);
            for (const e of edges) {
                if (String(e.source) === sel || String(e.target) === sel) {
                    connected.add(String(e.source));
                    connected.add(String(e.target));
                }
            }
            nodes = nodes.filter((n) => connected.has(n.id));
            edges = edges.filter((e) => connected.has(String(e.source)) && connected.has(String(e.target)));
        }

        if (!nodes.length && !edges.length) {
            this._svg.selectAll('*').remove();
            if (this._emptyEl) {
                this._emptyEl.hidden = false;
                this._emptyEl.textContent = `No links in the last ${this._hours}h.`;
            }
            return;
        }
        if (this._emptyEl) this._emptyEl.hidden = true;

        const accentCyan = '#06b6d4';
        const accentGreen = '#00e5a0';
        const accentAmber = '#f59e0b';

        const svg = this._svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', '100%').attr('height', height);
        svg.selectAll('*').remove();
        const g = svg.append('g');

        const zoom = d3.zoom().scaleExtent([0.2, 4]).on('zoom', (ev) => g.attr('transform', ev.transform));
        svg.call(zoom);

        const link = g.append('g').selectAll('line').data(edges).join('line')
            .attr('stroke', (d) => (d.edge_type === 'neighborinfo' ? accentCyan : accentAmber))
            .attr('stroke-width', (d) => (d.snr >= 5 ? 3 : d.snr >= 0 ? 2 : 1.5))
            .attr('stroke-opacity', 0.85);

        const node = g.append('g').selectAll('circle').data(nodes).join('circle')
            .attr('r', 8)
            .attr('fill', accentCyan)
            .attr('stroke', (d) => (d.id === sel ? accentGreen : '#0f172a'))
            .attr('stroke-width', (d) => (d.id === sel ? 2.5 : 1))
            .style('cursor', 'pointer')
            .on('click', (_, d) => {
                const mesh = this._meshNodes.find((n) => (n.node_id || n.id) === d.id);
                if (mesh) this._selectNode(mesh);
            });

        if (this._simulation) this._simulation.stop();
        this._simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(edges).id((d) => d.id).distance(85))
            .force('charge', d3.forceManyBody().strength(-220))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .on('tick', () => {
                link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
                    .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
                node.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
            });
    }
}

window.topologyTab = new TopologyTab('topology-panel');
