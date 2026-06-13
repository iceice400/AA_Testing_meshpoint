/**
 * Node roster panel — reference layout, Meshpoint design tokens.
 */
(function () {
    const ROLE_FILTERS = [
        { id: 'ROUTER', label: 'Router' },
        { id: 'CLIENT', label: 'Client' },
        { id: 'REPEATER', label: 'Relay' },
        { id: 'DARK', label: 'Dark', warn: true },
        { id: 'ACTIVE', label: 'Active' },
    ];

    class TopologyRoster {
        constructor(hostId, options = {}) {
            this._host = document.getElementById(hostId);
            this._store = options.store;
            this._settings = options.settings;
            this._poller = options.poller;
            this._observer = options.observer === true;
            this._selectedId = null;
            this._nodes = [];
            this._search = '';
            this._filters = new Set(ROLE_FILTERS.map((f) => f.id));
            this._onSelect = options.onSelect || (() => {});
            this._onAction = options.onAction || (() => {});
            if (this._host) this._build();
        }

        _build() {
            const filterBtns = ROLE_FILTERS.map((f) =>
                `<button type="button" class="topo-rf-btn${f.warn ? ' topo-rf-btn--warn' : ''} topo-rf-btn--on"
                    data-rf="${f.id}">${f.label}</button>`,
            ).join('');

            this._host.innerHTML = `
                <div class="topo-roster__head">
                    <div class="topo-roster__title-row">
                        <span class="topo-sec-lbl">Node roster</span>
                        <span class="topo-sec-badge" id="topo-roster-badge">0 nodes</span>
                    </div>
                    <div class="topo-roster__search-wrap">
                        <span class="topo-roster__search-icon" aria-hidden="true">⌕</span>
                        <input type="search" class="topo-roster__search" id="topo-roster-search"
                            placeholder="Search name, ID, role…" aria-label="Filter nodes" />
                    </div>
                    <div class="topo-roster__filters">${filterBtns}</div>
                </div>
                <div class="topo-roster__list" id="topo-roster-list"></div>
            `;

            document.getElementById('topo-roster-search')?.addEventListener('input', (e) => {
                this._search = (e.target.value || '').trim().toLowerCase();
                this.render(this._nodes);
            });

            this._host.querySelectorAll('[data-rf]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    btn.classList.toggle('topo-rf-btn--on');
                    const id = btn.dataset.rf;
                    if (this._filters.has(id)) this._filters.delete(id);
                    else this._filters.add(id);
                    this.render(this._nodes);
                });
            });
        }

        setSelected(nodeId) {
            this._selectedId = nodeId;
            this.render(this._nodes);
        }

        render(nodes) {
            this._nodes = nodes || [];
            const list = document.getElementById('topo-roster-list');
            const badge = document.getElementById('topo-roster-badge');
            if (!list) return;

            const inactMs = (this._settings?.get('inactMin') || 60) * 60_000;
            const now = Date.now();
            const onlyActive = this._filters.has('ACTIVE');

            const filtered = this._nodes.filter((n) => this._matchesFilters(n, now, inactMs, onlyActive));

            if (badge) {
                badge.textContent = filtered.length === this._nodes.length
                    ? `${this._nodes.length} nodes`
                    : `${filtered.length} / ${this._nodes.length} nodes`;
            }
            list.innerHTML = '';

            if (!filtered.length) {
                list.innerHTML = '<div class="topo-roster__empty">No nodes match filters.</div>';
                return;
            }

            filtered.sort((a, b) => {
                const ta = a.last_heard || a.last_seen;
                const tb = b.last_heard || b.last_seen;
                const tav = ta ? new Date(ta).getTime() : 0;
                const tbv = tb ? new Date(tb).getTime() : 0;
                return tbv - tav;
            });

            for (const n of filtered) {
                list.appendChild(this._cardEl(n, now, inactMs));
            }
        }

        _matchesFilters(n, now, inactMs, onlyActive) {
            const id = n.node_id || n.id;
            const role = this._roleKey(n.role);
            const isDark = !this._hasGps(n);
            const lastHeard = n.last_heard || n.last_seen;
            const lastSeen = lastHeard ? new Date(lastHeard).getTime() : null;
            const inactive = lastSeen && (now - lastSeen) > inactMs;

            if (onlyActive && inactive) return false;

            const roleFiltersOn = this._filters.has('ROUTER')
                || this._filters.has('CLIENT')
                || this._filters.has('REPEATER');

            if (roleFiltersOn) {
                if (isDark) {
                    if (!this._filters.has('DARK')) return false;
                } else if (role === 'ROUTER') {
                    if (!this._filters.has('ROUTER')) return false;
                } else if (role === 'REPEATER') {
                    if (!this._filters.has('REPEATER')) return false;
                } else if (!this._filters.has('CLIENT')) {
                    return false;
                }
            } else if (isDark && !this._filters.has('DARK')) {
                return false;
            }

            if (this._search) {
                const blob = [
                    n.display_name, n.long_name, n.short_name, id, role,
                ].join(' ').toLowerCase();
                if (!blob.includes(this._search)) return false;
            }
            return true;
        }

        _hasGps(n) {
            const lat = n?.latitude;
            const lon = n?.longitude;
            if (lat == null || lon == null) return false;
            if (lat === 0 && lon === 0) return false;
            return true;
        }

        _cardEl(n, now, inactMs) {
            const id = n.node_id || n.id;
            const lastHeard = n.last_heard || n.last_seen;
            const lastSeen = lastHeard ? new Date(lastHeard).getTime() : null;
            const inactive = lastSeen && (now - lastSeen) > inactMs;
            const isDark = !this._hasGps(n);
            const isStatic = this._poller?.isStatic(id);
            const queued = this._poller?.isQueued(id);
            const hasTrace = !!this._poller?.getTraceMeta(id);
            const role = this._roleKey(n.role);

            const name = n.display_name || n.long_name || n.short_name || `!${String(id).slice(-6)}`;
            const initials = (n.short_name || name).slice(0, 2).toUpperCase();
            const rssi = n.rssi ?? n.latest_rssi;
            const snr = n.latest_snr ?? n.snr;
            const chUtil = n.latest_channel_util;
            const battery = n.latest_battery;

            const card = document.createElement('article');
            card.className = 'topo-nc'
                + (this._selectedId === id ? ' topo-nc--selected' : '')
                + (inactive ? ' topo-nc--inactive' : '');
            card.dataset.nodeId = id;

            const rssiCls = rssi == null ? '' : rssi > -90 ? 'topo-nc__val--good' : rssi > -110 ? 'topo-nc__val--mid' : 'topo-nc__val--bad';
            const battCls = battery == null ? '' : battery > 50 ? 'topo-nc__val--good' : battery > 15 ? 'topo-nc__val--mid' : 'topo-nc__val--bad';
            const iconCol = isDark ? 'var(--accent-purple)' : role === 'ROUTER' || role === 'REPEATER'
                ? (rssi > -90 ? 'var(--accent-green)' : rssi > -110 ? 'var(--accent-amber)' : 'var(--accent-red)')
                : 'var(--text-muted)';

            const roleTagCls = isDark ? 'topo-role--dark'
                : role === 'ROUTER' ? 'topo-role--router'
                    : role === 'REPEATER' ? 'topo-role--relay' : 'topo-role--client';
            const roleLabel = isDark ? 'DARK' : role;

            let chUtilHtml = '';
            if (chUtil != null) {
                const pct = Math.min(100, Math.max(0, chUtil));
                const chCol = pct < 25 ? 'var(--accent-green)' : pct < 50 ? 'var(--accent-amber)' : 'var(--accent-red)';
                chUtilHtml = `
                    <div class="topo-nc__util-row">
                        <div class="topo-nc__util-bar"><div class="topo-nc__util-fill"
                            style="width:${pct}%;background:${chCol}"></div></div>
                        <span class="topo-nc__util-pct">${pct.toFixed(0)}%</span>
                        <span class="topo-role-tag ${roleTagCls}">${roleLabel}</span>
                    </div>`;
            } else {
                chUtilHtml = `<div class="topo-nc__util-row"><span class="topo-role-tag ${roleTagCls}">${roleLabel}</span></div>`;
            }

            const actions = this._observer ? '' : `
                <div class="topo-nc__actions">
                    <button type="button" class="topo-nc__btn${queued ? ' topo-nc__btn--tracing' : ''}"
                        data-act="trace" title="Traceroute">↯ trace</button>
                    <button type="button" class="topo-nc__btn" data-act="json" title="Raw JSON">🔍 JSON</button>
                    <button type="button" class="topo-nc__btn" data-act="center" title="Center map">🌐</button>
                    <button type="button" class="topo-nc__btn" data-act="position" title="Request position">📡</button>
                </div>`;

            card.innerHTML = `
                <div class="topo-nc__top">
                    <div class="topo-nc__icon" style="border-color:${iconCol};color:${iconCol}">${this._esc(initials)}</div>
                    <span class="topo-nc__name">${this._esc(name)}</span>
                    <span class="topo-nc__ago">${this._ago(lastSeen)}</span>
                </div>
                ${chUtilHtml}
                <div class="topo-nc__sig">
                    ${rssi != null ? `<span><span class="topo-nc__val ${rssiCls}">${Math.round(rssi)}</span> dBm</span>` : ''}
                    ${snr != null ? `<span><span class="topo-nc__val">${Number(snr).toFixed(1)}</span> dB</span>` : ''}
                    ${battery != null && battery > 0 ? `<span>🔋 <span class="topo-nc__val ${battCls}">${battery}</span>%</span>` : ''}
                    ${isStatic ? '<span>📌</span>' : '<span>📱</span>'}
                    ${hasTrace ? '<span class="topo-nc__trace-ok">✓ trace</span>' : ''}
                </div>
                ${actions}
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('[data-act]')) return;
                this._selectedId = id;
                this._onSelect(n);
                this.render(this._nodes);
            });

            card.querySelectorAll('[data-act]').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._onAction(btn.dataset.act, n);
                });
            });

            return card;
        }

        _roleKey(role) {
            const map = { 0: 'CLIENT', 1: 'CLIENT', 2: 'ROUTER', 3: 'ROUTER', 4: 'REPEATER' };
            if (role == null) return 'CLIENT';
            const n = Number(role);
            if (!Number.isNaN(n) && map[n]) return map[n];
            const t = String(role).toUpperCase();
            if (t.includes('ROUTER')) return 'ROUTER';
            if (t.includes('REPEAT')) return 'REPEATER';
            return t;
        }

        _ago(ts) {
            if (!ts) return '—';
            const s = Math.floor((Date.now() - ts) / 1000);
            if (s < 60) return `${s}s`;
            if (s < 3600) return `${Math.floor(s / 60)}m`;
            return `${Math.floor(s / 3600)}h`;
        }

        _esc(text) {
            const el = document.createElement('span');
            el.textContent = text == null ? '' : String(text);
            return el.innerHTML;
        }
    }

    window.TopologyRoster = TopologyRoster;
})();
