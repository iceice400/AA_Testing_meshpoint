/**
 * Configuration → Advanced card.
 *
 * Storage retention, SX1302/SX1303 spectral scan, GPS/PPS timestamp sync,
 * and topology background polling.
 */

class AdvancedConfigCard {
    constructor(api) {
        this._api = api;
        this._root = null;
        this._ppsTimer = null;
    }

    mount(root) {
        this._root = root;
        this._root.innerHTML = `
            <div class="cfg-section" data-adv-root>
                <article class="cfg-card">
                    <header class="cfg-card__head">
                        <h3 class="cfg-card__title">Storage</h3>
                        <p class="cfg-card__hint">Local SQLite retention on the SD card.</p>
                    </header>
                    <form class="cfg-form" data-storage-form>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Max packets retained</span>
                            <input class="cfg-field__input" type="number" min="1000"
                                   max="10000000" data-storage-max>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Cleanup interval (seconds)</span>
                            <input class="cfg-field__input" type="number" min="60" max="86400"
                                   data-storage-cleanup>
                        </label>
                        <div class="cfg-card__actions">
                            <button class="terminal-button terminal-button--primary"
                                    type="submit">Save storage</button>
                        </div>
                        <p class="cfg-status" data-storage-status aria-live="polite"></p>
                    </form>
                </article>
                <article class="cfg-card">
                    <header class="cfg-card__head">
                        <h3 class="cfg-card__title">Concentrator (SX1302/SX1303)</h3>
                        <p class="cfg-card__hint">
                            Spectral scan powers the RF Environment tab and sidebar noise floor.
                            GPS/PPS aligns RX packet timestamps with UTC (mutually exclusive with
                            GPS source UART on the same TTY).
                        </p>
                    </header>
                    <form class="cfg-form" data-radio-adv-form>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Spectral scan interval (s)</span>
                            <input class="cfg-field__input" type="number" min="0" max="3600"
                                   step="1" data-radio-scan-interval>
                            <span class="cfg-field__hint">0 disables hardware noise-floor scan.</span>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">SX1261 SPI path (optional)</span>
                            <input class="cfg-field__input" type="text"
                                   placeholder="/dev/spidev0.1 or empty" data-radio-sx1261>
                        </label>
                        <label class="cfg-field cfg-field--checkbox">
                            <input type="checkbox" data-gps-pps-enabled>
                            <span class="cfg-field__label">GPS/PPS packet timestamp sync</span>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">PPS GPS UART path</span>
                            <input class="cfg-field__input" type="text"
                                   placeholder="/dev/ttyAMA0" data-gps-pps-tty>
                            <span class="cfg-field__hint">
                                Use gpsd or static for dashboard GPS when PPS owns this port.
                            </span>
                        </label>
                        <p class="cfg-field__hint" data-pps-live-status aria-live="polite"></p>
                        <div class="cfg-card__actions">
                            <button class="terminal-button terminal-button--primary"
                                    type="submit">Save concentrator advanced</button>
                        </div>
                        <p class="cfg-status" data-radio-adv-status aria-live="polite"></p>
                    </form>
                </article>
                <article class="cfg-card">
                    <header class="cfg-card__head">
                        <h3 class="cfg-card__title">Topology polling</h3>
                        <p class="cfg-card__hint">
                            Background traceroute probes to router nodes. Requires Meshtastic TX.
                            Manual traces from the Topology tab work regardless.
                        </p>
                    </header>
                    <form class="cfg-form" data-topology-form>
                        <label class="cfg-field cfg-field--checkbox">
                            <input type="checkbox" data-topo-poll-enabled>
                            <span class="cfg-field__label">Enable background topology poller</span>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Poll interval (minutes)</span>
                            <input class="cfg-field__input" type="number" min="1" max="1440"
                                   data-topo-poll-interval>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Max traceroutes per cycle</span>
                            <input class="cfg-field__input" type="number" min="1" max="100"
                                   data-topo-max-polls>
                        </label>
                        <label class="cfg-field cfg-field--checkbox">
                            <input type="checkbox" data-topo-infer-dark>
                            <span class="cfg-field__label">Infer dark-node positions</span>
                        </label>
                        <div class="cfg-card__actions">
                            <button class="terminal-button terminal-button--primary"
                                    type="submit">Save topology polling</button>
                        </div>
                        <p class="cfg-status" data-topology-status aria-live="polite"></p>
                    </form>
                </article>
            </div>
        `;
        this._storageForm = this._root.querySelector('[data-storage-form]');
        this._radioAdvForm = this._root.querySelector('[data-radio-adv-form]');
        this._topologyForm = this._root.querySelector('[data-topology-form]');
        this._storageForm.addEventListener('submit', (e) => this._saveStorage(e));
        this._radioAdvForm.addEventListener('submit', (e) => this._saveRadioAdv(e));
        this._topologyForm.addEventListener('submit', (e) => this._saveTopology(e));
    }

    render(config) {
        const storage = config.storage || {};
        const radioAdv = config.radio_advanced || {};
        const topo = config.topology || {};

        this._setVal('[data-storage-max]', storage.max_packets_retained);
        this._setVal('[data-storage-cleanup]', storage.cleanup_interval_seconds);
        this._setVal('[data-radio-scan-interval]', radioAdv.spectral_scan_interval_seconds);
        this._setVal('[data-radio-sx1261]', radioAdv.sx1261_spi_path || '');
        this._setChecked('[data-gps-pps-enabled]', radioAdv.gps_pps_enabled === true);
        this._setVal('[data-gps-pps-tty]', radioAdv.gps_pps_tty_path || '/dev/ttyAMA0');
        this._setChecked('[data-topo-poll-enabled]', topo.poll_enabled === true);
        this._setVal('[data-topo-poll-interval]', topo.poll_interval_minutes ?? 15);
        this._setVal('[data-topo-max-polls]', topo.max_polls_per_cycle ?? 10);
        this._setChecked('[data-topo-infer-dark]', topo.infer_dark_positions !== false);

        this._refreshPpsStatus();
    }

    unmount() {
        if (this._ppsTimer) {
            clearInterval(this._ppsTimer);
            this._ppsTimer = null;
        }
    }

    _setVal(sel, v) {
        const el = this._root.querySelector(sel);
        if (el && v != null) el.value = v;
    }

    _setChecked(sel, on) {
        const el = this._root.querySelector(sel);
        if (el) el.checked = !!on;
    }

    async _refreshPpsStatus() {
        const el = this._root?.querySelector('[data-pps-live-status]');
        if (!el) return;
        try {
            const res = await fetch('/api/device/gps-pps-status', { credentials: 'same-origin' });
            const data = await res.json().catch(() => ({}));
            if (!data.enabled && !data.available) {
                el.textContent = data.last_error
                    ? `PPS idle — ${data.last_error}`
                    : 'PPS sync off (enable above and restart after saving).';
                return;
            }
            if (data.last_sync_ok) {
                el.textContent = `PPS synced — ${data.sync_count || 0} sync(s), xtal err ${data.xtal_err ?? '—'}`;
            } else {
                el.textContent = data.last_error
                    ? `PPS waiting — ${data.last_error}`
                    : 'PPS enabled — waiting for first sync (outdoor GPS + restart).';
            }
        } catch (e) {
            el.textContent = '';
        }
        if (!this._ppsTimer) {
            this._ppsTimer = setInterval(() => this._refreshPpsStatus(), 15000);
        }
    }

    async _saveStorage(event) {
        event.preventDefault();
        const status = this._root.querySelector('[data-storage-status]');
        status.dataset.kind = 'pending';
        status.textContent = 'Saving…';
        const result = await this._api.put('/api/config/storage', {
            max_packets_retained: Number(
                this._root.querySelector('[data-storage-max]').value,
            ),
            cleanup_interval_seconds: Number(
                this._root.querySelector('[data-storage-cleanup]').value,
            ),
        });
        this._finish(status, result, 'Storage updated.');
    }

    async _saveRadioAdv(event) {
        event.preventDefault();
        const status = this._root.querySelector('[data-radio-adv-status]');
        status.dataset.kind = 'pending';
        status.textContent = 'Saving…';
        const result = await this._api.put('/api/config/radio/advanced', {
            spectral_scan_interval_seconds: Number(
                this._root.querySelector('[data-radio-scan-interval]').value,
            ),
            sx1261_spi_path: this._root.querySelector('[data-radio-sx1261]').value.trim(),
            gps_pps_enabled: this._root.querySelector('[data-gps-pps-enabled]').checked,
            gps_pps_tty_path: this._root.querySelector('[data-gps-pps-tty]').value.trim(),
        });
        this._finish(status, result, 'Concentrator settings updated.');
        if (result?.saved) this._refreshPpsStatus();
    }

    async _saveTopology(event) {
        event.preventDefault();
        const status = this._root.querySelector('[data-topology-status]');
        status.dataset.kind = 'pending';
        status.textContent = 'Saving…';
        const result = await this._api.put('/api/config/topology', {
            poll_enabled: this._root.querySelector('[data-topo-poll-enabled]').checked,
            poll_interval_minutes: Number(
                this._root.querySelector('[data-topo-poll-interval]').value,
            ),
            max_polls_per_cycle: Number(
                this._root.querySelector('[data-topo-max-polls]').value,
            ),
            infer_dark_positions: this._root.querySelector('[data-topo-infer-dark]').checked,
        });
        this._finish(status, result, 'Topology polling updated.');
    }

    _finish(statusEl, result, restartMsg) {
        if (result) {
            statusEl.dataset.kind = 'success';
            statusEl.textContent = 'Saved.';
            if (result.restart_required) {
                this._api.signalRestart(restartMsg);
            } else {
                this._api.toast(restartMsg);
            }
            this._api.refresh();
        } else {
            statusEl.dataset.kind = 'error';
            statusEl.textContent = 'Save failed.';
        }
    }
}

window.AdvancedConfigCard = AdvancedConfigCard;
