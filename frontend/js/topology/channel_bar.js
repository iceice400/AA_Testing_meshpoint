/**
 * Full-width channel utilization bar (reference util-bar layout).
 */
(function () {
    const CHANNEL_LABELS = {
        0: 'Primary',
        1: 'Ch 1',
        2: 'Ch 2',
        3: 'Ch 3',
        4: 'Ch 4',
        5: 'Ch 5',
        6: 'Ch 6',
        7: 'Ch 7',
    };

    class TopologyChannelBar {
        constructor(hostId) {
            this._host = document.getElementById(hostId);
            this._channels = [];
            if (this._host) this._build();
        }

        _build() {
            this._host.innerHTML = '<div class="topo-util-bar" id="topo-util-bar-inner"></div>';
        }

        async refresh(hours = 24) {
            try {
                const res = await fetch(`/api/analytics/topology/channels?hours=${hours}`);
                if (!res.ok) return;
                const data = await res.json();
                this._channels = data.channels || [];
                this.render();
            } catch (e) {
                console.error('Channel bar refresh failed:', e);
            }
        }

        render() {
            const bar = document.getElementById('topo-util-bar-inner');
            if (!bar) return;
            bar.innerHTML = '';
            if (!this._channels.length) {
                bar.innerHTML = '<span class="topo-util-empty">Awaiting channel traffic…</span>';
                return;
            }
            const max = Math.max(1, ...this._channels.map((c) => c.packet_count));
            for (const ch of this._channels.slice(0, 8)) {
                const hash = ch.channel_hash ?? 0;
                const pct = Math.round((ch.packet_count / max) * 100);
                const col = pct < 35 ? 'var(--accent-green)' : pct < 65 ? 'var(--accent-amber)' : 'var(--accent-red)';
                const label = CHANNEL_LABELS[hash] || `0x${hash.toString(16).padStart(2, '0')}`;
                const seg = document.createElement('div');
                seg.className = 'topo-uch';
                seg.title = `${label}: ${ch.packet_count} packets`;
                seg.innerHTML = `
                    <span class="topo-uch-name">${label}</span>
                    <div class="topo-uch-bar-wrap">
                        <div class="topo-uch-bar-fill" style="width:${pct}%;background:${col}"></div>
                    </div>
                    <span class="topo-uch-pct">${ch.packet_count} pkt</span>
                `;
                bar.appendChild(seg);
            }
        }
    }

    window.TopologyChannelBar = TopologyChannelBar;
})();
