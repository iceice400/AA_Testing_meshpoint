/**
 * Operator panel for the Topology tab (stats, filters, unplotted, alerts).
 */
class MapTopologyDock {
    constructor(hostId, store, options = {}) {
        this._host = document.getElementById(hostId);
        this._store = store;
        this._embedded = options.embedded === true;
        this._onSelectNode = options.onSelectNode || null;
        this._onSelectDark = options.onSelectDark || null;
        this._alerts = [];
        this._maxAlerts = 40;
        this._collapsed = !this._embedded;
        this._built = false;
        if (this._host && this._store) {
            if (this._embedded) {
                this._host.classList.add('topo-operator-dock');
            }
            this._build();
            if (!this._embedded) {
                this._host.classList.add('map-topology-dock--collapsed');
            }
            this._store.onChange(() => this.renderStats());
        }
    }

    _build() {
        if (!this._host || this._built) return;
        const collapseBtn = this._embedded
            ? ''
            : `<button type="button" class="map-dock__collapse" id="map-dock-collapse" aria-expanded="false" title="Collapse panel">▶</button>`;
        const logicalBtn = this._embedded
            ? ''
            : `<button type="button" class="map-dock-btn" id="dock-logical">Logical graph</button>`;
        this._host.innerHTML = `
            <div class="map-dock">
                <header class="map-dock__header">
                    <span class="map-dock__title">${this._embedded ? 'Operator panel' : 'Topology'}</span>
                    ${collapseBtn}
                </header>
                <div class="map-dock__body" id="map-dock-body">
                    <div class="map-dock__stats">
                        <div class="map-dock-stat">
                            <span class="map-dock-stat__val map-dock-stat__val--good" id="dock-mapped">0</span>
                            <span class="map-dock-stat__label">Mapped</span>
                        </div>
                        <div class="map-dock-stat">
                            <span class="map-dock-stat__val map-dock-stat__val--warn" id="dock-dark">0</span>
                            <span class="map-dock-stat__label">Dark</span>
                        </div>
                        <div class="map-dock-stat">
                            <span class="map-dock-stat__val" id="dock-edges">0</span>
                            <span class="map-dock-stat__label">Links</span>
                        </div>
                        <div class="map-dock-stat">
                            <span class="map-dock-stat__val map-dock-stat__val--bad" id="dock-poor">0</span>
                            <span class="map-dock-stat__label">Poor</span>
                        </div>
                    </div>

                    <div class="map-dock__section">
                        <div class="map-dock__section-title">Edge filters</div>
                        <label class="map-dock-range">
                            <span>Min RSSI</span>
                            <input type="range" id="dock-rssi" min="-140" max="-60" value="-130" step="5" />
                            <span id="dock-rssi-val" class="map-dock-range__val">-130</span>
                        </label>
                        <label class="map-dock-range">
                            <span>Min SNR</span>
                            <input type="range" id="dock-snr" min="-20" max="15" value="-20" step="1" />
                            <span id="dock-snr-val" class="map-dock-range__val">-20</span>
                        </label>
                    </div>

                    <div class="map-dock__section">
                        <div class="map-dock__section-title">Layers</div>
                        <div class="map-dock-toggles">
                            <button type="button" class="map-dock-toggle map-dock-toggle--on" data-layer="edges">Edges</button>
                            <button type="button" class="map-dock-toggle map-dock-toggle--on" data-layer="darkStubs">Dark</button>
                            <button type="button" class="map-dock-toggle map-dock-toggle--on" data-layer="labels">Labels</button>
                            <button type="button" class="map-dock-toggle" data-layer="coverage">Coverage</button>
                        </div>
                    </div>

                    <div class="map-dock__actions">
                        <button type="button" class="map-dock-btn map-dock-btn--primary" id="dock-poll" title="Send traceroute probes to router nodes">Poll routes</button>
                        <button type="button" class="map-dock-btn map-dock-btn--primary" id="dock-export">Export JSON</button>
                        ${logicalBtn}
                        <button type="button" class="map-dock-btn" id="dock-clear-alerts">Clear alerts</button>
                    </div>
                    <div id="dock-poll-status" class="map-dock-poll-status" hidden></div>

                    <div class="map-dock__section">
                        <div class="map-dock__section-title">Unplotted nodes <span id="dock-unplotted-count" class="map-dock-badge">0</span></div>
                        <ul class="map-dock-dark-list" id="dock-dark-list"></ul>
                    </div>

                    <div class="map-dock__section map-dock__section--alerts">
                        <div class="map-dock__section-title">Alerts <span id="dock-alert-count" class="map-dock-badge">0</span></div>
                        <div class="map-dock-alerts" id="dock-alerts">
                            <div class="map-dock-alerts__empty">No alerts — network quiet.</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this._built = true;
        this._bindControls();
    }

    _bindControls() {
        const collapse = document.getElementById('map-dock-collapse');
        collapse?.addEventListener('click', () => {
            this._collapsed = !this._collapsed;
            this._host.classList.toggle('map-topology-dock--collapsed', this._collapsed);
            collapse.setAttribute('aria-expanded', String(!this._collapsed));
            collapse.textContent = this._collapsed ? '▶' : '◀';
            setTimeout(() => window.dispatchEvent(new Event('resize')), 220);
        });

        const rssi = document.getElementById('dock-rssi');
        rssi?.addEventListener('input', () => {
            this._store.filters.minRssi = Number(rssi.value);
            document.getElementById('dock-rssi-val').textContent = rssi.value;
            this._store.notifyChange();
        });

        const snr = document.getElementById('dock-snr');
        snr?.addEventListener('input', () => {
            this._store.filters.minSnr = Number(snr.value);
            document.getElementById('dock-snr-val').textContent = snr.value;
            this._store.notifyChange();
        });

        this._host.querySelectorAll('[data-layer]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const layer = btn.dataset.layer;
                btn.classList.toggle('map-dock-toggle--on');
                const on = btn.classList.contains('map-dock-toggle--on');
                this._store.layers[layer] = on;
                this._store.notifyChange();
            });
        });

        document.getElementById('dock-export')?.addEventListener('click', () => {
            const data = this._store.exportJson();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `meshpoint-topology-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.pushAlert({
                type: 'info',
                node_id: 'system',
                node_name: 'SYSTEM',
                message: 'Topology snapshot exported.',
            });
        });

        document.getElementById('dock-logical')?.addEventListener('click', () => {
            if (this._onOpenLogical) this._onOpenLogical();
        });

        document.getElementById('dock-clear-alerts')?.addEventListener('click', () => {
            this._alerts = [];
            this._renderAlerts();
        });

        document.getElementById('dock-poll')?.addEventListener('click', () => this._pollTopology());
    }

    async _pollTopology() {
        const statusEl = document.getElementById('dock-poll-status');
        const btn = document.getElementById('dock-poll');
        if (btn) btn.disabled = true;
        if (statusEl) {
            statusEl.hidden = false;
            statusEl.textContent = 'Polling router nodes…';
        }
        try {
            const res = await fetch('/api/analytics/topology/poll', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || data.error || 'Poll failed');
            const msg = `Sent ${data.polled || 0} traceroute${data.polled === 1 ? '' : 's'}`
                + (data.skipped ? ` · ${data.skipped} on cooldown` : '');
            if (statusEl) statusEl.textContent = msg;
            this.pushAlert({
                type: 'info',
                node_id: 'system',
                node_name: 'TOPOLOGY',
                message: msg,
            });
            setTimeout(() => this._store?.refreshFromApi(), 4000);
        } catch (err) {
            if (statusEl) statusEl.textContent = String(err.message || err);
            this.pushAlert({
                type: 'warn',
                node_id: 'system',
                node_name: 'TOPOLOGY',
                message: `Poll failed: ${err.message || err}`,
            });
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    renderStats() {
        if (!this._built) return;
        const snap = this._store.getSnapshot();

        this._setText('dock-mapped', snap.mapped);
        this._setText('dock-dark', snap.dark);
        this._setText('dock-edges', snap.edges.length);
        this._setText('dock-poor', snap.poor_edges);
        this._setText('dock-unplotted-count', snap.unplotted.length);

        const list = document.getElementById('dock-dark-list');
        if (list) {
            list.innerHTML = '';
            const items = snap.unplotted.slice(0, 12);
            if (!items.length) {
                const li = document.createElement('li');
                li.className = 'map-dock-dark-list__empty';
                li.textContent = 'All known nodes have GPS.';
                list.appendChild(li);
            } else {
                for (const node of items) {
                    const li = document.createElement('li');
                    li.className = 'map-dock-dark-list__item';
                    const rssi = node.latest_rssi != null ? `${node.latest_rssi} dBm` : '—';
                    li.innerHTML = `
                        <button type="button" class="map-dock-dark-list__btn" data-node-id="${this._escAttr(node.id)}">
                            <span class="map-dock-dark-list__name">${this._esc(node.label)}</span>
                            <span class="map-dock-dark-list__meta">${node.edge_count} links · ${rssi}</span>
                        </button>
                    `;
                    li.querySelector('button')?.addEventListener('click', () => {
                        this._store.setSelectedNode(node.id);
                        if (this._onSelectDark) this._onSelectDark(node);
                    });
                    list.appendChild(li);
                }
            }
        }
    }

    pushAlert(alert) {
        const entry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            ts: Date.now(),
            type: alert.type || alert.alert_kind || 'info',
            node_id: alert.node_id || alert.nodeId || 'system',
            node_name: alert.node_name || alert.nodeName || alert.node_id || 'system',
            message: alert.message || alert.msg || alert.detail || String(alert.alert_kind || 'alert'),
        };
        this._alerts.unshift(entry);
        if (this._alerts.length > this._maxAlerts) this._alerts.pop();
        this._renderAlerts();
    }

    _renderAlerts() {
        const host = document.getElementById('dock-alerts');
        const countEl = document.getElementById('dock-alert-count');
        if (!host) return;
        if (countEl) countEl.textContent = String(this._alerts.length);

        host.innerHTML = '';
        if (!this._alerts.length) {
            host.innerHTML = '<div class="map-dock-alerts__empty">No alerts — network quiet.</div>';
            return;
        }
        for (const a of this._alerts) {
            const card = document.createElement('div');
            card.className = `map-dock-alert map-dock-alert--${this._alertClass(a.type)}`;
            const time = new Date(a.ts).toLocaleTimeString();
            card.innerHTML = `
                <span class="map-dock-alert__time">${time}</span>
                <strong class="map-dock-alert__node">${this._esc(a.node_name)}</strong>
                <span class="map-dock-alert__msg">${this._esc(a.message)}</span>
            `;
            host.appendChild(card);
        }
    }

    _alertClass(type) {
        const t = String(type).toLowerCase();
        if (t.includes('storm') || t.includes('danger') || t.includes('critical')) return 'danger';
        if (t.includes('warn') || t.includes('battery')) return 'warn';
        if (t.includes('new')) return 'new';
        return 'info';
    }

    _setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    _esc(str) {
        const el = document.createElement('span');
        el.textContent = str == null ? '' : String(str);
        return el.innerHTML;
    }

    _escAttr(str) {
        return String(str).replace(/"/g, '&quot;');
    }
}

window.MapTopologyDock = MapTopologyDock;
