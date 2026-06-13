/**
 * Right intel panel — Smart poller, trace path, settings, legend, alerts.
 */
(function () {
    class TopologyIntel {
        constructor(hostId, options = {}) {
            this._host = document.getElementById(hostId);
            this._store = options.store;
            this._settings = options.settings;
            this._poller = options.poller;
            this._audio = options.audio;
            this._observer = options.observer === true;
            this._alerts = [];
            this._maxAlerts = 60;
            this._selectedNode = null;
            this._deviceId = null;
            this._traceVisible = false;
            if (this._host) this._build();
        }

        _build() {
            this._host.innerHTML = `
                <div class="topo-rp__scroll">
                    <section class="topo-rp__sec">
                        <div class="topo-rp__title-row">
                            <span class="topo-sec-lbl">Smart poller</span>
                            <span class="topo-sec-badge" id="topo-badge-queue">0 queued</span>
                        </div>
                        <div class="topo-poller-status">
                            <div class="topo-ps-dot" id="topo-ps-dot"></div>
                            <div class="topo-ps-text" id="topo-ps-text">Idle: waiting for traffic</div>
                        </div>
                        <div class="topo-poll-queue" id="topo-poll-queue"></div>
                        <div class="topo-btn-row">
                            <button type="button" class="topo-btn topo-btn--primary topo-btn--sm" id="topo-poll-all"
                                ${this._observer ? 'disabled' : ''}>⟳ Poll all</button>
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-poll-routers"
                                ${this._observer ? 'disabled' : ''}>⟳ Routers</button>
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-clear-queue"
                                ${this._observer ? 'disabled' : ''}>✕ Queue</button>
                        </div>
                    </section>

                    <section class="topo-rp__sec topo-trace-panel" id="topo-trace-panel" hidden>
                        <div class="topo-rp__title-row">
                            <span class="topo-sec-lbl">Last traceroute</span>
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-trace-clear">✕</button>
                        </div>
                        <div class="topo-trace-target">
                            <span class="topo-trace-name" id="topo-tr-target">—</span>
                            <span class="topo-trace-age" id="topo-tr-age">—</span>
                        </div>
                        <div class="topo-trace-block">
                            <div class="topo-trace-dir">▶ Forward path</div>
                            <div class="topo-trace-hops" id="topo-tr-fwd"></div>
                        </div>
                        <div class="topo-trace-block" id="topo-tr-ret-wrap">
                            <div class="topo-trace-dir">◀ Return path</div>
                            <div class="topo-trace-hops" id="topo-tr-ret"></div>
                        </div>
                    </section>

                    <section class="topo-rp__sec">
                        <div class="topo-rp__title-row"><span class="topo-sec-lbl">Poller settings</span></div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-auto-on"
                                ${this._settings.get('autoOn') ? 'checked' : ''}
                                ${this._observer ? 'disabled' : ''} /> Auto-traceroute</label>
                        </div>
                        <div class="topo-setting-row">
                            <span>Rate limit (min)</span>
                            <input type="number" id="topo-rate-min" min="5" max="120"
                                value="${this._settings.get('rateLimitMin')}" ${this._observer ? 'disabled' : ''} />
                        </div>
                        <div class="topo-setting-row">
                            <span>Static threshold (hr)</span>
                            <input type="number" id="topo-static-hrs" min="1" max="72"
                                value="${this._settings.get('staticHrs')}" />
                        </div>
                        <div class="topo-setting-row">
                            <span>Inactivity hide (min)</span>
                            <input type="number" id="topo-inact-min" min="5" max="240"
                                value="${this._settings.get('inactMin')}" />
                        </div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-audio-on"
                                ${this._settings.get('audioOn') ? 'checked' : ''} /> Audio alerts</label>
                        </div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-edges-on"
                                ${this._settings.get('edgesOn') !== false ? 'checked' : ''} /> Show edges</label>
                        </div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-dark-inf"
                                ${this._settings.get('darkInfOn') !== false ? 'checked' : ''} /> Dark node inference</label>
                        </div>
                        <div class="topo-setting-row">
                            <label><input type="checkbox" id="topo-labels-on"
                                ${this._settings.get('labelsOn') !== false ? 'checked' : ''} /> Node labels</label>
                        </div>
                        <div class="topo-setting-row">
                            <span>Time window</span>
                            <select id="topo-hours" class="topo-hours-select">
                                <option value="1">1h</option>
                                <option value="6">6h</option>
                                <option value="24" selected>24h</option>
                                <option value="72">3d</option>
                                <option value="168">7d</option>
                            </select>
                        </div>
                        <div class="topo-relay-prefix">
                            <span class="topo-sec-lbl">Relay prefix</span>
                            <input type="text" id="topo-relay-prefix" maxlength="16"
                                value="${this._escAttr(this._settings.get('relayPrefix'))}"
                                placeholder="[MP]" ${this._observer ? 'disabled' : ''} />
                        </div>
                        <div class="topo-btn-row">
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-export">↓ Export</button>
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-open-graph">◎ Graph</button>
                            <button type="button" class="topo-btn topo-btn--sm" id="topo-refresh">↻ Refresh</button>
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

                    <section class="topo-rp__sec topo-rp__sec--alerts-head">
                        <div class="topo-rp__title-row">
                            <span class="topo-sec-lbl">Operator alerts</span>
                            <span class="topo-sec-badge" id="topo-alert-count">0</span>
                        </div>
                    </section>
                </div>
                <div class="topo-alert-feed" id="topo-intel-alerts">
                    <div class="topo-af-empty">All quiet: network nominal.</div>
                </div>
            `;

            const hoursSel = document.getElementById('topo-hours');
            if (hoursSel) hoursSel.value = String(this._settings.get('hours') || 24);

            this._bindSettings();
        }

        _bindSettings() {
            const bind = (id, key, parse) => {
                document.getElementById(id)?.addEventListener('change', (e) => {
                    const val = parse ? parse(e.target) : e.target.checked;
                    this._settings.set(key, val);
                    this._syncStoreLayers();
                });
            };
            bind('topo-auto-on', 'autoOn');
            bind('topo-audio-on', 'audioOn');
            bind('topo-edges-on', 'edgesOn');
            bind('topo-dark-inf', 'darkInfOn');
            bind('topo-labels-on', 'labelsOn');
            document.getElementById('topo-rate-min')?.addEventListener('change', (e) => {
                this._settings.set('rateLimitMin', Number(e.target.value) || 15);
            });
            document.getElementById('topo-static-hrs')?.addEventListener('change', (e) => {
                this._settings.set('staticHrs', Number(e.target.value) || 24);
            });
            document.getElementById('topo-inact-min')?.addEventListener('change', (e) => {
                this._settings.set('inactMin', Number(e.target.value) || 60);
                this._emitAction('inactChanged');
            });
            document.getElementById('topo-relay-prefix')?.addEventListener('change', (e) => {
                this._settings.set('relayPrefix', e.target.value || '[MP]');
            });
            document.getElementById('topo-hours')?.addEventListener('change', (e) => {
                this._settings.set('hours', Number(e.target.value) || 24);
                this._emitAction('hoursChanged');
            });
            document.getElementById('topo-poll-all')?.addEventListener('click', () => this._emitAction('pollAll'));
            document.getElementById('topo-poll-routers')?.addEventListener('click', () => this._emitAction('pollRouters'));
            document.getElementById('topo-clear-queue')?.addEventListener('click', () => {
                this._poller?.clearQueue();
            });
            document.getElementById('topo-export')?.addEventListener('click', () => this._emitAction('export'));
            document.getElementById('topo-open-graph')?.addEventListener('click', () => this._emitAction('graph'));
            document.getElementById('topo-refresh')?.addEventListener('click', () => this._emitAction('refresh'));
            document.getElementById('topo-trace-clear')?.addEventListener('click', () => {
                this._traceVisible = false;
                document.getElementById('topo-trace-panel')?.setAttribute('hidden', '');
            });
            this._syncStoreLayers();
        }

        _syncStoreLayers() {
            if (!this._store) return;
            this._store.layers.edges = this._settings.get('edgesOn') !== false;
            this._store.layers.darkStubs = this._settings.get('darkInfOn') !== false;
            this._store.layers.labels = this._settings.get('labelsOn') !== false;
            this._store.notifyChange();
        }

        setOnAction(fn) { this._onAction = fn; }
        _emitAction(name) { if (this._onAction) this._onAction(name); }

        setDeviceId(id) { this._deviceId = id; }

        setTopologyStatus(status) {
            this._topologyStatus = status || null;
            const text = document.getElementById('topo-ps-text');
            if (!text || !status) return;
            if (status.meshtastic_tx_enabled === false) {
                text.textContent = 'TX off — enable Meshtastic TX for traceroute/position';
                return;
            }
            if (status.traceroute_available === false) {
                text.textContent = 'Traceroute TX not wired on this node';
            }
        }

        setSelectedNode(node) {
            this._selectedNode = node;
            this._renderTraceView();
        }

        updateQueueStatus(queue, state) {
            const badge = document.getElementById('topo-badge-queue');
            const dot = document.getElementById('topo-ps-dot');
            const text = document.getElementById('topo-ps-text');
            const list = document.getElementById('topo-poll-queue');
            const items = queue || [];
            const st = state || 'idle';

            if (badge) badge.textContent = `${items.length} queued`;
            if (dot) {
                dot.className = 'topo-ps-dot'
                    + (st === 'queue' ? ' topo-ps-dot--active' : '')
                    + (st === 'ratelimit' ? ' topo-ps-dot--ratelimit' : '');
            }
            if (text) {
                if (st === 'idle') text.textContent = 'Idle: waiting for traffic';
                else if (st === 'ratelimit') text.innerHTML = '<strong>Cooldown</strong> — firmware 30s limit';
                else text.innerHTML = `<strong>Polling</strong> — ${items.length} queued`;
            }
            if (!list) return;
            list.innerHTML = '';
            for (const q of items.slice(0, 8)) {
                const row = document.createElement('div');
                row.className = `topo-queue-item topo-queue-item--${q.state || 'pending'}`;
                row.innerHTML = `
                    <span class="topo-qi-node">!${this._esc(String(q.nodeId).slice(-4))}</span>
                    <span class="topo-qi-reason">${this._esc(q.reason)}</span>
                    <span class="topo-qi-status">${q.state === 'sending' ? '↯ TX' : '⌛'}</span>
                `;
                list.appendChild(row);
            }
        }

        pushAlert(alert) {
            const entry = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                ts: Date.now(),
                type: alert.type || 'info',
                node_name: alert.node_name || alert.node_id || 'system',
                message: alert.message || String(alert),
            };
            this._alerts.unshift(entry);
            if (this._alerts.length > this._maxAlerts) this._alerts.pop();
            this._renderAlerts();
            this._playAlertSound(entry.type);
        }

        _playAlertSound(type) {
            const t = String(type).toLowerCase();
            if (t.includes('critical') || t.includes('battery') || t.includes('danger')) {
                this._audio?.play('batteryCritical');
            } else if (t.includes('warn')) this._audio?.play('warning');
            else if (t.includes('new')) this._audio?.play('newNode');
            else if (t.includes('trace') || t.includes('route')) this._audio?.play('tracerouteReply');
        }

        _renderAlerts() {
            const host = document.getElementById('topo-intel-alerts');
            const countEl = document.getElementById('topo-alert-count');
            if (!host) return;
            if (countEl) countEl.textContent = String(this._alerts.length);
            host.innerHTML = '';
            if (!this._alerts.length) {
                host.innerHTML = '<div class="topo-af-empty">All quiet: network nominal.</div>';
                return;
            }
            for (const a of this._alerts.slice(0, 30)) {
                const card = document.createElement('div');
                card.className = `topo-af-card topo-af-card--${this._alertClass(a.type)}`;
                card.innerHTML = `
                    <span class="topo-af-time">${new Date(a.ts).toLocaleTimeString()}</span>
                    <span class="topo-af-node">${this._esc(a.node_name)}</span>
                    ${this._esc(a.message)}
                `;
                host.appendChild(card);
            }
        }

        _renderTraceView() {
            const panel = document.getElementById('topo-trace-panel');
            if (!this._selectedNode) {
                if (panel) panel.hidden = true;
                return;
            }
            const id = this._selectedNode.node_id || this._selectedNode.id;
            const meta = this._poller?.getTraceMeta(id);
            const snap = this._store?.getSnapshot();
            let route = meta?.route;
            let snrT = meta?.snrTowards || [];
            let snrB = meta?.snrBack || [];
            let updatedAt = meta?.updatedAt;

            if (!route?.length && snap?.routes?.length) {
                const idNorm = String(id).replace(/^!/, '').toLowerCase();
                for (const r of snap.routes) {
                    const path = (r.route || []).map(
                        (h) => String(h).replace(/^!/, '').toLowerCase(),
                    );
                    if (path.includes(idNorm)) {
                        route = r.route;
                        snrT = r.snr_towards || snrT;
                        snrB = r.snr_back || snrB;
                        break;
                    }
                }
            }

            if (!route?.length) {
                if (panel) panel.hidden = true;
                return;
            }

            this._traceVisible = true;
            if (panel) panel.hidden = false;

            const name = this._selectedNode.display_name || this._selectedNode.long_name
                || this._selectedNode.short_name || `!${id.slice(-6)}`;
            this._setText('topo-tr-target', name);
            this._setText('topo-tr-age', updatedAt ? this._ago(updatedAt) : '—');
            this._renderHopPath('topo-tr-fwd', route, snrT);
            const retRoute = [...route].reverse();
            const retWrap = document.getElementById('topo-tr-ret-wrap');
            if (snrB.length && retWrap) {
                retWrap.hidden = false;
                this._renderHopPath('topo-tr-ret', retRoute, [...snrB].reverse());
            } else if (retWrap) {
                retWrap.hidden = true;
            }
        }

        _renderHopPath(containerId, hops, snrs) {
            const el = document.getElementById(containerId);
            if (!el) return;
            let html = '';
            for (let i = 0; i < hops.length; i++) {
                if (i > 0) {
                    const snr = snrs[i - 1];
                    const cls = snr == null ? '' : snr > 5 ? 'topo-th-snr--good' : snr > 0 ? 'topo-th-snr--mid' : 'topo-th-snr--bad';
                    const snrTxt = snr != null ? `${Number(snr).toFixed(1)} dB` : '?';
                    html += `<span class="topo-th-snr ${cls}">${snrTxt}</span><span class="topo-th-arrow">→</span>`;
                }
                html += `<span class="topo-th-node">!${String(hops[i]).slice(-4)}</span>`;
            }
            el.innerHTML = html;
        }

        _ago(ts) {
            const s = Math.floor((Date.now() - ts) / 1000);
            if (s < 60) return `${s}s ago`;
            if (s < 3600) return `${Math.floor(s / 60)}m ago`;
            return `${Math.floor(s / 3600)}h ago`;
        }

        _setText(id, val) {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        }

        _alertClass(type) {
            const t = String(type).toLowerCase();
            if (t.includes('critical') || t.includes('danger')) return 'danger';
            if (t.includes('warn') || t.includes('battery')) return 'warn';
            if (t.includes('new')) return 'new';
            if (t.includes('route') || t.includes('trace')) return 'route';
            return 'info';
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

    window.TopologyIntel = TopologyIntel;
})();
