/**
 * Configuration → Channels — Quick Deploy QR export.
 *
 * Fetches GET /api/config/export and renders a Meshtastic-compatible
 * channel URL as QR + downloadable JSON. Private PSKs are never shown.
 */

const QR_SCRIPT_SRC = 'vendor/qrcode/qrcode.min.js';

class QuickDeployCard {
    constructor(api) {
        this._api = api;
        this._root = null;
        this._exportData = null;
        this._qrLoadPromise = null;
    }

    mount(root) {
        this._root = root;
        this._root.innerHTML = `
            <article class="cfg-card cfg-card--quick-deploy">
                <header class="cfg-card__head">
                    <h3 class="cfg-card__title">Quick Deploy</h3>
                    <p class="cfg-card__hint">
                        Share public channel settings with field radios.
                        Uses the standard Meshtastic default key only:
                        private channel PSKs are never exported.
                    </p>
                </header>
                <div class="cfg-quick-deploy">
                    <ol class="cfg-quick-deploy__steps">
                        <li>Open the Meshtastic app on a phone or handheld</li>
                        <li>Settings → Channels → Add → Scan QR code</li>
                        <li>Scan the code below (or copy the URL)</li>
                    </ol>
                    <div class="cfg-quick-deploy__qr" data-qr-host>
                        <p class="cfg-quick-deploy__placeholder">Loading…</p>
                    </div>
                    <div class="cfg-quick-deploy__meta" data-export-meta></div>
                    <details class="cfg-quick-deploy__url-details">
                        <summary>Channel URL</summary>
                        <p class="cfg-quick-deploy__url" data-url-text></p>
                    </details>
                    <div class="cfg-card__actions">
                        <button type="button" class="terminal-button"
                                data-copy-url disabled>Copy URL</button>
                        <button type="button" class="terminal-button"
                                data-open-url disabled>Open link</button>
                        <button type="button" class="terminal-button terminal-button--primary"
                                data-download-json disabled>Download JSON</button>
                    </div>
                    <p class="cfg-status" data-quick-deploy-status aria-live="polite"></p>
                </div>
            </article>
        `;

        this._qrHost = this._root.querySelector('[data-qr-host]');
        this._metaEl = this._root.querySelector('[data-export-meta]');
        this._urlTextEl = this._root.querySelector('[data-url-text]');
        this._statusEl = this._root.querySelector('[data-quick-deploy-status]');
        this._copyBtn = this._root.querySelector('[data-copy-url]');
        this._openBtn = this._root.querySelector('[data-open-url]');
        this._downloadBtn = this._root.querySelector('[data-download-json]');

        this._copyBtn.addEventListener('click', () => this._copyUrl());
        this._openBtn.addEventListener('click', () => this._openUrl());
        this._downloadBtn.addEventListener('click', () => this._downloadJson());
    }

    async render(_config) {
        this._setStatus('pending', 'Loading export…');
        const data = await this._api.get('/api/config/export');
        if (!data) {
            this._setStatus('error', 'Could not load export.');
            return;
        }
        this._exportData = data;
        this._paintMeta(data);
        if (this._urlTextEl) {
            this._urlTextEl.textContent = data.meshtastic_url || '';
        }
        await this._paintQr(data.meshtastic_url);
        const hasUrl = Boolean(data.meshtastic_url);
        this._copyBtn.disabled = !hasUrl;
        this._openBtn.disabled = !hasUrl;
        this._downloadBtn.disabled = false;
        this._setStatus('success', hasUrl
            ? 'Ready — scan with the Meshtastic app.'
            : 'Export loaded but no share URL was generated.');
    }

    _paintMeta(data) {
        const rows = [
            ['Channel', data.channel_name],
            ['Preset', data.modem_preset_display || data.modem_preset],
            ['Region', data.region],
            ['Frequency', data.frequency_mhz != null ? `${data.frequency_mhz} MHz` : 'n/a'],
            ['Hop limit', data.hop_limit],
        ];
        this._metaEl.innerHTML = rows.map(([k, v]) => `
            <div class="cfg-quick-deploy__row">
                <span class="cfg-quick-deploy__key">${this._api.escape(k)}</span>
                <span class="cfg-quick-deploy__val">${this._api.escape(String(v ?? 'n/a'))}</span>
            </div>
        `).join('');
    }

    async _ensureQrLibrary() {
        if (typeof window.QRCode !== 'undefined') {
            return true;
        }
        if (!this._qrLoadPromise) {
            this._qrLoadPromise = new Promise((resolve) => {
                const existing = document.querySelector(`script[src="${QR_SCRIPT_SRC}"]`);
                if (existing) {
                    existing.addEventListener('load', () => resolve(typeof window.QRCode !== 'undefined'));
                    existing.addEventListener('error', () => resolve(false));
                    return;
                }
                const script = document.createElement('script');
                script.src = QR_SCRIPT_SRC;
                script.async = true;
                script.onload = () => resolve(typeof window.QRCode !== 'undefined');
                script.onerror = () => resolve(false);
                document.head.appendChild(script);
            });
        }
        return this._qrLoadPromise;
    }

    async _paintQr(url) {
        if (!url) {
            this._qrHost.innerHTML = '<p class="cfg-quick-deploy__placeholder">No URL</p>';
            return;
        }

        const ready = await this._ensureQrLibrary();
        if (!ready) {
            this._qrHost.innerHTML = `
                <p class="cfg-quick-deploy__placeholder">
                    QR library failed to load. Use Copy URL or Open link.
                </p>
            `;
            return;
        }

        this._qrHost.innerHTML = `
            <div class="cfg-quick-deploy__qr-frame">
                <canvas data-qr-canvas aria-label="Meshtastic channel QR code"></canvas>
            </div>
        `;
        const canvas = this._qrHost.querySelector('[data-qr-canvas]');
        try {
            // High-contrast black-on-white scans reliably in the Meshtastic app.
            await window.QRCode.toCanvas(canvas, url, {
                width: 240,
                margin: 2,
                errorCorrectionLevel: 'M',
                color: {
                    dark: '#000000',
                    light: '#ffffff',
                },
            });
        } catch (e) {
            console.error('QR render failed:', e);
            this._qrHost.innerHTML = `
                <p class="cfg-quick-deploy__placeholder">QR render failed — use Copy URL.</p>
            `;
        }
    }

    async _copyUrl() {
        const url = this._exportData && this._exportData.meshtastic_url;
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            this._api.toast('Channel URL copied.');
        } catch (e) {
            this._setStatus('error', 'Copy failed: expand Channel URL and copy manually.');
        }
    }

    _openUrl() {
        const url = this._exportData && this._exportData.meshtastic_url;
        if (!url) return;
        window.open(url, '_blank', 'noopener,noreferrer');
    }

    _downloadJson() {
        if (!this._exportData) return;
        const blob = new Blob(
            [JSON.stringify(this._exportData, null, 2)],
            { type: 'application/json' },
        );
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'meshpoint-quick-deploy.json';
        a.click();
        URL.revokeObjectURL(a.href);
        this._api.toast('JSON downloaded.');
    }

    _setStatus(kind, message) {
        if (!this._statusEl) return;
        this._statusEl.dataset.kind = kind;
        this._statusEl.textContent = message;
    }
}

window.QuickDeployCard = QuickDeployCard;
