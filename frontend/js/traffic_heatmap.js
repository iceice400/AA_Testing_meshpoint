/**
 * SVG traffic heatmap: hour columns × protocol rows (Meshtastic / MeshCore).
 * Consumes buckets from GET /api/stats/hourly (same shape as the 24h chart).
 */
class TrafficHeatmap {
    constructor(svgEl) {
        this._svg = svgEl;
    }

    _cssToken(name, fallback) {
        return getComputedStyle(document.documentElement)
            .getPropertyValue(name).trim() || fallback;
    }

    /**
     * @param {Array<{hour:string,meshtastic:number,meshcore:number,total:number}>} buckets
     */
    render(buckets) {
        if (!this._svg) return;
        const rows = Array.isArray(buckets) ? buckets : [];
        const cols = rows.length || 24;
        const padL = 72;
        const padT = 12;
        const padB = 28;
        const padR = 8;
        const rowH = 18;
        const gap = 2;
        const width = Math.max(320, padL + padR + cols * 14);
        const height = padT + padB + rowH * 2 + gap;

        const accentCyan = this._cssToken('--accent-cyan', '#06b6d4');
        const accentPurple = this._cssToken('--accent-purple', '#a855f7');
        const textMuted = this._cssToken('--text-muted', '#64748b');
        const border = this._cssToken('--border', '#233049');

        const mt = rows.map((b) => b.meshtastic || 0);
        const mc = rows.map((b) => b.meshcore || 0);
        const maxMt = Math.max(1, ...mt);
        const maxMc = Math.max(1, ...mc);

        const cellW = (width - padL - padR - (cols - 1) * gap) / cols;

        const parts = [
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"`,
            ` role="img" aria-label="24 hour protocol traffic heatmap" class="stats-heatmap__svg">`,
        ];

        const rowLabel = (y, label) =>
            `<text x="4" y="${y + rowH * 0.72}" fill="${textMuted}" `
            + `font-family="var(--font-mono)" font-size="9">${label}</text>`;

        parts.push(rowLabel(padT, 'MT'));
        parts.push(rowLabel(padT + rowH + gap, 'MC'));

        rows.forEach((bucket, i) => {
            const x = padL + i * (cellW + gap);
            const hourLabel = TrafficHeatmap._hourLabel(bucket.hour);
            const mtVal = bucket.meshtastic || 0;
            const mcVal = bucket.meshcore || 0;
            const mtFill = TrafficHeatmap._alphaFill(accentCyan, mtVal / maxMt);
            const mcFill = TrafficHeatmap._alphaFill(accentPurple, mcVal / maxMc);
            const title = `${hourLabel}: MT ${mtVal}, MC ${mcVal}, total ${bucket.total || 0}`;

            parts.push(
                `<rect x="${x.toFixed(1)}" y="${padT}" width="${cellW.toFixed(1)}" `
                + `height="${rowH}" rx="2" fill="${mtFill}" stroke="${border}" stroke-width="0.5">`
                + `<title>${title}</title></rect>`,
            );
            parts.push(
                `<rect x="${x.toFixed(1)}" y="${(padT + rowH + gap).toFixed(1)}" `
                + `width="${cellW.toFixed(1)}" height="${rowH}" rx="2" fill="${mcFill}" `
                + `stroke="${border}" stroke-width="0.5"><title>${title}</title></rect>`,
            );

            if (i % 3 === 0 || i === rows.length - 1) {
                const lx = x + cellW / 2;
                const ly = height - 6;
                parts.push(
                    `<text x="${lx.toFixed(1)}" y="${ly}" text-anchor="middle" `
                    + `fill="${textMuted}" font-family="var(--font-mono)" font-size="8">`
                    + `${hourLabel}</text>`,
                );
            }
        });

        parts.push('</svg>');
        this._svg.innerHTML = parts.join('');
    }

    static _hourLabel(iso) {
        if (!iso) return '--';
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: 'numeric' });
        } catch (_e) {
            return '--';
        }
    }

    static _alphaFill(hex, ratio) {
        const t = Math.max(0.08, Math.min(1, ratio));
        const h = hex.replace('#', '');
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        return `rgba(${r},${g},${b},${t.toFixed(2)})`;
    }
}

window.TrafficHeatmap = TrafficHeatmap;
