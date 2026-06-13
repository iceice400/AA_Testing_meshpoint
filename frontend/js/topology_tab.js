/**
 * Topology tab — Malla-style network graph with sidebar controls.
 */
class TopologyTab {
    constructor(containerId) {
        this._container = document.getElementById(containerId);
        this._hours = 24;
        this._rendered = false;
        this._simulation = null;
        this._graph = { nodes: [], edges: [], routes: [] };
        this._selectedNode = null;
        this._hoverNode = null;
        this._hoverEdge = null;
        this._statusStrip = null;
        this._fetchedAt = null;
        this._minSnr = -99;
        this._hopFilterEnabled = false;
        this._hopLimit = 3;
        this._multiHop = true;
        this._search = '';
        this._zoomTransform = null;
        this._svg = null;
        this._gRoot = null;
        this._loading = false;
        this._viewMode = 'graph';
        this._topoMap = null;
        this._dock = null;
        this._physics = { charge: -220, distance: 85, gravity: 0.08, frozen: false };
        this._centrality = {};
    }

    async refresh() {
        if (!this._container) return;

        if (!this._rendered) {
            this._buildLayout();
            this._rendered = true;
            this._setViewMode(this._viewMode);
        }

        if (typeof d3 === 'undefined') {
            this._setLoading(false);
            if (this._emptyEl) {
                this._emptyEl.hidden = false;
                this._emptyEl.textContent =
                    'Graph library failed to load. Check network access and refresh.';
            }
            return;
        }

        this._setLoading(true);
        try {
            const res = await fetch(`/api/analytics/topology?hours=${this._hours}`);
            if (!res.ok) return;
            this._graph = await res.json();
            this._fetchedAt = Date.now();
            if (window.topologyStore) {
                window.topologyStore.setHours(this._hours);
                window.topologyStore.loadFromApi(this._graph);
            }
            await this._renderGraphWhenReady();
            this._updateSidebarStats();
            this._mountDock();
            if (this._viewMode === 'map') {
                this._ensureTopoMap();
            }
        } catch (e) {
            console.error('Topology refresh failed:', e);
        } finally {
            this._setLoading(false);
        }
    }

    _renderGraphWhenReady() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._renderGraph();
                    resolve();
                });
            });
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

    _buildLayout() {
        this._container.innerHTML = `
            <div class="topo-workspace">
                <aside class="topo-sidebar">
                    <header class="topo-sidebar__header">
                        <h2 class="topo-sidebar__title">Network Graph</h2>
                        <p class="topo-sidebar__subtitle">NEIGHBORINFO · traceroute · routing paths</p>
                    </header>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Selection</div>
                        <div id="topo-selection" class="topo-detail-card topo-sidebar__hint">
                            Click a node to highlight traced routes.
                        </div>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Hover details</div>
                        <div id="topo-hover" class="topo-detail-card topo-sidebar__hint">
                            Hover over nodes or links for details.
                        </div>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Hop distance filter</div>
                        <label class="topo-check">
                            <input type="checkbox" id="topo-hop-enable" />
                            Enable hop filter
                        </label>
                        <label class="topo-field">
                            <span>Show nodes within <strong id="topo-hop-val">3</strong> hops</span>
                            <input type="range" id="topo-hop-range" min="1" max="7" value="3" />
                        </label>
                        <div id="topo-hop-count" class="topo-hop-count">Showing all nodes</div>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Search</div>
                        <label class="topo-field">
                            <input type="text" id="topo-search" placeholder="Node name or ID…" />
                        </label>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Simulation</div>
                        <label class="topo-field">
                            <span>Repulsion <strong id="topo-phys-charge-val">-220</strong></span>
                            <input type="range" id="topo-phys-charge" min="-500" max="-80" value="-220" step="10" />
                        </label>
                        <label class="topo-field">
                            <span>Link distance <strong id="topo-phys-dist-val">85</strong></span>
                            <input type="range" id="topo-phys-dist" min="40" max="180" value="85" step="5" />
                        </label>
                        <label class="topo-field">
                            <span>Center gravity <strong id="topo-phys-grav-val">0.08</strong></span>
                            <input type="range" id="topo-phys-grav" min="0" max="30" value="8" step="1" />
                        </label>
                        <div class="topo-btn-row">
                            <button type="button" class="topo-btn" id="topo-freeze">Freeze layout</button>
                            <button type="button" class="topo-btn" id="topo-pin">Pin all</button>
                        </div>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Controls</div>
                        <div class="topo-btn-row">
                            <button type="button" class="topo-btn" id="topo-center">Center graph</button>
                            <button type="button" class="topo-btn" id="topo-reset">Reset zoom</button>
                            <button type="button" class="topo-btn topo-btn--primary" id="topo-refresh">Refresh</button>
                        </div>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Filters</div>
                        <label class="topo-field">
                            <span>Time period</span>
                            <select id="topo-hours">
                                <option value="1">Last hour</option>
                                <option value="6">Last 6 hours</option>
                                <option value="24" selected>Last 24 hours</option>
                                <option value="72">Last 3 days</option>
                                <option value="168">Last week</option>
                            </select>
                        </label>
                        <label class="topo-field">
                            <span>Minimum SNR (dB)</span>
                            <select id="topo-min-snr">
                                <option value="-99">No limit</option>
                                <option value="-40">≥ -40 dB</option>
                                <option value="-30">≥ -30 dB</option>
                                <option value="-20">≥ -20 dB</option>
                                <option value="-10">≥ -10 dB</option>
                                <option value="0">≥ 0 dB</option>
                            </select>
                        </label>
                        <label class="topo-check">
                            <input type="checkbox" id="topo-multihop" checked />
                            Multi-hop connections
                        </label>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Statistics</div>
                        <div class="topo-stats">
                            <div class="topo-stat">
                                <span class="topo-stat__val" id="topo-stat-nodes">0</span>
                                <span class="topo-stat__label">Nodes</span>
                            </div>
                            <div class="topo-stat">
                                <span class="topo-stat__val" id="topo-stat-links">0</span>
                                <span class="topo-stat__label">Links</span>
                            </div>
                            <div class="topo-stat">
                                <span class="topo-stat__val" id="topo-stat-window">24h</span>
                                <span class="topo-stat__label">Time period</span>
                            </div>
                            <div class="topo-stat">
                                <span class="topo-stat__val" id="topo-stat-updated">—</span>
                                <span class="topo-stat__label">Last update</span>
                            </div>
                        </div>
                    </section>

                    <section class="topo-sidebar__section">
                        <div class="topo-sidebar__section-title">Legend</div>
                        <div class="topo-legend">
                            <span><i class="topo-swatch topo-swatch--ni"></i> Neighbor link</span>
                            <span><i class="topo-swatch topo-swatch--tr"></i> Traceroute path</span>
                            <span><i class="topo-swatch topo-swatch--rt"></i> Routing path</span>
                            <span><i class="topo-swatch topo-swatch--weak"></i> Weak signal</span>
                            <span class="topo-sidebar__hint">Node size = traffic + bridge centrality · Link thickness = SNR</span>
                        </div>
                    </section>

                    <section class="topo-sidebar__section topo-sidebar__section--dock">
                        <div id="topo-dock-host"></div>
                    </section>
                </aside>

                <main class="topo-main">
                    <div class="topo-main__toolbar">
                        <div class="topo-view-tabs" role="tablist" aria-label="Topology view">
                            <button type="button" class="topo-view-tab topo-view-tab--active" data-view="graph" role="tab" aria-selected="true">Graph</button>
                            <button type="button" class="topo-view-tab" data-view="map" role="tab" aria-selected="false">Map</button>
                        </div>
                    </div>
                    <div class="topo-view topo-view--graph topo-view--active" id="topo-view-graph">
                        <div class="topo-canvas-wrap">
                            <div id="topo-loading" class="topo-loading" hidden>Building network graph…</div>
                            <svg id="topo-svg" class="topo-svg" aria-label="Mesh topology graph"></svg>
                            <div id="topo-empty" class="topo-empty" hidden>No topology data in this window yet.</div>
                        </div>
                    </div>
                    <div class="topo-view topo-view--map" id="topo-view-map" hidden>
                        <div class="topo-map-panel">
                            <div id="topo-map" class="map-container"></div>
                        </div>
                    </div>
                    <div id="topo-status-strip-host"></div>
                    <div id="topo-map-status-host" hidden></div>
                </main>
            </div>
        `;

        const stripHost = document.getElementById('topo-status-strip-host');
        if (stripHost && window.StatusStrip) {
            this._statusStrip = new window.StatusStrip(stripHost, 'TOPOLOGY');
            this._statusStrip.mount();
        }

        this._svg = d3.select('#topo-svg');
        this._emptyEl = document.getElementById('topo-empty');

        document.getElementById('topo-hours')?.addEventListener('change', (e) => {
            this._hours = Number(e.target.value);
            this.refresh();
        });

        document.getElementById('topo-min-snr')?.addEventListener('change', (e) => {
            this._minSnr = Number(e.target.value);
            this._renderGraph();
        });

        document.getElementById('topo-multihop')?.addEventListener('change', (e) => {
            this._multiHop = e.target.checked;
            this._renderGraph();
        });

        document.getElementById('topo-hop-enable')?.addEventListener('change', (e) => {
            this._hopFilterEnabled = e.target.checked;
            this._renderGraph();
        });

        document.getElementById('topo-hop-range')?.addEventListener('input', (e) => {
            this._hopLimit = Number(e.target.value);
            document.getElementById('topo-hop-val').textContent = String(this._hopLimit);
            if (this._hopFilterEnabled) this._renderGraph();
        });

        document.getElementById('topo-search')?.addEventListener('input', (e) => {
            this._search = (e.target.value || '').trim().toLowerCase();
            this._renderGraph();
        });

        document.getElementById('topo-center')?.addEventListener('click', () => this._centerGraph());
        document.getElementById('topo-reset')?.addEventListener('click', () => this._resetZoom());
        document.getElementById('topo-refresh')?.addEventListener('click', () => this.refresh());

        ['charge', 'dist', 'grav'].forEach((key) => {
            const input = document.getElementById(`topo-phys-${key}`);
            input?.addEventListener('input', () => {
                if (key === 'charge') this._physics.charge = Number(input.value);
                if (key === 'dist') this._physics.distance = Number(input.value);
                if (key === 'grav') this._physics.gravity = Number(input.value) / 100;
                const valEl = document.getElementById(`topo-phys-${key}-val`);
                if (valEl) {
                    valEl.textContent = key === 'grav'
                        ? this._physics.gravity.toFixed(2)
                        : String(this._physics[key]);
                }
                if (this._viewMode === 'graph') this._renderGraph();
            });
        });

        document.getElementById('topo-freeze')?.addEventListener('click', (e) => {
            this._physics.frozen = !this._physics.frozen;
            e.currentTarget.classList.toggle('topo-btn--active', this._physics.frozen);
            e.currentTarget.textContent = this._physics.frozen ? 'Unfreeze' : 'Freeze layout';
            if (this._physics.frozen && this._simulation) {
                this._simulation.stop();
            } else if (this._rendered) {
                this._renderGraph();
            }
        });

        document.getElementById('topo-pin')?.addEventListener('click', () => {
            if (!this._simulation) return;
            this._simulation.nodes().forEach((n) => {
                n.fx = n.x;
                n.fy = n.y;
            });
            this._physics.frozen = true;
            this._simulation.stop();
            const btn = document.getElementById('topo-freeze');
            if (btn) {
                btn.classList.add('topo-btn--active');
                btn.textContent = 'Unfreeze';
            }
        });

        this._container.querySelectorAll('[data-view]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._setViewMode(btn.dataset.view);
            });
        });

        window.addEventListener('resize', () => {
            if (this._rendered && this._viewMode === 'graph') this._renderGraph();
            if (this._topoMap?._map) {
                setTimeout(() => this._topoMap._map.invalidateSize(), 120);
            }
        });
    }

    _mountDock() {
        if (this._dock || typeof MapTopologyDock === 'undefined' || !window.topologyStore) return;
        this._dock = new MapTopologyDock('topo-dock-host', window.topologyStore, {
            embedded: true,
            onSelectDark: (node) => {
                this._selectedNode = node.id;
                this._renderGraph();
                this._setViewMode('graph');
            },
        });
        window.topologyDock = this._dock;
    }

    _setViewMode(mode) {
        this._viewMode = mode === 'map' ? 'map' : 'graph';
        const graphView = document.getElementById('topo-view-graph');
        const mapView = document.getElementById('topo-view-map');
        const mapStatus = document.getElementById('topo-map-status-host');
        const isGraph = this._viewMode === 'graph';
        const isMap = this._viewMode === 'map';

        if (graphView) {
            graphView.hidden = !isGraph;
            graphView.classList.toggle('topo-view--active', isGraph);
        }
        if (mapView) {
            mapView.hidden = !isMap;
            mapView.classList.toggle('topo-view--active', isMap);
        }
        if (mapStatus) mapStatus.hidden = !isMap;

        this._container.querySelectorAll('[data-view]').forEach((btn) => {
            const active = btn.dataset.view === this._viewMode;
            btn.classList.toggle('topo-view-tab--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });

        if (isMap) {
            this._ensureTopoMap();
        } else if (this._rendered) {
            this._renderGraphWhenReady();
        }
    }

    async _ensureTopoMap() {
        if (typeof NodeMap === 'undefined' || !window.topologyStore) return;
        if (!this._topoMap) {
            this._topoMap = new NodeMap('topo-map', {
                store: window.topologyStore,
                topology: true,
                viewStorageKey: 'meshpoint.topoMap.view',
            });
        }
        try {
            const [deviceRes, nodesRes] = await Promise.all([
                fetch('/api/device'),
                fetch('/api/nodes?enrich=true'),
            ]);
            const device = deviceRes.ok ? await deviceRes.json() : null;
            const nodesData = nodesRes.ok ? await nodesRes.json() : { nodes: [] };
            const nodes = nodesData.nodes || nodesData || [];
            window.topologyStore.syncMeshNodes(nodes);
            this._topoMap.loadNodes(nodes, device);
        } catch (e) {
            console.error('Topology map load failed:', e);
        }
        setTimeout(() => {
            if (this._topoMap?._map) this._topoMap._map.invalidateSize();
        }, 150);
    }

    _updateSidebarStats() {
        const nodes = this._visibleNodeCount();
        const edges = this._filteredEdges().length;
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val);
        };
        set('topo-stat-nodes', nodes);
        set('topo-stat-links', edges);
        set('topo-stat-window', `${this._hours}h`);
        set('topo-stat-updated', this._fetchedAt
            ? new Date(this._fetchedAt).toLocaleTimeString()
            : '—');
    }

    _cssToken(name, fallback) {
        return getComputedStyle(document.documentElement)
            .getPropertyValue(name).trim() || fallback;
    }

    _filteredEdges() {
        let edges = (this._graph.edges || []).map((e) => ({ ...e }));
        if (!this._multiHop) {
            edges = edges.filter((e) => e.edge_type === 'neighborinfo');
        }
        edges = edges.filter((e) => {
            const snr = e.snr;
            if (snr == null) return this._minSnr <= -90;
            return snr >= this._minSnr;
        });
        return edges;
    }

    _visibleNodeIds(edges) {
        const ids = new Set();
        for (const e of edges) {
            if (e.source) ids.add(String(e.source));
            if (e.target) ids.add(String(e.target));
        }
        return ids;
    }

    _hopVisibleSet(edges) {
        const anchor = this._selectedNode || this._pickAnchorNode(edges);
        if (!anchor || !this._hopFilterEnabled) return null;

        const adj = new Map();
        for (const e of edges) {
            const a = String(e.source);
            const b = String(e.target);
            if (!adj.has(a)) adj.set(a, new Set());
            if (!adj.has(b)) adj.set(b, new Set());
            adj.get(a).add(b);
            adj.get(b).add(a);
        }

        const seen = new Map([[anchor, 0]]);
        const queue = [anchor];
        while (queue.length) {
            const cur = queue.shift();
            const depth = seen.get(cur);
            if (depth >= this._hopLimit) continue;
            for (const nb of adj.get(cur) || []) {
                if (!seen.has(nb)) {
                    seen.set(nb, depth + 1);
                    queue.push(nb);
                }
            }
        }
        return new Set(seen.keys());
    }

    _pickAnchorNode(edges) {
        const counts = new Map();
        for (const e of edges) {
            const a = String(e.source);
            const b = String(e.target);
            counts.set(a, (counts.get(a) || 0) + 1);
            counts.set(b, (counts.get(b) || 0) + 1);
        }
        let best = null;
        let bestCount = -1;
        for (const [id, c] of counts) {
            if (c > bestCount) {
                best = id;
                bestCount = c;
            }
        }
        return best;
    }

    _visibleNodeCount() {
        const edges = this._filteredEdges();
        const hopSet = this._hopVisibleSet(edges);
        let ids = this._visibleNodeIds(edges);
        if (hopSet) ids = new Set([...ids].filter((id) => hopSet.has(id)));
        if (this._search) {
            ids = new Set([...ids].filter((id) => this._nodeMatchesSearch(id)));
        }
        return ids.size;
    }

    _nodeMatchesSearch(nodeId) {
        const node = (this._graph.nodes || []).find((n) => n.id === nodeId);
        const label = (node?.label || '').toLowerCase();
        return label.includes(this._search) || String(nodeId).toLowerCase().includes(this._search);
    }

    _ensureGraphNodes(nodes, edges) {
        const byId = new Map(nodes.map((n) => [n.id, n]));
        for (const edge of edges) {
            for (const id of [edge.source, edge.target]) {
                if (!id || byId.has(id)) continue;
                const stub = {
                    id,
                    label: `!${String(id).slice(-4)}`,
                    protocol: 'meshtastic',
                    packet_count: 0,
                    latest_rssi: null,
                };
                nodes.push(stub);
                byId.set(id, stub);
            }
        }
        return nodes;
    }

    _updateSelectionPanel() {
        const el = document.getElementById('topo-selection');
        if (!el) return;
        if (!this._selectedNode) {
            el.innerHTML = 'Click a node to highlight traced routes.';
            return;
        }
        const node = (this._graph.nodes || []).find((n) => n.id === this._selectedNode);
        const label = node?.label || this._selectedNode;
        const cent = this._centrality[this._selectedNode];
        const centTxt = cent != null ? `<br>Centrality: ${cent.toFixed(2)}` : '';
        el.innerHTML = `<strong>${this._esc(label)}</strong><br>ID: !${this._esc(this._selectedNode)}${centTxt}<br>` +
            `Routes highlighted · click again to clear`;
    }

    _computeCentrality(nodes, edges) {
        const ids = nodes.map((n) => n.id);
        const adj = {};
        for (const id of ids) adj[id] = [];
        for (const e of edges) {
            const a = String(typeof e.source === 'object' ? e.source.id : e.source);
            const b = String(typeof e.target === 'object' ? e.target.id : e.target);
            if (!adj[a] || !adj[b]) continue;
            adj[a].push(b);
            adj[b].push(a);
        }
        const centrality = {};
        for (const id of ids) centrality[id] = 0;
        const sample = nodes.slice(0, Math.min(30, nodes.length));
        for (const src of sample) {
            const stack = [];
            const pred = {};
            const sigma = {};
            const dist = {};
            const delta = {};
            for (const id of ids) {
                pred[id] = [];
                sigma[id] = 0;
                dist[id] = -1;
                delta[id] = 0;
            }
            sigma[src.id] = 1;
            dist[src.id] = 0;
            const queue = [src.id];
            while (queue.length) {
                const v = queue.shift();
                stack.push(v);
                for (const w of adj[v] || []) {
                    if (dist[w] < 0) {
                        queue.push(w);
                        dist[w] = dist[v] + 1;
                    }
                    if (dist[w] === dist[v] + 1) {
                        sigma[w] += sigma[v];
                        pred[w].push(v);
                    }
                }
            }
            while (stack.length) {
                const w = stack.pop();
                for (const v of pred[w]) {
                    delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
                }
                if (w !== src.id) centrality[w] += delta[w];
            }
        }
        return centrality;
    }

    _updateHoverPanel(d) {
        const el = document.getElementById('topo-hover');
        if (!el) return;
        if (!d) {
            el.innerHTML = 'Hover over nodes or links for details.';
            return;
        }
        if (d.source && d.target) {
            const snr = d.snr != null ? `${d.snr} dB` : 'n/a';
            const rssi = d.rssi != null ? `${d.rssi} dBm` : 'n/a';
            el.innerHTML = `<strong>Link</strong><br>${this._esc(d.source)} ↔ ${this._esc(d.target)}<br>` +
                `SNR: ${snr} · RSSI: ${rssi}<br>${d.edge_type || 'link'}`;
            return;
        }
        const rssi = d.latest_rssi != null ? `${d.latest_rssi} dBm` : 'n/a';
        const cent = this._centrality[d.id];
        const centTxt = cent != null ? `<br>Centrality: ${cent.toFixed(2)}` : '';
        el.innerHTML = `<strong>${this._esc(d.label)}</strong><br>!${this._esc(d.id)}<br>` +
            `${d.packet_count || 0} pkts · ${rssi}${centTxt}`;
    }

    _esc(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _centerGraph() {
        if (this._simulation) {
            this._simulation.alpha(0.8).restart();
        }
        this._resetZoom();
    }

    _resetZoom() {
        if (!this._svg || !this._zoomBehavior) return;
        this._zoomTransform = d3.zoomIdentity;
        this._svg.call(this._zoomBehavior.transform, d3.zoomIdentity);
    }

    _renderGraph() {
        const wrap = this._container.querySelector('.topo-canvas-wrap');
        if (!wrap || !this._svg) return;

        const width = Math.max(wrap.clientWidth, 320);
        const height = Math.max(wrap.clientHeight, 320);

        const accentCyan = this._cssToken('--accent-cyan', '#06b6d4');
        const accentPurple = this._cssToken('--accent-purple', '#a855f7');
        const accentAmber = this._cssToken('--accent-amber', '#f59e0b');
        const accentGreen = this._cssToken('--accent-green', '#00e5a0');
        const textMuted = this._cssToken('--text-muted', '#64748b');
        const textPrimary = this._cssToken('--text-primary', '#e2e8f0');

        let edges = this._filteredEdges();
        let nodes = (this._graph.nodes || []).map((n) => ({ ...n }));
        nodes = this._ensureGraphNodes(nodes, edges);

        const hopSet = this._hopVisibleSet(edges);
        if (hopSet) {
            edges = edges.filter((e) => hopSet.has(String(e.source)) && hopSet.has(String(e.target)));
            nodes = nodes.filter((n) => hopSet.has(n.id));
        }
        if (this._search) {
            const matchIds = new Set(nodes.filter((n) => this._nodeMatchesSearch(n.id)).map((n) => n.id));
            edges = edges.filter((e) => matchIds.has(String(e.source)) || matchIds.has(String(e.target)));
            const connected = new Set();
            for (const e of edges) {
                connected.add(String(e.source));
                connected.add(String(e.target));
            }
            nodes = nodes.filter((n) => connected.has(n.id));
        }

        const hopCountEl = document.getElementById('topo-hop-count');
        if (hopCountEl) {
            hopCountEl.textContent = this._hopFilterEnabled
                ? `Showing ${nodes.length} of ${(this._graph.nodes || []).length} nodes`
                : `Showing ${nodes.length} nodes`;
        }

        this._updateSelectionPanel();
        this._updateSidebarStats();

        const sources = (this._graph.edge_sources || []).join(', ') || 'none';
        const st = this._graph.stats || {};
        this._statusStrip?.update(
            [
                `${nodes.length} nodes`,
                `${edges.length} links`,
                sources !== 'none' ? sources : 'awaiting edge data',
                `${this._hours}h window`,
            ],
            this._fetchedAt,
        );

        if (!nodes.length && !edges.length) {
            this._svg.selectAll('*').remove();
            this._emptyEl.hidden = false;
            const ni = st.neighborinfo_packets ?? 0;
            const tr = st.traceroute_packets ?? 0;
            const rt = st.routing_packets ?? 0;
            this._emptyEl.textContent =
                `No links in the last ${this._hours}h. Packets: ${ni} NI / ${tr} trace / ${rt} route. ` +
                'Use Poll routes or wait for neighbor broadcasts.';
            return;
        }
        this._emptyEl.hidden = true;

        const svg = this._svg
            .attr('viewBox', `0 0 ${width} ${height}`)
            .attr('width', '100%')
            .attr('height', height);

        svg.selectAll('*').remove();

        const g = svg.append('g').attr('class', 'topo-root');
        this._gRoot = g;

        this._zoomBehavior = d3.zoom()
            .scaleExtent([0.2, 4])
            .on('zoom', (event) => {
                this._zoomTransform = event.transform;
                g.attr('transform', event.transform);
            });
        svg.call(this._zoomBehavior);
        if (this._zoomTransform) {
            svg.call(this._zoomBehavior.transform, this._zoomTransform);
        }

        this._centrality = this._computeCentrality(nodes, edges);
        const maxCent = Math.max(1, ...Object.values(this._centrality));
        const maxPackets = Math.max(1, ...nodes.map((n) => n.packet_count || 0));
        const radius = (d) => {
            const traffic = 5 + ((d.packet_count || 0) / maxPackets) * 10;
            const bridge = ((this._centrality[d.id] || 0) / maxCent) * 8;
            return traffic + bridge;
        };

        const routeEdgeKeys = this._routeEdgeKeys(this._selectedNode);

        const linkWidth = (d) => {
            if (routeEdgeKeys.has(this._edgeKey(d))) return 3;
            const snr = d.snr;
            if (snr == null) return d.weak ? 1 : 1.5;
            if (snr >= 5) return 3;
            if (snr >= 0) return 2.25;
            if (snr >= -10) return 1.75;
            return 1;
        };

        const link = g.append('g')
            .attr('stroke-opacity', 0.8)
            .selectAll('line')
            .data(edges)
            .join('line')
            .attr('stroke', (d) => {
                if (routeEdgeKeys.has(this._edgeKey(d))) return accentGreen;
                if (d.weak) return textMuted;
                if (d.edge_type === 'neighborinfo') return accentCyan;
                if (d.edge_type === 'routing') return accentPurple;
                return accentAmber;
            })
            .attr('stroke-width', linkWidth)
            .attr('stroke-dasharray', (d) => {
                if (d.weak) return '4 3';
                if (d.edge_type && d.edge_type !== 'neighborinfo') return '6 4';
                return null;
            })
            .style('cursor', 'pointer')
            .on('mouseover', (_, d) => this._updateHoverPanel(d))
            .on('mouseout', () => this._updateHoverPanel(null));

        const node = g.append('g')
            .selectAll('circle')
            .data(nodes)
            .join('circle')
            .attr('r', (d) => radius(d))
            .attr('fill', (d) => (d.protocol === 'meshcore' ? accentPurple : accentCyan))
            .attr('stroke', (d) => (d.id === this._selectedNode ? textPrimary : 'rgba(15,23,42,0.8)'))
            .attr('stroke-width', (d) => (d.id === this._selectedNode ? 2.5 : 1))
            .style('cursor', 'pointer')
            .call(this._drag(g));

        node.append('title').text((d) => {
            const rssi = d.latest_rssi != null ? `${d.latest_rssi} dBm` : 'n/a';
            return `${d.label} (!${d.id})\n${d.packet_count || 0} pkts · ${rssi}`;
        });

        node.on('click', (_, d) => {
            this._selectedNode = this._selectedNode === d.id ? null : d.id;
            this._renderGraph();
        });
        node.on('mouseover', (_, d) => this._updateHoverPanel(d));
        node.on('mouseout', () => this._updateHoverPanel(null));

        if (this._simulation) this._simulation.stop();
        const phys = this._physics;
        this._simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(edges).id((d) => d.id).distance(phys.distance).strength(0.55))
            .force('charge', d3.forceManyBody().strength(phys.charge))
            .force('center', d3.forceCenter(width / 2, height / 2).strength(phys.gravity))
            .force('collide', d3.forceCollide().radius((d) => radius(d) + 5))
            .on('tick', () => {
                link
                    .attr('x1', (d) => d.source.x)
                    .attr('y1', (d) => d.source.y)
                    .attr('x2', (d) => d.target.x)
                    .attr('y2', (d) => d.target.y);
                node
                    .attr('cx', (d) => d.x)
                    .attr('cy', (d) => d.y);
            });
        if (phys.frozen) {
            this._simulation.stop();
        }
    }

    _edgeKey(edge) {
        const a = typeof edge.source === 'object' ? edge.source.id : edge.source;
        const b = typeof edge.target === 'object' ? edge.target.id : edge.target;
        return `${Math.min(a, b)}_${Math.max(a, b)}`;
    }

    _routeEdgeKeys(nodeId) {
        const keys = new Set();
        if (!nodeId) return keys;
        for (const route of this._graph.routes || []) {
            if (!route.route || !route.route.includes(nodeId)) continue;
            for (let i = 0; i < route.route.length - 1; i++) {
                const a = route.route[i];
                const b = route.route[i + 1];
                keys.add(`${Math.min(a, b)}_${Math.max(a, b)}`);
            }
        }
        return keys;
    }

    _drag(g) {
        const self = this;
        function dragstarted(event, d) {
            if (!event.active && self._simulation) self._simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }
        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }
        function dragended(event, d) {
            if (!event.active && self._simulation) self._simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }
        return d3.drag().on('start', dragstarted).on('drag', dragged).on('end', dragended);
    }
}

window.topologyTab = new TopologyTab('topology-panel');
