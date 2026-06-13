/**
 * Full-screen packet browser tab — Malla-style filters, security flags, export.
 * Uses existing /api/packets and live WebSocket ingest from app.js.
 */
class PacketsTab {
    constructor(containerId) {
        this._container = document.getElementById(containerId);
        this._rendered = false;
        this._packets = [];
        this._filtered = [];
        this._page = 0;
        this._pageSize = 50;
        this._maxBuffer = 5000;
        this._paused = false;
        this._sortKey = 'time';
        this._sortDir = -1;
        this._knownNodes = new Set();
        this._newNodes = new Set();
        this._nodeNames = new Map();
        this._rateWindow = [];
        this._filters = {
            search: '',
            types: new Set(['text', 'position', 'nodeinfo', 'telemetry', 'traceroute', 'neighborinfo', 'routing', 'admin', 'other']),
            sfs: new Set([7, 8, 9, 10, 11, 12]),
            rssiMin: -140,
            maxHops: 7,
            secOnly: false,
            newOnly: false,
        };

        if (this._container && !this._container.querySelector('.packets-workspace')) {
            this._container.innerHTML =
                '<div class="packets-panel__loading">Loading packet browser…</div>';
        }
    }

    async refresh() {
        if (!this._container) return;

        try {
            if (!this._rendered) {
                this._buildLayout();
                this._rendered = true;
            }
            await this._loadHistory();
            this._applyFilters();
            this._render();
        } catch (e) {
            console.error('Packets tab refresh failed:', e);
            if (!this._rendered) {
                this._container.innerHTML =
                    '<div class="packets-panel__loading">Failed to load packet browser. Refresh the page.</div>';
            }
        }
    }

    ingestPacket(raw) {
        if (this._paused || !raw) return;
        const row = this._enrich(raw, { trackNew: true });
        this._rateWindow.push(Date.now());
        const cutoff = Date.now() - 60000;
        this._rateWindow = this._rateWindow.filter((t) => t > cutoff);

        this._packets.unshift(row);
        if (this._packets.length > this._maxBuffer) {
            this._packets.length = this._maxBuffer;
        }
        this._applyFilters();
        if (this._rendered) this._render();
    }

    _buildLayout() {
        this._container.innerHTML = `
            <div class="packets-workspace">
                <div class="packets-toolbar">
                    <div class="packets-toolbar__group">
                        <span class="packets-live"><span id="pkt-live-dot" class="packets-live__dot"></span><span id="pkt-live-label">Live</span></span>
                    </div>
                    <div class="packets-toolbar__sep"></div>
                    <div class="packets-toolbar__group">
                        <span class="packets-toolbar__label">Type</span>
                        <span id="pkt-type-chips"></span>
                    </div>
                    <div class="packets-toolbar__sep"></div>
                    <div class="packets-toolbar__group">
                        <span class="packets-toolbar__label">SF</span>
                        <span id="pkt-sf-chips"></span>
                    </div>
                    <div class="packets-toolbar__sep"></div>
                    <label class="packets-range">RSSI ≥ <span id="pkt-rssi-val">-140</span>
                        <input type="range" id="pkt-rssi" min="-140" max="-60" value="-140" step="5" />
                    </label>
                    <label class="packets-range">Max hops
                        <input type="number" id="pkt-hops" min="0" max="7" value="7" />
                    </label>
                    <input type="text" id="pkt-search" class="packets-search" placeholder="Search nodes, body…" />
                    <div class="packets-toolbar__sep"></div>
                    <button type="button" class="packets-btn" id="pkt-sec-only">Security only</button>
                    <button type="button" class="packets-btn" id="pkt-new-only">New nodes</button>
                    <button type="button" class="packets-btn packets-btn--warn" id="pkt-pause">Pause</button>
                    <button type="button" class="packets-btn packets-btn--primary" id="pkt-csv">↓ CSV</button>
                    <button type="button" class="packets-btn" id="pkt-json">↓ JSON</button>
                </div>
                <div class="packets-stats">
                    <span class="packets-stat">Buffered <strong id="pkt-stat-total">0</strong></span>
                    <span class="packets-stat">Filtered <strong id="pkt-stat-filtered">0</strong></span>
                    <span class="packets-stat">Rate/min <strong id="pkt-stat-rate">0</strong></span>
                    <span class="packets-stat">Nodes <strong id="pkt-stat-nodes">0</strong></span>
                    <span class="packets-stat">Flags <strong class="warn" id="pkt-stat-sec">0</strong></span>
                    <div class="packets-sec-badges" id="pkt-sec-badges"></div>
                </div>
                <div class="packets-table-wrap">
                    <table class="packets-table">
                        <thead>
                            <tr>
                                <th data-sort="time">Time</th>
                                <th data-sort="source">Source</th>
                                <th data-sort="dest">Dest</th>
                                <th data-sort="type">Type</th>
                                <th data-sort="sf">SF</th>
                                <th data-sort="rssi">RSSI</th>
                                <th data-sort="snr">SNR</th>
                                <th data-sort="hops">Hops</th>
                                <th>Flags</th>
                                <th>Body</th>
                            </tr>
                        </thead>
                        <tbody id="pkt-tbody"></tbody>
                    </table>
                    <div id="pkt-empty" class="packets-empty" hidden>No packets match current filters.</div>
                </div>
                <div class="packets-pager">
                    <button type="button" class="packets-btn" id="pkt-pg-first">«</button>
                    <button type="button" class="packets-btn" id="pkt-pg-prev">‹</button>
                    <span id="pkt-pg-btns"></span>
                    <button type="button" class="packets-btn" id="pkt-pg-next">›</button>
                    <button type="button" class="packets-btn" id="pkt-pg-last">»</button>
                    <span class="packets-pager__spacer"></span>
                    <span id="pkt-pg-info"></span>
                </div>
            </div>
        `;

        this._renderTypeChips();
        this._renderSfChips();
        this._bindControls();
    }

    _typeDefs() {
        return [
            ['text', 'Text'], ['position', 'Pos'], ['nodeinfo', 'Node'],
            ['telemetry', 'Telem'], ['traceroute', 'Trace'], ['neighborinfo', 'Neigh'],
            ['routing', 'Route'], ['admin', 'Admin'], ['other', 'Other'],
        ];
    }

    _renderTypeChips() {
        const host = document.getElementById('pkt-type-chips');
        if (!host) return;
        host.innerHTML = this._typeDefs().map(([id, label]) =>
            `<button type="button" class="packets-chip packets-chip--on" data-type="${id}">${label}</button>`,
        ).join('');
        host.querySelectorAll('[data-type]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const t = btn.dataset.type;
                if (this._filters.types.has(t)) {
                    this._filters.types.delete(t);
                    btn.classList.remove('packets-chip--on');
                } else {
                    this._filters.types.add(t);
                    btn.classList.add('packets-chip--on');
                }
                this._page = 0;
                this._applyFilters();
                this._render();
            });
        });
    }

    _renderSfChips() {
        const host = document.getElementById('pkt-sf-chips');
        if (!host) return;
        host.innerHTML = [7, 8, 9, 10, 11, 12].map((sf) =>
            `<button type="button" class="packets-chip packets-chip--on" data-sf="${sf}">SF${sf}</button>`,
        ).join('');
        host.querySelectorAll('[data-sf]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sf = Number(btn.dataset.sf);
                if (this._filters.sfs.has(sf)) {
                    this._filters.sfs.delete(sf);
                    btn.classList.remove('packets-chip--on');
                } else {
                    this._filters.sfs.add(sf);
                    btn.classList.add('packets-chip--on');
                }
                this._page = 0;
                this._applyFilters();
                this._render();
            });
        });
    }

    _bindControls() {
        document.getElementById('pkt-search')?.addEventListener('input', (e) => {
            this._filters.search = (e.target.value || '').trim().toLowerCase();
            this._page = 0;
            this._applyFilters();
            this._render();
        });

        document.getElementById('pkt-rssi')?.addEventListener('input', (e) => {
            this._filters.rssiMin = Number(e.target.value);
            document.getElementById('pkt-rssi-val').textContent = e.target.value;
            this._page = 0;
            this._applyFilters();
            this._render();
        });

        document.getElementById('pkt-hops')?.addEventListener('change', (e) => {
            this._filters.maxHops = Number(e.target.value) || 7;
            this._page = 0;
            this._applyFilters();
            this._render();
        });

        const toggleBtn = (id, key) => {
            document.getElementById(id)?.addEventListener('click', (e) => {
                this._filters[key] = !this._filters[key];
                e.currentTarget.classList.toggle('packets-btn--active', this._filters[key]);
                this._page = 0;
                this._applyFilters();
                this._render();
            });
        };
        toggleBtn('pkt-sec-only', 'secOnly');
        toggleBtn('pkt-new-only', 'newOnly');

        document.getElementById('pkt-pause')?.addEventListener('click', (e) => {
            this._paused = !this._paused;
            e.currentTarget.textContent = this._paused ? 'Resume' : 'Pause';
            e.currentTarget.classList.toggle('packets-btn--active', this._paused);
            document.getElementById('pkt-live-dot')?.classList.toggle('packets-live__dot--paused', this._paused);
            document.getElementById('pkt-live-label').textContent = this._paused ? 'Paused' : 'Live';
        });

        document.getElementById('pkt-csv')?.addEventListener('click', () => this._exportCsv());
        document.getElementById('pkt-json')?.addEventListener('click', () => this._exportJson());

        this._container.querySelectorAll('th[data-sort]').forEach((th) => {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                if (this._sortKey === key) {
                    this._sortDir *= -1;
                } else {
                    this._sortKey = key;
                    this._sortDir = key === 'time' ? -1 : 1;
                }
                this._applyFilters();
                this._render();
            });
        });

        document.getElementById('pkt-pg-first')?.addEventListener('click', () => { this._page = 0; this._renderTable(); });
        document.getElementById('pkt-pg-prev')?.addEventListener('click', () => { this._page = Math.max(0, this._page - 1); this._renderTable(); });
        document.getElementById('pkt-pg-next')?.addEventListener('click', () => {
            const max = Math.max(0, Math.ceil(this._filtered.length / this._pageSize) - 1);
            this._page = Math.min(max, this._page + 1);
            this._renderTable();
        });
        document.getElementById('pkt-pg-last')?.addEventListener('click', () => {
            this._page = Math.max(0, Math.ceil(this._filtered.length / this._pageSize) - 1);
            this._renderTable();
        });
    }

    async _loadHistory() {
        try {
            const res = await fetch('/api/packets?limit=500');
            if (!res.ok) return;
            const rows = await res.json();
            const list = Array.isArray(rows) ? rows : (rows.packets || []);
            this._packets = list.map((p) => this._enrich(p, { trackNew: false })).reverse();
            if (this._packets.length > this._maxBuffer) {
                this._packets.length = this._maxBuffer;
            }
        } catch (e) {
            console.error('Packet history load failed:', e);
        }
    }

    _enrich(raw, options = {}) {
        const trackNew = options.trackNew !== false;
        const sig = raw.signal || {};
        const rssi = sig.rssi != null ? sig.rssi : raw.rssi;
        const snr = sig.snr != null ? sig.snr : raw.snr;
        const sf = sig.spreading_factor || raw.spreading_factor || null;
        const type = raw.packet_type || 'other';
        const cat = this._typeDefs().some(([t]) => t === type) ? type : 'other';
        const hopStart = raw.hop_start ?? 0;
        const hopLimit = raw.hop_limit ?? 0;
        const hops = hopStart > 0 ? hopStart - hopLimit : 0;
        const time = raw.rx_time
            ? raw.rx_time * 1000
            : new Date(raw.timestamp || Date.now()).getTime();

        const payload = raw.decoded_payload;
        let body = '—';
        if (payload && typeof payload === 'object') {
            if (type === 'text') body = payload.text || '—';
            else if (type === 'position') {
                body = [payload.latitude, payload.longitude].filter((v) => v != null).join(', ') || '—';
            } else if (type === 'nodeinfo') {
                body = [payload.long_name, payload.short_name].filter(Boolean).join(' ') || '—';
                if (payload.short_name && raw.source_id) {
                    const prev = this._nodeNames.get(raw.source_id);
                    if (prev && prev !== payload.short_name) {
                        raw._dupName = true;
                    }
                    this._nodeNames.set(raw.source_id, payload.short_name);
                }
            } else if (type === 'traceroute' && payload.route) {
                body = payload.route.join(' → ');
            } else if (type === 'neighborinfo' && payload.neighbors) {
                body = `${payload.neighbors.length} neighbors`;
            } else {
                body = JSON.stringify(payload).slice(0, 80);
            }
        }

        let isNew = false;
        if (trackNew && raw.source_id && !this._knownNodes.has(raw.source_id)) {
            this._knownNodes.add(raw.source_id);
            this._newNodes.add(raw.source_id);
            isNew = true;
            setTimeout(() => this._newNodes.delete(raw.source_id), 5 * 60 * 1000);
        } else if (raw.source_id) {
            this._knownNodes.add(raw.source_id);
        }

        const secFlags = [];
        if (type === 'admin') secFlags.push('ADMIN_OTA');
        if (hopStart > 5) secFlags.push('EXCESS_HOPS');
        if (raw._dupName) secFlags.push('DUP_ID');
        if (raw.decrypted === false && ['text', 'position', 'nodeinfo'].includes(type)) {
            secFlags.push('WEAK_KEY');
        }

        return {
            raw,
            id: raw.packet_id || `${raw.source_id}-${time}`,
            time,
            source: raw.source_id,
            dest: raw.destination_id,
            type: cat,
            protocol: raw.protocol || 'meshtastic',
            rssi,
            snr,
            sf,
            hops,
            hopStart,
            hopLimit,
            channel: raw.channel_hash,
            body,
            secFlags,
            isNew,
        };
    }

    _applyFilters() {
        const f = this._filters;
        const q = f.search;

        this._filtered = this._packets.filter((p) => {
            if (!f.types.has(p.type)) return false;
            if (p.sf != null && !f.sfs.has(Number(p.sf))) return false;
            if (p.rssi != null && p.rssi < f.rssiMin) return false;
            if (p.hops > f.maxHops) return false;
            if (f.secOnly && !p.secFlags.length) return false;
            if (f.newOnly && !p.isNew) return false;
            if (q) {
                const blob = [p.source, p.dest, p.body, p.type, p.protocol].join(' ').toLowerCase();
                if (!blob.includes(q)) return false;
            }
            return true;
        });

        const dir = this._sortDir;
        this._filtered.sort((a, b) => {
            let av; let bv;
            switch (this._sortKey) {
                case 'source': av = a.source; bv = b.source; break;
                case 'dest': av = a.dest; bv = b.dest; break;
                case 'type': av = a.type; bv = b.type; break;
                case 'sf': av = a.sf ?? -1; bv = b.sf ?? -1; break;
                case 'rssi': av = a.rssi ?? -999; bv = b.rssi ?? -999; break;
                case 'snr': av = a.snr ?? -999; bv = b.snr ?? -999; break;
                case 'hops': av = a.hops; bv = b.hops; break;
                default: av = a.time; bv = b.time;
            }
            if (av < bv) return -dir;
            if (av > bv) return dir;
            return 0;
        });

        const maxPage = Math.max(0, Math.ceil(this._filtered.length / this._pageSize) - 1);
        if (this._page > maxPage) this._page = 0;
    }

    _render() {
        this._renderStats();
        this._renderTable();
        this._container.querySelectorAll('th[data-sort]').forEach((th) => {
            th.classList.toggle('sorted', th.dataset.sort === this._sortKey);
        });
    }

    _renderStats() {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val);
        };
        set('pkt-stat-total', this._packets.length);
        set('pkt-stat-filtered', this._filtered.length);
        set('pkt-stat-rate', this._rateWindow.length);
        set('pkt-stat-nodes', this._knownNodes.size);
        const secCount = this._packets.filter((p) => p.secFlags.length).length;
        set('pkt-stat-sec', secCount);

        const badges = document.getElementById('pkt-sec-badges');
        if (badges) {
            const counts = {};
            for (const p of this._packets) {
                for (const f of p.secFlags) counts[f] = (counts[f] || 0) + 1;
            }
            badges.innerHTML = Object.entries(counts).map(([k, n]) =>
                `<span class="packets-sec-badge ${k === 'ADMIN_OTA' ? 'packets-sec-badge--crit' : ''}">${k.replace('_', ' ')} ×${n}</span>`,
            ).join('');
        }
    }

    _renderTable() {
        const tbody = document.getElementById('pkt-tbody');
        const empty = document.getElementById('pkt-empty');
        if (!tbody) return;

        const start = this._page * this._pageSize;
        const slice = this._filtered.slice(start, start + this._pageSize);

        if (!slice.length) {
            tbody.innerHTML = '';
            if (empty) empty.hidden = false;
            this._renderPager();
            return;
        }
        if (empty) empty.hidden = true;

        tbody.innerHTML = slice.map((p) => {
            const rCls = p.rssi == null ? '' : p.rssi >= -90 ? 'pkt-rssi-good' : p.rssi >= -110 ? 'pkt-rssi-mid' : 'pkt-rssi-bad';
            let rowCls = '';
            if (p.secFlags.includes('ADMIN_OTA')) rowCls = 'flagged-crit';
            else if (p.secFlags.length) rowCls = 'flagged-sec';
            else if (p.isNew) rowCls = 'flagged-new';
            const flags = [
                ...p.secFlags.map((f) => `<span title="${f}">⚠</span>`),
                p.isNew ? '<span title="New node">★</span>' : '',
            ].join(' ');
            return `<tr class="${rowCls}" data-id="${this._esc(p.id)}">
                <td>${this._fmtTime(p.time)}</td>
                <td>${this._fmtNode(p.source)}</td>
                <td>${this._fmtNode(p.dest) || '<span style="opacity:.5">—</span>'}</td>
                <td><span class="pkt-badge pkt-badge--${p.type in { text:1, position:1, nodeinfo:1, telemetry:1, traceroute:1, admin:1 } ? p.type : 'other'}">${p.type}</span></td>
                <td>${p.sf ? `<span class="pkt-sf">SF${p.sf}</span>` : '—'}</td>
                <td class="${rCls}">${p.rssi != null ? p.rssi : '—'}</td>
                <td>${p.snr != null ? Number(p.snr).toFixed(1) : '—'}</td>
                <td>${p.hops}</td>
                <td>${flags}</td>
                <td style="max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(p.body)}</td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
            tr.addEventListener('click', () => {
                const row = this._filtered.find((p) => p.id === tr.dataset.id)
                    || this._packets.find((p) => p.id === tr.dataset.id);
                if (!row) return;
                tbody.querySelectorAll('tr').forEach((r) => r.classList.remove('selected'));
                tr.classList.add('selected');
                if (window.PacketDetailModal) {
                    window.PacketDetailModal.show(row.raw, { selectedRow: tr });
                }
            });
        });

        this._renderPager();
    }

    _renderPager() {
        const total = this._filtered.length;
        const pages = Math.max(1, Math.ceil(total / this._pageSize));
        const cur = this._page;
        const info = document.getElementById('pkt-pg-info');
        const start = total ? cur * this._pageSize + 1 : 0;
        const end = Math.min(total, (cur + 1) * this._pageSize);
        if (info) info.textContent = total ? `${start}–${end} of ${total}` : '0 results';

        ['pkt-pg-first', 'pkt-pg-prev'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = cur === 0;
        });
        ['pkt-pg-next', 'pkt-pg-last'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = cur >= pages - 1;
        });

        const host = document.getElementById('pkt-pg-btns');
        if (!host) return;
        host.innerHTML = '';
        const win = 5;
        let lo = Math.max(0, cur - Math.floor(win / 2));
        let hi = Math.min(pages - 1, lo + win - 1);
        lo = Math.max(0, hi - win + 1);
        for (let i = lo; i <= hi; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `packets-btn ${i === cur ? 'packets-btn--active' : ''}`;
            btn.textContent = String(i + 1);
            btn.addEventListener('click', () => {
                this._page = i;
                this._renderTable();
            });
            host.appendChild(btn);
        }
    }

    _exportCsv() {
        const header = ['time', 'protocol', 'source', 'dest', 'type', 'sf', 'rssi', 'snr', 'hops', 'flags', 'body'];
        const lines = [header.join(',')];
        for (const p of this._filtered) {
            lines.push([
                new Date(p.time).toISOString(),
                p.protocol,
                p.source,
                p.dest || '',
                p.type,
                p.sf ?? '',
                p.rssi ?? '',
                p.snr ?? '',
                p.hops,
                p.secFlags.join('|'),
                `"${String(p.body).replace(/"/g, '""')}"`,
            ].join(','));
        }
        this._download('meshpoint-packets.csv', lines.join('\n'), 'text/csv');
    }

    _exportJson() {
        const payload = {
            exported_at: new Date().toISOString(),
            filters: {
                search: this._filters.search,
                types: [...this._filters.types],
                rssi_min: this._filters.rssiMin,
                max_hops: this._filters.maxHops,
                sec_only: this._filters.secOnly,
            },
            count: this._filtered.length,
            packets: this._filtered.map((p) => ({
                ...p.raw,
                _sec_flags: p.secFlags,
            })),
        };
        this._download('meshpoint-packets.json', JSON.stringify(payload, null, 2), 'application/json');
    }

    _download(name, body, mime) {
        const blob = new Blob([body], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }

    _fmtTime(ts) {
        return new Date(ts).toLocaleTimeString();
    }

    _fmtNode(id) {
        if (!id) return '';
        if (id === 'ffffffff' || id === 'ffff') return 'BCAST';
        return id.length > 6 ? `!${id.slice(-4)}` : id;
    }

    _esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }
}

window.packetsTab = new PacketsTab('packets-panel');
