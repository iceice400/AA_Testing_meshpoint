/**
 * Settings → System — USB companion firmware flasher (PR 14 + tiers A–C).
 *
 * Tier A: external flasher links, board warnings, reconnect status
 * Tier B: catalog board picker + auto baud/offset
 * Tier C: one-click flash recommended + SHA256 from catalog fetch
 */

class CompanionFlashCard {
    constructor(rootEl) {
        this._host = rootEl;
        this._modal = new window.DangerousModal();
        this._uploadId = null;
        this._filename = '';
        this._catalog = null;
        this._selectedBoardId = null;
        this._selectedRevisionId = null;
        this._lastFetchMeta = null;
        this._ws = null;
        this._logLines = [];
        this._statusPoll = null;
    }

    mount() {
        if (!this._host) return;
        this._host.innerHTML = `
            <article class="auth-card companion-flash-card" id="companion-flash-card">
                <h3 class="auth-card__title">Flash MeshCore USB companion</h3>
                <p class="auth-card__hint">
                    Only <code>companion_radio_usb</code> images — USB serial companion
                    firmware for capture on this Pi. BLE builds (<code>companion_radio_ble</code>)
                    are not supported here.
                </p>

                <div class="companion-flash-external" data-fw-external></div>

                <div class="companion-flash-status" data-fw-companion-status aria-live="polite">
                    Checking companion…
                </div>

                <section class="companion-flash-section">
                    <h4 class="companion-flash-section__title">Flash USB companion from catalog</h4>
                    <p class="auth-card__hint">
                        Downloads the pinned MeshCore <strong>companion_radio_usb</strong> merged
                        build for your board. Never BLE.
                    </p>
                    <label class="cfg-field">
                        <span class="cfg-field__label">Board</span>
                        <select class="cfg-field__input" data-fw-board>
                            <option value="">Loading catalog…</option>
                        </select>
                    </label>
                    <div class="companion-flash-revision" data-fw-revision-wrap hidden>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Board revision</span>
                            <select class="cfg-field__input" data-fw-revision></select>
                        </label>
                    </div>
                    <div class="companion-flash-warning" data-fw-warning hidden></div>
                    <p class="companion-flash-artifact" data-fw-artifact aria-live="polite"></p>
                    <label class="cfg-field">
                        <span class="cfg-field__label">Serial port</span>
                        <input class="cfg-field__input" type="text" data-fw-port placeholder="/dev/ttyUSB0">
                    </label>
                    <details class="companion-flash-advanced">
                        <summary>Advanced esptool options</summary>
                        <div class="cfg-field cfg-field--row">
                            <label class="cfg-field">
                                <span class="cfg-field__label">Baud</span>
                                <input class="cfg-field__input" type="number" min="9600" max="921600"
                                       step="1" data-fw-baud value="460800">
                            </label>
                            <label class="cfg-field">
                                <span class="cfg-field__label">Offset</span>
                                <input class="cfg-field__input" type="text" data-fw-offset value="0x10000">
                            </label>
                        </div>
                    </details>
                    <div class="auth-card__actions">
                        <button type="button" class="terminal-button terminal-button--primary"
                                data-fw-one-click disabled>Flash recommended</button>
                        <button type="button" class="terminal-button"
                                data-fw-fetch disabled>Download only</button>
                    </div>
                </section>

                <details class="companion-flash-manual">
                    <summary>Manual .bin upload (companion_radio_usb only)</summary>
                    <p class="auth-card__hint">
                        Filename must include <code>companion_radio_usb</code>.
                        BLE and Meshtastic images are rejected.
                    </p>
                    <label class="cfg-field">
                        <span class="cfg-field__label">Firmware file (.bin)</span>
                        <input class="cfg-field__input" type="file" accept=".bin,application/octet-stream"
                               data-fw-file>
                    </label>
                    <p class="auth-card__hint" data-fw-upload-status aria-live="polite"></p>
                    <div class="auth-card__actions">
                        <button type="button" class="terminal-button terminal-button--danger"
                                data-fw-flash disabled>Flash uploaded file</button>
                    </div>
                </details>

                <div class="auth-card__actions">
                    <button type="button" class="terminal-button terminal-button--ghost"
                            data-fw-clear-log>Clear log</button>
                </div>
                <pre class="companion-flash-log" data-fw-log aria-live="polite"></pre>
            </article>
        `;

        this._externalEl = this._host.querySelector('[data-fw-external]');
        this._companionStatusEl = this._host.querySelector('[data-fw-companion-status]');
        this._boardSelect = this._host.querySelector('[data-fw-board]');
        this._revisionWrap = this._host.querySelector('[data-fw-revision-wrap]');
        this._revisionSelect = this._host.querySelector('[data-fw-revision]');
        this._warningEl = this._host.querySelector('[data-fw-warning]');
        this._artifactEl = this._host.querySelector('[data-fw-artifact]');
        this._fileInput = this._host.querySelector('[data-fw-file]');
        this._portInput = this._host.querySelector('[data-fw-port]');
        this._baudInput = this._host.querySelector('[data-fw-baud]');
        this._offsetInput = this._host.querySelector('[data-fw-offset]');
        this._oneClickBtn = this._host.querySelector('[data-fw-one-click]');
        this._fetchBtn = this._host.querySelector('[data-fw-fetch]');
        this._flashBtn = this._host.querySelector('[data-fw-flash]');
        this._uploadStatus = this._host.querySelector('[data-fw-upload-status]');
        this._logEl = this._host.querySelector('[data-fw-log]');

        this._boardSelect.addEventListener('change', () => this._onBoardChange());
        this._revisionSelect.addEventListener('change', () => this._onRevisionChange());
        this._fileInput.addEventListener('change', () => this._onFileSelected());
        this._oneClickBtn.addEventListener('click', () => this._onOneClickFlash());
        this._fetchBtn.addEventListener('click', () => this._onFetchOnly());
        this._flashBtn.addEventListener('click', () => this._onFlashClick());
        this._host.querySelector('[data-fw-clear-log]').addEventListener('click', () => {
            this._logLines = [];
            this._paintLog();
        });

        this._loadDefaults();
        this._loadCatalog();
        this._connectLogWs();
        this._pollCompanionStatus();
    }

    async _loadDefaults() {
        try {
            const res = await fetch('/api/firmware/defaults', { credentials: 'same-origin' });
            if (!res.ok) return;
            const data = await res.json();
            if (data.serial_port && this._portInput) {
                this._portInput.value = data.serial_port;
            }
        } catch (_e) { /* best-effort */ }
    }

    async _loadCatalog() {
        try {
            const res = await fetch('/api/firmware/catalog', { credentials: 'same-origin' });
            if (!res.ok) {
                this._boardSelect.innerHTML = '<option value="">Catalog unavailable</option>';
                return;
            }
            this._catalog = await res.json();
            this._paintExternalFlashers(this._catalog.external_flashers || []);
            this._paintBoardOptions(this._catalog);
            if (this._catalog.recommended_board_id) {
                this._boardSelect.value = this._catalog.recommended_board_id;
                this._onBoardChange();
            }
        } catch (_e) {
            this._boardSelect.innerHTML = '<option value="">Catalog load failed</option>';
        }
    }

    _paintExternalFlashers(flashers) {
        if (!this._externalEl || !flashers.length) return;
        this._externalEl.innerHTML = `
            <h4 class="companion-flash-section__title">External flashers (laptop USB)</h4>
            <ul class="companion-flash-external__list">
                ${flashers.map((f) => `
                    <li>
                        <a class="cfg-inline-link" href="${this._escape(f.url)}"
                           target="_blank" rel="noopener noreferrer">${this._escape(f.label)}</a>
                        <span class="companion-flash-external__hint">${this._escape(f.hint || '')}</span>
                    </li>
                `).join('')}
            </ul>
        `;
    }

    _paintBoardOptions(catalog) {
        const boards = catalog.boards || [];
        const opts = ['<option value="">Select board…</option>'];
        for (const b of boards) {
            const rec = b.recommended ? ' ★ recommended' : '';
            const missing = b.artifact ? '' : ' (offline — no artifact)';
            opts.push(
                `<option value="${this._escape(b.id)}">${this._escape(b.label)}${rec}${missing}</option>`,
            );
        }
        this._boardSelect.innerHTML = opts.join('');
        if (catalog.release_tag) {
            this._artifactEl.textContent = `Release: ${catalog.release_tag}`;
        }
        if (catalog.release_error) {
            this._artifactEl.textContent += ` — GitHub: ${catalog.release_error}`;
        }
    }

    _selectedBoard() {
        if (!this._catalog) return null;
        const id = this._boardSelect?.value;
        return (this._catalog.boards || []).find((b) => b.id === id) || null;
    }

    _onBoardChange() {
        const board = this._selectedBoard();
        this._selectedBoardId = board?.id || null;
        this._selectedRevisionId = null;
        this._lastFetchMeta = null;
        this._uploadId = null;
        this._flashBtn.disabled = true;

        if (!board) {
            this._revisionWrap.hidden = true;
            this._warningEl.hidden = true;
            this._oneClickBtn.disabled = true;
            this._fetchBtn.disabled = true;
            return;
        }

        if (board.baud_rate != null) this._baudInput.value = board.baud_rate;
        if (board.partition_offset) this._offsetInput.value = board.partition_offset;

        const revs = board.revisions || [];
        if (revs.length) {
            this._revisionWrap.hidden = false;
            this._revisionSelect.innerHTML = revs.map((r) =>
                `<option value="${this._escape(r.id)}">${this._escape(r.label)}</option>`,
            ).join('');
            if (board.default_revision) {
                this._revisionSelect.value = board.default_revision;
            }
            this._onRevisionChange();
        } else {
            this._revisionWrap.hidden = true;
            this._warningEl.hidden = true;
        }

        const hasArtifact = Boolean(board.artifact?.url);
        this._oneClickBtn.disabled = !hasArtifact;
        this._fetchBtn.disabled = !hasArtifact;
        if (board.artifact) {
            const merged = board.artifact.merged ? 'merged' : 'standard';
            this._artifactEl.textContent =
                `${board.artifact.filename} (${merged}, ${this._formatBytes(board.artifact.size_bytes)})`;
        } else if (board.notes) {
            this._artifactEl.textContent = board.notes;
        }
    }

    _onRevisionChange() {
        const board = this._selectedBoard();
        if (!board?.revisions?.length) {
            this._warningEl.hidden = true;
            return;
        }
        this._selectedRevisionId = this._revisionSelect.value;
        const rev = board.revisions.find((r) => r.id === this._selectedRevisionId);
        if (rev?.warning) {
            this._warningEl.hidden = false;
            let html = this._escape(rev.warning);
            if (rev.community_url) {
                html += ` <a class="cfg-inline-link" href="${this._escape(rev.community_url)}" `
                    + 'target="_blank" rel="noopener noreferrer">Community builds</a>';
            }
            this._warningEl.innerHTML = html;
        } else {
            this._warningEl.hidden = true;
        }
    }

    async _refreshCompanionStatus() {
        try {
            const res = await fetch('/api/firmware/companion-status', { credentials: 'same-origin' });
            if (res.ok) {
                const data = await res.json();
                this._paintCompanionStatus(data);
            }
        } catch (_e) { /* ignore */ }
    }

    _pollCompanionStatus() {
        this._refreshCompanionStatus();
        this._statusPoll = setInterval(() => this._refreshCompanionStatus(), 8000);
    }

    _paintCompanionStatus(data) {
        if (!this._companionStatusEl) return;
        const mc = data.meshcore || {};
        const port = data.serial_port || this._portInput?.value || '—';
        if (this._portInput && data.serial_port && !this._portInput.value) {
            this._portInput.value = data.serial_port;
        }
        let text = `Port ${port}`;
        if (data.flash_in_progress) {
            text += ' · Flash in progress';
            this._companionStatusEl.dataset.kind = 'pending';
        } else if (mc.connected) {
            const name = mc.companion_name ? ` (${mc.companion_name})` : '';
            text += ` · Companion connected${name}`;
            this._companionStatusEl.dataset.kind = 'success';
        } else if (mc.enabled) {
            text += ' · Companion not connected — plug in USB companion firmware';
            this._companionStatusEl.dataset.kind = 'warn';
        } else {
            text += ' · MeshCore USB capture disabled in config';
            this._companionStatusEl.dataset.kind = '';
        }
        this._companionStatusEl.textContent = text;
    }

    _connectLogWs() {
        if (this._ws) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}/api/firmware/ws/flash-log`;
        try {
            this._ws = new WebSocket(url);
            this._ws.onmessage = (event) => {
                this._appendLog(event.data);
                if (String(event.data).includes('reconnected')) {
                    this._refreshCompanionStatus();
                }
            };
            this._ws.onclose = () => {
                this._ws = null;
                setTimeout(() => this._connectLogWs(), 5000);
            };
        } catch (_e) {
            this._appendLog('[flasher] WebSocket unavailable');
        }
    }

    async _onFetchOnly() {
        const meta = await this._fetchCatalogBin();
        if (!meta) return;
        this._uploadId = meta.upload_id;
        this._filename = meta.filename;
        this._lastFetchMeta = meta;
        this._appendLog(
            `[ui] Downloaded ${meta.filename} sha256=${(meta.sha256 || '').slice(0, 12)}…`,
        );
        this._flashBtn.disabled = false;
    }

    async _onOneClickFlash() {
        const board = this._selectedBoard();
        if (!board) return;
        const port = (this._portInput?.value || '').trim();
        const rev = this._selectedRevisionId;
        const revLabel = board.revisions?.find((r) => r.id === rev)?.label || '';
        const ok = await this._modal.confirm({
            label: 'flash firmware',
            command: `Flash ${board.label}`,
            description:
                `One-click flash: download ${board.artifact?.filename || 'catalog build'} `
                + `and write to ${port}. MeshCore pauses ~20–30s.${revLabel ? ` Revision: ${revLabel}.` : ''}`,
        });
        if (!ok) return;

        this._appendLog(`[ui] One-click flash: ${board.label} on ${port}…`);
        this._oneClickBtn.disabled = true;
        this._fetchBtn.disabled = true;
        try {
            const res = await fetch('/api/firmware/flash-catalog', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    board_id: board.id,
                    serial_port: port,
                    revision_id: rev || null,
                    baud_rate: Number(this._baudInput?.value || board.baud_rate),
                    partition_offset: (this._offsetInput?.value || board.partition_offset).trim(),
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                this._appendLog(`[ui] ${body.detail || `Flash failed (${res.status})`}`);
            } else {
                this._appendLog(
                    `[ui] Queued ${body.filename} (${body.release_tag}) — watch log below.`,
                );
            }
        } catch (_e) {
            this._appendLog('[ui] One-click flash failed (network error).');
        } finally {
            this._onBoardChange();
        }
    }

    async _fetchCatalogBin() {
        const board = this._selectedBoard();
        if (!board?.id) {
            this._appendLog('[ui] Select a board first.');
            return null;
        }
        this._fetchBtn.disabled = true;
        try {
            const res = await fetch('/api/firmware/fetch-catalog', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    board_id: board.id,
                    revision_id: this._selectedRevisionId || null,
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                this._appendLog(`[ui] Download failed: ${body.detail || res.status}`);
                return null;
            }
            return body;
        } catch (_e) {
            this._appendLog('[ui] Download failed (network error).');
            return null;
        } finally {
            this._fetchBtn.disabled = !board?.artifact?.url;
        }
    }

    async _onFileSelected() {
        const file = this._fileInput?.files?.[0];
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.bin')) {
            this._setUploadStatus('error', 'Only .bin files are accepted.');
            this._uploadId = null;
            this._flashBtn.disabled = true;
            return;
        }
        const lower = file.name.toLowerCase();
        if (lower.includes('companion_radio_ble') || lower.includes('_ble-')) {
            this._setUploadStatus(
                'error',
                'BLE companion firmware is not supported. Use companion_radio_usb only.',
            );
            this._uploadId = null;
            this._flashBtn.disabled = true;
            return;
        }
        if (!lower.includes('companion_radio_usb')) {
            this._setUploadStatus(
                'error',
                'Filename must include companion_radio_usb (USB serial companion).',
            );
            this._uploadId = null;
            this._flashBtn.disabled = true;
            return;
        }
        this._setUploadStatus('pending', 'Uploading…');
        const form = new FormData();
        form.append('firmware_file', file);
        try {
            const res = await fetch('/api/firmware/upload', {
                method: 'POST',
                credentials: 'same-origin',
                body: form,
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                this._setUploadStatus('error', body.detail || `Upload failed (${res.status}).`);
                this._flashBtn.disabled = true;
                return;
            }
            const data = await res.json();
            this._uploadId = data.upload_id;
            this._filename = data.filename || file.name;
            this._setUploadStatus(
                'success',
                `Ready: ${this._filename} (${this._formatBytes(data.size_bytes)})`,
            );
            this._flashBtn.disabled = false;
        } catch (_e) {
            this._setUploadStatus('error', 'Upload failed (network error).');
            this._flashBtn.disabled = true;
        }
    }

    async _onFlashClick() {
        if (!this._uploadId) return;
        const port = (this._portInput?.value || '').trim();
        const baud = Number(this._baudInput?.value || 460800);
        const offset = (this._offsetInput?.value || '0x10000').trim();
        const ok = await this._modal.confirm({
            label: 'flash firmware',
            command: `Flash ${this._filename}`,
            description:
                `This halts MeshCore USB on ${port} for ~20–30 seconds while esptool writes the image. `
                + 'The companion will reboot and reconnect automatically.',
        });
        if (!ok) return;

        this._appendLog(`[ui] Starting flash on ${port}…`);
        this._flashBtn.disabled = true;
        try {
            const res = await fetch('/api/firmware/flash', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    upload_id: this._uploadId,
                    serial_port: port,
                    baud_rate: baud,
                    partition_offset: offset,
                    catalog_board_id: this._lastFetchMeta?.board_id || null,
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.status === 409) {
                this._appendLog(`[ui] ${body.detail || 'Flash already in progress.'}`);
            } else if (!res.ok) {
                this._appendLog(`[ui] Flash request failed: ${body.detail || res.status}`);
            } else {
                this._appendLog('[ui] Queued — watch log below for esptool output.');
                this._uploadId = null;
                this._fileInput.value = '';
                this._setUploadStatus('', '');
            }
        } catch (_e) {
            this._appendLog('[ui] Flash request failed (network error).');
        } finally {
            this._flashBtn.disabled = !this._uploadId;
        }
    }

    _appendLog(line) {
        this._logLines.push(String(line));
        if (this._logLines.length > 500) {
            this._logLines = this._logLines.slice(-500);
        }
        this._paintLog();
    }

    _paintLog() {
        if (!this._logEl) return;
        this._logEl.textContent = this._logLines.join('\n');
        this._logEl.scrollTop = this._logEl.scrollHeight;
    }

    _setUploadStatus(kind, message) {
        if (!this._uploadStatus) return;
        this._uploadStatus.dataset.kind = kind || '';
        this._uploadStatus.textContent = message || '';
    }

    _escape(text) {
        if (window.escapeHtml) return window.escapeHtml(String(text ?? ''));
        const d = document.createElement('div');
        d.textContent = String(text ?? '');
        return d.innerHTML;
    }

    static _formatBytes(n) {
        const v = Number(n) || 0;
        if (v < 1024) return `${v} B`;
        if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
        return `${(v / (1024 * 1024)).toFixed(2)} MB`;
    }
}

window.CompanionFlashCard = CompanionFlashCard;
