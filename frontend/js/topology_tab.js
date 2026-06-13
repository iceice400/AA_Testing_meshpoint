/**
 * Topology tab — MeshSense-inspired three-panel operator workspace.
 *
 * [NODE ROSTER] | [MAP / GRAPH] | [SMART POLLER + INTEL]
 * [CHANNEL UTILIZATION BAR — full width bottom]
 */
class TopologyTab {
    constructor(containerId) {
        this._container = document.getElementById(containerId);
        this._rendered = false;
        this._viewMode = 'map';
        this._observer = this._detectObserver();
        this._meshNodes = [];
        this._device = null;
        this._selectedNode = null;
        this._topologyStatus = null;
        this._topoMap = null;
        this._fetchedAt = null;
        this._loading = false;

        this._settings = new TopologySettings();
        this._hours = this._settings.get('hours') || 24;
        this._audio = new TopologyAudio(this._settings);
        this._storeRef = null;
        this._poller = new SmartPoller({
            settings: this._settings,
            store: null,
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
        this._localMeshNodeId = null;
        this._unsubStore = null;
        this._liveRefreshTimer = null;
        this._settingsUnsub = this._settings.onChange(() => this._onSettingsChange());
    }

    _onSettingsChange() {
        if (!this._rendered) return;
        const pf = this._settings.get('protocolFilter');
        this._topoMap?.setProtocolFilter(pf);
        this._roster?.render(this._meshNodes);
        if (this._viewMode === 'map') this._ensureTopoMap();
        else this._renderGraph();
    }

    _filterByProtocol(nodes) {
        const pf = this._settings?.get('protocolFilter') || 'all';
        if (window.TopologyProtocol?.filterNodes) {
            return window.TopologyProtocol.filterNodes(nodes, pf);
        }
        return nodes || [];
    }

    _detectObserver() {
        if (new URLSearchParams(location.search).has('observer')) return true;
        const role = window.sidebar?.identity?.role;
        return role === 'viewer';
    }

    /** Wire shared store after app.js boot (topology_tab.js loads before app.js). */
    bindStore(store) {
        if (!store) return;
        this._storeRef = store;
        if (this._poller) this._poller._store = store;
        if (this._roster) this._roster._store = store;
        if (this._intel) this._intel._store = store;
        if (this._intel) this._intel._syncStoreLayers?.();
        if (this._topoMap) {
            this._topoMap.setStore(store);
        }
        if (this._unsubStore) {
            this._unsubStore();
            this._unsubStore = null;
        }
        this._unsubStore = store.onChange(() => {
            if (this._viewMode === 'graph') this._renderGraph();
            if (this._topoMap && this._viewMode === 'map') this._topoMap.renderTopology();
            this._intel?.setSelectedNode(this._selectedNode);
        });
    }

    _store() {
        return this._storeRef || window.topologyStore || null;
    }

    /** Called from app.js when dashboard loads/refreshes nodes (single source of truth). */
    applyMeshNodes(nodes) {
        if (!Array.isArray(nodes) || !nodes.length) return;
        this._meshNodes = nodes;
        const store = this._store();
        if (store) store.syncMeshNodes(nodes);
        if (this._rendered) {
            this._roster?.render(this._meshNodes);
            if (this._viewMode === 'map') this._ensureTopoMap();
        }
    }

    async refresh() {
        if (!this._container) return;
        this.bindStore(this._store());
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
        const [topoRes, nodesRes, deviceRes, statusRes, configRes] = await Promise.all([
            fetch(`/api/analytics/topology?hours=${this._hours}`),
            fetch('/api/nodes?enrich=true&limit=500'),
            fetch('/api/device'),
            fetch('/api/analytics/topology/status', { credentials: 'same-origin' }),
            fetch('/api/config', { credentials: 'same-origin' }),
        ]);

        if (nodesRes.ok) {
            const nodesData = await nodesRes.json();
            this._meshNodes = TopologyTab._parseNodesResponse(nodesData);
            const store = this._store();
            if (store && this._meshNodes.length) {
                store.syncMeshNodes(this._meshNodes);
            }
        } else {
            console.warn('Topology tab: nodes API failed —', nodesRes.status);
            if (!this._meshNodes.length && this._store()?.getMeshNodeList) {
                this._meshNodes = this._store().getMeshNodeList();
            }
        }

        if (topoRes.ok) {
            this._graph = await topoRes.json();
            this._fetchedAt = Date.now();
            const store = this._store();
            if (store) {
                store.setHours(this._hours);
                store.loadFromApi(this._graph);
            }
        }

        this._device = deviceRes.ok ? await deviceRes.json() : null;
        if (this._intel && this._device?.node_id) {
            this._intel.setDeviceId(this._device.node_id);
        }
        if (statusRes.ok) {
            const status = await statusRes.json();
            const txReady = status.traceroute_available !== false && status.meshtastic_tx_enabled !== false;
            this._poller?.setTxReady(txReady);
            this._topologyStatus = status;
            this._intel?.setTopologyStatus(status);
        }
        if (configRes.ok) {
            const cfg = await configRes.json();
            const hex = cfg.transmit?.node_id_hex || '';
            this._localMeshNodeId = hex ? hex.replace(/^!/, '').toLowerCase() : null;
            if (this._topoMap) this._topoMap.setLocalNodeId(this._localMeshNodeId);
        }
    }

    _renderAll() {
        const store = this._store();
        const rosterNodes = this._meshNodes.length
            ? this._meshNodes
            : (store?.getMeshNodeList?.() || []);
        this._roster?.render(rosterNodes);
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
            store: null,
            settings: this._settings,
            poller: this._poller,
            observer: this._observer,
            onSelect: (node) => this._selectNode(node),
            onAction: (act, node) => this._nodeAction(act, node),
        });

        this._intel = new TopologyIntel('topo-intel-host', {
            store: null,
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

        this.bindStore(this._store());

        document.addEventListener('sidebar:routeActivated', (event) => {
            if (event.detail?.route !== 'topology') return;
            if (this._liveRefreshTimer) clearInterval(this._liveRefreshTimer);
            this._liveRefreshTimer = setInterval(() => this.refresh(), 60_000);
            setTimeout(() => {
                if (this._viewMode === 'map') this._ensureTopoMap();
            }, 100);
        });

        window.addEventListener('resize', () => {
            if (this._viewMode === 'graph') this._renderGraph();
            if (this._topoMap?._map) setTimeout(() => this._topoMap._map.invalidateSize(), 120);
        });
    }

    ingestPacket(packet) {
        const src = packet?.source_id;
        if (!src || !this._poller) return;

        const trace = window.TopologyTrace?.bestTraceRoute?.(packet);
        if (trace) {
            const dest = trace.route[trace.route.length - 1];
            this._poller.recordTraceReply(dest, trace);
            if (this._rendered) {
                const hops = window.TopologyTrace.hopCount(trace.route);
                this._intel?.pushAlert({
                    type: 'route',
                    node_id: dest,
                    node_name: dest,
                    message: `Traceroute reply — ${hops} hop(s), ${trace.route.length} nodes.`,
                });
                const mesh = this._meshNodes.find(
                    (n) => (n.node_id || n.id || '').replace(/^!/, '').toLowerCase() === dest,
                );
                if (mesh) {
                    this._selectNode(mesh);
                } else if (this._selectedNode) {
                    this._intel?.setSelectedNode(this._selectedNode);
                } else {
                    this._intel?._renderTraceView?.();
                }
                if (this._topoMap && this._viewMode === 'map') {
                    this._topoMap.renderTopology();
                }
            }
        }

        const srcNorm = src ? String(src).replace(/^!/, '').toLowerCase() : '';
        const node = this._meshNodes.find(
            (n) => String(n.node_id || n.id).replace(/^!/, '').toLowerCase() === srcNorm,
        ) || { node_id: srcNorm || src, id: srcNorm || src };
        this._poller.notePacket(node, packet);
    }

    _selectNode(node) {
        this._selectedNode = node;
        const id = node.node_id || node.id;
        const store = this._store();
        if (store) store.setSelectedNode(id);
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
            await this._poller?.traceNode(id, { force: true, reason: 'manual' });
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
            if (this._observer) {
                this._intel?.pushAlert({
                    type: 'warn', node_id: id, node_name: node.display_name || id,
                    message: 'Observer mode — position request disabled.',
                });
                return;
            }
            if (this._topologyStatus?.position_request_available === false) {
                this._intel?.pushAlert({
                    type: 'warn', node_id: id, node_name: node.display_name || id,
                    message: 'Meshtastic TX unavailable — enable onboard TX for position requests.',
                });
                return;
            }
            try {
                const res = await fetch(
                    `/api/analytics/topology/position/${encodeURIComponent(id)}`,
                    { method: 'POST', credentials: 'same-origin' },
                );
                const data = await res.json().catch(() => ({}));
                let message;
                if (res.status === 401 || res.status === 403) {
                    message = res.status === 403
                        ? 'Admin login required for position requests.'
                        : 'Sign in to request position.';
                } else if (res.ok) {
                    message = 'Position request sent — watch for POSITION reply.';
                } else {
                    message = data.detail || data.error || `Request failed (${res.status})`;
                }
                this._intel?.pushAlert({
                    type: res.ok ? 'info' : 'warn',
                    node_id: id,
                    node_name: node.display_name || id,
                    message,
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
            const data = this._store()?.exportJson();
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
        if (typeof NodeMap === 'undefined') return;
        const store = this._store();
        if (!store) {
            console.warn('Topology map: store not ready');
            return;
        }
        if (!this._topoMap) {
            this._topoMap = new NodeMap('topo-map', {
                store,
                topology: true,
                viewStorageKey: 'meshpoint.topoMap.view',
                inactMin: this._settings.get('inactMin'),
                localNodeId: this._localMeshNodeId,
                settings: this._settings,
            });
        } else {
            this._topoMap.setStore(store);
        }
        this._topoMap.setLocalNodeId(this._localMeshNodeId);
        this._topoMap.setProtocolFilter(this._settings.get('protocolFilter') || 'all');
        this._topoMap.loadNodes(this._filterByProtocol(this._meshNodes), this._device);
        this._topoMap.renderTopology();
        const refit = () => {
            this._topoMap?._map?.invalidateSize();
            if (this._topoMap && !this._topoMap._hasFitBounds
                && Object.keys(this._topoMap._markers || {}).length) {
                this._topoMap.refitToMarkers();
            }
        };
        setTimeout(refit, 150);
    }

    _filterActiveNodes(nodes) {
        const inactMs = (this._settings.get('inactMin') || 60) * 60_000;
        const now = Date.now();
        return (nodes || []).filter((n) => {
            const heard = n.last_heard || n.last_seen;
            if (!heard) return true;
            const t = new Date(heard).getTime();
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

        const pf = this._settings?.get('protocolFilter') || 'all';
        if (pf !== 'all' && window.TopologyProtocol?.matchesProtocolFilter) {
            const meshById = new Map(
                (this._meshNodes || []).map((n) => [
                    String(n.node_id || n.id).replace(/^!/, '').toLowerCase(),
                    n,
                ]),
            );
            nodes = nodes.filter((n) => {
                const mesh = meshById.get(String(n.id).replace(/^!/, '').toLowerCase());
                return mesh && window.TopologyProtocol.matchesProtocolFilter(mesh, pf);
            });
            edges = edges.filter((e) => {
                const a = meshById.get(String(e.source).replace(/^!/, '').toLowerCase());
                const b = meshById.get(String(e.target).replace(/^!/, '').toLowerCase());
                return a && b
                    && window.TopologyProtocol.matchesProtocolFilter(a, pf)
                    && window.TopologyProtocol.matchesProtocolFilter(b, pf);
            });
        }

        const sel = this._selectedNode?.node_id || this._selectedNode?.id;
        const selNorm = sel ? String(sel).replace(/^!/, '').toLowerCase() : null;
        if (selNorm) {
            const connected = new Set([selNorm]);
            for (const e of edges) {
                const a = String(e.source).replace(/^!/, '').toLowerCase();
                const b = String(e.target).replace(/^!/, '').toLowerCase();
                if (a === selNorm || b === selNorm) {
                    connected.add(a);
                    connected.add(b);
                }
            }
            nodes = nodes.filter((n) => connected.has(String(n.id).replace(/^!/, '').toLowerCase()));
            edges = edges.filter((e) => {
                const a = String(e.source).replace(/^!/, '').toLowerCase();
                const b = String(e.target).replace(/^!/, '').toLowerCase();
                return connected.has(a) && connected.has(b);
            });
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
        const accentPurple = '#a855f7';
        const meshById = new Map(
            (this._meshNodes || []).map((n) => [
                String(n.node_id || n.id).replace(/^!/, '').toLowerCase(),
                n,
            ]),
        );

        const svg = this._svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', '100%').attr('height', height);
        svg.selectAll('*').remove();
        const g = svg.append('g');

        const zoom = d3.zoom().scaleExtent([0.2, 4]).on('zoom', (ev) => g.attr('transform', ev.transform));
        svg.call(zoom);

        const link = g.append('g').selectAll('line').data(edges).join('line')
            .attr('stroke', (d) => (d.edge_type === 'neighborinfo' ? accentCyan : accentAmber))
            .attr('stroke-width', (d) => (d.snr >= 5 ? 3 : d.snr >= 0 ? 2 : 1.5))
            .attr('stroke-opacity', 0.85);

        const node = g.append('g').selectAll('g').data(nodes).join('g')
            .attr('transform', (d) => `translate(${d.x || 0},${d.y || 0})`)
            .style('cursor', 'pointer')
            .on('click', (_, d) => {
                const dNorm = String(d.id).replace(/^!/, '').toLowerCase();
                const mesh = this._meshNodes.find(
                    (n) => String(n.node_id || n.id).replace(/^!/, '').toLowerCase() === dNorm,
                );
                if (mesh) this._selectNode(mesh);
            });

        node.each(function (d) {
            const el = d3.select(this);
            const dNorm = String(d.id).replace(/^!/, '').toLowerCase();
            const mesh = meshById.get(dNorm);
            const isMc = mesh && window.TopologyProtocol?.resolveNodeProtocol(mesh) === 'meshcore';
            const fill = isMc ? accentPurple : accentCyan;
            const sel = dNorm === selNorm;
            if (isMc) {
                el.append('polygon')
                    .attr('points', '0,-9 9,0 0,9 -9,0')
                    .attr('fill', fill)
                    .attr('stroke', sel ? accentGreen : '#0f172a')
                    .attr('stroke-width', sel ? 2.5 : 1);
            } else {
                el.append('circle')
                    .attr('r', 8)
                    .attr('fill', fill)
                    .attr('stroke', sel ? accentGreen : '#0f172a')
                    .attr('stroke-width', sel ? 2.5 : 1);
            }
        });

        if (this._simulation) this._simulation.stop();
        this._simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(edges).id((d) => d.id).distance(85))
            .force('charge', d3.forceManyBody().strength(-220))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .on('tick', () => {
                link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
                    .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
                node.attr('transform', (d) => `translate(${d.x},${d.y})`);
            });
    }

    static _parseNodesResponse(data) {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.nodes)) return data.nodes;
        return [];
    }
}

try {
    window.topologyTab = new TopologyTab('topology-panel');
} catch (err) {
    console.error('TopologyTab failed to initialize:', err);
    const el = document.getElementById('topology-panel');
    if (el) {
        el.innerHTML = '<div class="topo-init-error">Topology failed to load. Hard refresh and check the browser console.</div>';
    }
}
