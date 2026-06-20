/**
 * Configuration → Hardware diagnostics card.
 *
 * Live concentrator chip (SX1302/SX1303), SPI/libloragw status, GPS probe,
 * and RX error counters from GET /api/device/hardware.
 */

class HardwareConfigCard {
    constructor(api) {
        this._api = api;
        this._root = null;
        this._pollTimer = null;
        this._snapshot = null;
    }

    mount(root) {
        this._root = root;
        this._root.innerHTML = `
            <article class="cfg-card hw-card">
                <header class="cfg-card__head">
                    <h3 class="cfg-card__title">Concentrator hardware</h3>
                    <p class="cfg-card__hint">
                        LoRa concentrator module on the Pi — chip type, SPI link,
                        and capture status. RAK5146 reports as SX1303 (0x12).
                    </p>
                </header>
                <div class="hw-card__body" data-hw-body>
                    <p class="cfg-field__hint">Loading hardware diagnostics…</p>
                </div>
                <div class="cfg-card__actions">
                    <button type="button" class="terminal-button" data-hw-refresh>
                        ↻ Refresh
                    </button>
                </div>
            </article>
        `;
        this._bodyEl = this._root.querySelector('[data-hw-body]');
        this._root.querySelector('[data-hw-refresh]')
            ?.addEventListener('click', () => this.refresh());
        this.refresh();
        this._pollTimer = setInterval(() => this.refresh(), 30_000);
    }

    render(_config) {
        /* Live data comes from /api/device/hardware, not static config. */
    }

    destroy() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    async refresh() {
        const data = await this._api.get('/api/device/hardware');
        if (!data) {
            if (this._bodyEl) {
                this._bodyEl.innerHTML = '<p class="cfg-status cfg-status--err">'
                    + 'Hardware diagnostics unavailable.</p>';
            }
            return;
        }
        this._snapshot = data;
        this._renderSnapshot(data);
    }

    _renderSnapshot(data) {
        if (!this._bodyEl) return;
        const conc = data.concentrator || {};
        const gpsProbe = data.gps_probe || {};
        const gpsRun = data.gps_runtime || {};
        const pps = data.pps_runtime || {};
        const rx = conc.rx_stats || {};

        const chipLine = conc.chip_name
            ? `${conc.chip_name} (${conc.chip_version_hex || '?'})`
            : (conc.chip_version_hex || 'Unknown — service may not have started yet');

        const statusCls = conc.running ? 'hw-pill--ok'
            : (conc.enabled ? 'hw-pill--warn' : 'hw-pill--muted');
        const statusLabel = conc.running ? 'Running'
            : (conc.enabled ? 'Configured, not running' : 'Disabled in config');

        const moduleHint = conc.module_hint
            ? `<p class="hw-card__hint">${this._api.escape(conc.module_hint)}</p>`
            : '';

        const spectral = conc.spectral_scan_supported
            ? 'Hardware spectral scan available'
            : 'Packet-derived noise floor (typical for RAK5146/2287 HAT)';

        const gpsUart = gpsProbe.uart_present
            ? (gpsProbe.has_fix
                ? `Fix (${gpsProbe.latitude}, ${gpsProbe.longitude}) · ${gpsProbe.satellites || 0} sats`
                : `UART present at ${gpsProbe.uart_path}, no fix yet`)
            : `No UART at ${gpsProbe.uart_path || '/dev/ttyAMA0'}`;

        const gpsDash = gpsRun.source
            ? `${gpsRun.source} · ${gpsRun.fix_mode || 'no fix'}`
            : 'Dashboard GPS not polled yet';

        const ppsLine = pps.enabled
            ? `PPS sync ${pps.last_sync_ok ? 'OK' : 'waiting'} · ${pps.tty_path || ''}`
            : 'PPS timestamp sync off';

        this._bodyEl.innerHTML = `
            <div class="hw-card__badges">
                <span class="hw-pill ${statusCls}">${this._api.escape(statusLabel)}</span>
                <span class="hw-pill hw-pill--chip">${this._api.escape(chipLine)}</span>
            </div>
            ${moduleHint}
            <dl class="hw-kv">
                <div class="hw-kv__row">
                    <dt>Carrier board</dt>
                    <dd>${this._api.escape(data.carrier_label || data.carrier_type || '—')}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>Label</dt>
                    <dd>${this._api.escape(data.hardware_description || '—')}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>SPI path</dt>
                    <dd><code>${this._api.escape(conc.spi_path || '—')}</code></dd>
                </div>
                <div class="hw-kv__row">
                    <dt>SPI devices</dt>
                    <dd>${this._api.escape((data.spi_devices || []).join(', ') || 'none')}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>libloragw</dt>
                    <dd>${data.libloragw_installed
        ? `<code>${this._api.escape(data.libloragw_path || 'installed')}</code>`
        : '<span class="hw-kv__warn">Not installed — run install.sh</span>'}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>Capture sources</dt>
                    <dd>${this._api.escape((data.capture_sources || []).join(', ') || 'none')}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>Noise floor</dt>
                    <dd>${this._api.escape(spectral)}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>RX CRC bad</dt>
                    <dd>${Number(rx.crc_bad_total || 0)}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>RX no CRC</dt>
                    <dd>${Number(rx.no_crc_total || 0)}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>HAT GPS (probe)</dt>
                    <dd>${this._api.escape(gpsUart)}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>Dashboard GPS</dt>
                    <dd>${this._api.escape(gpsDash)}</dd>
                </div>
                <div class="hw-kv__row">
                    <dt>HAL PPS</dt>
                    <dd>${this._api.escape(ppsLine)}</dd>
                </div>
            </dl>
        `;
    }
}

window.HardwareConfigCard = HardwareConfigCard;
