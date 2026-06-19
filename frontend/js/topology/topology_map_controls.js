/**
 * Topology tab right rail — map-centric controls (MeshSense-style).
 * Poller, traceroute history, and event log live on Mesh Intelligence.
 */
(function () {
    class TopologyMapControls {
        constructor(hostId, options = {}) {
            this._host = document.getElementById(hostId);
            this._store = options.store;
            this._settings = options.settings;
            this._onAction = null;
            if (this._host) this._build();
        }

        _build() {
            this._host.innerHTML = `
                <div class="topo-rp__scroll">
                    <section class="topo-rp__sec">
                        <div class="topo-rp__title-row"><span class="topo-sec-lbl">Map layers</span></div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-map-edges-on"
                                ${this._settings.get('edgesOn') !== false ? 'checked' : ''} /> Show edges</label>
                        </div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-map-dark-inf"
                                ${this._settings.get('darkInfOn') !== false ? 'checked' : ''} /> Dark node inference</label>
                        </div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-map-labels-on"
                                ${this._settings.get('labelsOn') !== false ? 'checked' : ''} /> Node labels</label>
                        </div>
                        <div class="topo-setting-row">
                            <span>Time window</span>
                            <select id="topo-map-hours" class="topo-hours-select">
                                <option value="1">1h</option>
                                <option value="6">6h</option>
                                <option value="24" selected>24h</option>
                                <option value="72">3d</option>
                                <option value="168">7d</option>
                            </select>
                        </div>
                        <div class="topo-btn-row">
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-map-graph">◎ Graph</button>
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-map-refresh">↻ Refresh</button>
                        </div>
                    </section>

                    <section class="topo-rp__sec">
                        <div class="topo-rp__title-row"><span class="topo-sec-lbl">Legend</span></div>
                        <div class="topo-legend-rows">
                            <div class="topo-leg"><span class="topo-leg-line topo-leg-line--good"></span>Strong (RSSI &gt; -90)</div>
                            <div class="topo-leg"><span class="topo-leg-line topo-leg-line--mid"></span>Marginal (-90 to -110)</div>
                            <div class="topo-leg"><span class="topo-leg-line topo-leg-line--bad"></span>Weak (RSSI &lt; -110)</div>
                            <div class="topo-leg"><span class="topo-leg-line topo-leg-line--dark"></span>Inferred dark link</div>
                            <div class="topo-leg"><span class="topo-leg-dot topo-leg-dot--mt"></span>Meshtastic (MT) — circle</div>
                            <div class="topo-leg"><span class="topo-leg-dot topo-leg-dot--mc"></span>MeshCore (MC) — diamond</div>
                            <div class="topo-leg"><span class="topo-leg-dot topo-leg-dot--router"></span>Router / repeater</div>
                            <div class="topo-leg"><span class="topo-leg-dot topo-leg-dot--client"></span>Client</div>
                            <div class="topo-leg"><span class="topo-leg-dot topo-leg-dot--dark"></span>Dark / GPS-off node</div>
                        </div>
                    </section>

                    <section class="topo-rp__sec topo-map-controls-hint">
                        <p class="topo-map-controls-hint__text">
                            Traceroute polling, hop analysis, and the event log are on
                            <a href="#/intelligence" class="topo-map-controls-hint__link">Mesh Intelligence</a>.
                        </p>
                    </section>
                </div>
            `;

            const hoursSel = document.getElementById('topo-map-hours');
            if (hoursSel) hoursSel.value = String(this._settings.get('hours') || 24);
            this._bind();
        }

        _bind() {
            const bind = (id, key) => {
                document.getElementById(id)?.addEventListener('change', (e) => {
                    this._settings.set(key, e.target.checked);
                    this._syncStoreLayers();
                });
            };
            bind('topo-map-edges-on', 'edgesOn');
            bind('topo-map-dark-inf', 'darkInfOn');
            bind('topo-map-labels-on', 'labelsOn');
            document.getElementById('topo-map-hours')?.addEventListener('change', (e) => {
                this._settings.set('hours', Number(e.target.value) || 24);
                this._emitAction('hoursChanged');
            });
            document.getElementById('topo-map-graph')?.addEventListener('click', () => this._emitAction('graph'));
            document.getElementById('topo-map-refresh')?.addEventListener('click', () => this._emitAction('refresh'));
            this._syncStoreLayers();
        }

        _syncStoreLayers() {
            if (!this._store) return;
            this._store.layers.edges = this._settings.get('edgesOn') !== false;
            this._store.layers.darkStubs = this._settings.get('darkInfOn') !== false;
            this._store.layers.labels = this._settings.get('labelsOn') !== false;
            window.topologyTab?._topoMap?.scheduleStoreRender?.();
        }

        setOnAction(fn) { this._onAction = fn; }
        _emitAction(name) { if (this._onAction) this._onAction(name); }

        bindStore(store) {
            this._store = store;
            this._syncStoreLayers();
        }
    }

    window.TopologyMapControls = TopologyMapControls;
})();
