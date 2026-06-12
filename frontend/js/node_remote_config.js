/**
 * Remote Meshtastic ADMIN config read/write panel (PR 15–16).
 * Mounted inside the node detail drawer for Meshtastic nodes.
 */
class NodeRemoteConfigPanel {
    static SECTIONS = [
        'device', 'owner', 'lora', 'position', 'power',
        'network', 'display', 'bluetooth', 'security',
    ];

    static ROLES = [
        [0, 'CLIENT'], [1, 'CLIENT_MUTE'], [2, 'ROUTER'],
        [3, 'ROUTER_CLIENT'], [4, 'REPEATER'], [5, 'TRACKER'],
        [6, 'SENSOR'], [7, 'TAK'], [8, 'CLIENT_HIDDEN'],
        [9, 'LOST_AND_FOUND'], [10, 'TAK_TRACKER'],
    ];

    constructor() {
        this._status = null;
        this._pollTimer = null;
        this._nodeId = null;
        this._writePollTimer = null;
    }

    mount(parentEl, node) {
        this._nodeId = node.node_id;
        const proto = (node.protocol || 'meshtastic').toLowerCase();
        if (proto !== 'meshtastic') {
            return null;
        }

        const section = document.createElement('div');
        section.className = 'nd-section nd-section--remote-config';
        section.innerHTML = `
            <div class="nd-section__header">
                <span class="nd-section__title">Remote config</span>
                <span class="nd-section__arrow">\u25BC</span>
            </div>
            <div class="nd-section__content">
                <p class="nd-remote__hint" data-remote-hint>
                    Request read-only ADMIN config from this node (requires
                    <code>meshtastic.admin_key_b64</code> and transmit enabled).
                </p>
                <div class="nd-remote__toolbar">
                    <label class="nd-remote__label">
                        Section
                        <select data-remote-section class="nd-remote__select">
                            ${NodeRemoteConfigPanel.SECTIONS.map((s) =>
                                `<option value="${s}">${s}</option>`).join('')}
                        </select>
                    </label>
                    <button type="button" class="nd-action-btn nd-action-btn--primary"
                            data-remote-request>Request config</button>
                </div>
                <p class="nd-remote__status" data-remote-status aria-live="polite"></p>
                <pre class="nd-remote__json" data-remote-json hidden></pre>
                <details class="nd-remote__write" data-remote-write-panel hidden>
                    <summary>Write limited fields</summary>
                    <form class="nd-remote__write-form" data-remote-write-form>
                        <label class="nd-remote__field">
                            Long name
                            <input type="text" maxlength="40" data-write-long-name>
                        </label>
                        <label class="nd-remote__field">
                            Short name
                            <input type="text" maxlength="4" data-write-short-name>
                        </label>
                        <label class="nd-remote__field">
                            Role
                            <select data-write-role>
                                <option value="">— no change —</option>
                                ${NodeRemoteConfigPanel.ROLES.map(([v, n]) =>
                                    `<option value="${v}">${n}</option>`).join('')}
                            </select>
                        </label>
                        <label class="nd-remote__field nd-remote__field--confirm" hidden
                               data-role-confirm-wrap>
                            Type CONFIRM to change role
                            <input type="text" maxlength="16" data-write-role-confirm>
                        </label>
                        <label class="nd-remote__field">
                            Screen on (seconds)
                            <input type="number" min="0" max="600" data-write-screen>
                        </label>
                        <label class="nd-remote__field">
                            Telemetry interval (seconds)
                            <input type="number" min="30" max="86400" data-write-telem>
                        </label>
                        <button type="submit" class="nd-action-btn">Apply write</button>
                        <p class="nd-remote__status" data-write-status aria-live="polite"></p>
                    </form>
                </details>
            </div>
        `;

        const header = section.querySelector('.nd-section__header');
        const content = section.querySelector('.nd-section__content');
        header.addEventListener('click', () => {
            const visible = content.style.display !== 'none';
            content.style.display = visible ? 'none' : '';
            header.querySelector('.nd-section__arrow').textContent =
                visible ? '\u25B6' : '\u25BC';
        });

        section.querySelector('[data-remote-request]').addEventListener('click', () => {
            this._requestConfig();
        });
        section.querySelector('[data-write-role]').addEventListener('change', (e) => {
            const wrap = section.querySelector('[data-role-confirm-wrap]');
            if (wrap) wrap.hidden = !e.target.value;
        });
        section.querySelector('[data-remote-write-form]').addEventListener('submit', (e) => {
            e.preventDefault();
            this._submitWrite(section);
        });

        parentEl.appendChild(section);
        this._root = section;
        this._loadAvailability();
        return section;
    }

    destroy() {
        this._stopPoll();
        this._stopWritePoll();
        this._root = null;
        this._nodeId = null;
    }

    async _loadAvailability() {
        try {
            const res = await fetch('/api/admin/remote-config/status', {
                credentials: 'same-origin',
            });
            if (!res.ok) return;
            this._status = await res.json();
            const hint = this._root?.querySelector('[data-remote-hint]');
            const writePanel = this._root?.querySelector('[data-remote-write-panel]');
            if (!this._status.available) {
                if (hint) {
                    hint.textContent =
                        'Remote ADMIN unavailable — set meshtastic.admin_key_b64 in local.yaml '
                        + 'and enable transmit.';
                }
                return;
            }
            if (writePanel) writePanel.hidden = false;
        } catch (e) {
            console.warn('Remote config status failed:', e);
        }
    }

    async _requestConfig() {
        if (!this._nodeId || !this._root) return;
        const section = this._root.querySelector('[data-remote-section]').value;
        const statusEl = this._root.querySelector('[data-remote-status]');
        const jsonEl = this._root.querySelector('[data-remote-json]');
        const btn = this._root.querySelector('[data-remote-request]');

        btn.disabled = true;
        this._setStatus(statusEl, 'Sending ADMIN get-config request…');
        jsonEl.hidden = true;
        jsonEl.textContent = '';

        try {
            const res = await fetch(
                `/api/admin/nodes/${encodeURIComponent(this._nodeId)}/config/request`,
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ section }),
                },
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                this._setStatus(statusEl, data.detail || `Request failed (${res.status})`);
                btn.disabled = false;
                return;
            }
            this._setStatus(statusEl, `Pending (packet ${data.packet_id || '—'})…`);
            this._startPoll(statusEl, jsonEl, btn);
        } catch (e) {
            this._setStatus(statusEl, `Request failed: ${e.message}`);
            btn.disabled = false;
        }
    }

    _startPoll(statusEl, jsonEl, btn) {
        this._stopPoll();
        const deadline = Date.now() + ((this._status?.timeout_seconds || 30) * 1000);
        const poll = async () => {
            if (!this._nodeId) return;
            try {
                const res = await fetch(
                    `/api/admin/nodes/${encodeURIComponent(this._nodeId)}/config`,
                    { credentials: 'same-origin' },
                );
                const data = await res.json();
                if (data.status === 'pending') {
                    if (Date.now() > deadline) {
                        this._setStatus(statusEl, 'Timed out waiting for node response.');
                        this._stopPoll();
                        btn.disabled = false;
                        return;
                    }
                    this._setStatus(statusEl, `Waiting for ${data.section || 'config'}…`);
                    return;
                }
                if (data.status === 'complete') {
                    this._setStatus(statusEl, `Received ${data.section || 'config'}.`);
                    jsonEl.hidden = false;
                    jsonEl.textContent = JSON.stringify(data.config, null, 2);
                    this._stopPoll();
                    btn.disabled = false;
                    return;
                }
                if (data.status === 'error' || data.status === 'timeout') {
                    this._setStatus(statusEl, data.error || `Status: ${data.status}`);
                    this._stopPoll();
                    btn.disabled = false;
                }
            } catch (e) {
                this._setStatus(statusEl, `Poll failed: ${e.message}`);
                this._stopPoll();
                btn.disabled = false;
            }
        };
        poll();
        this._pollTimer = setInterval(poll, 1500);
    }

    _stopPoll() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    async _submitWrite(sectionEl) {
        if (!this._nodeId) return;
        const statusEl = sectionEl.querySelector('[data-write-status]');
        const payload = {};
        const longName = sectionEl.querySelector('[data-write-long-name]').value.trim();
        const shortName = sectionEl.querySelector('[data-write-short-name]').value.trim();
        const roleVal = sectionEl.querySelector('[data-write-role]').value;
        const roleConfirm = sectionEl.querySelector('[data-write-role-confirm]').value.trim();
        const screen = sectionEl.querySelector('[data-write-screen]').value;
        const telem = sectionEl.querySelector('[data-write-telem]').value;

        if (longName) payload.long_name = longName;
        if (shortName) payload.short_name = shortName;
        if (roleVal !== '') {
            payload.role = Number(roleVal);
            payload.role_confirm = roleConfirm;
        }
        if (screen !== '') payload.screen_on_secs = Number(screen);
        if (telem !== '') payload.telemetry_interval_secs = Number(telem);

        if (Object.keys(payload).length === 0) {
            this._setStatus(statusEl, 'No changes to apply.');
            return;
        }

        this._setStatus(statusEl, 'Sending write…');
        try {
            const res = await fetch(
                `/api/admin/nodes/${encodeURIComponent(this._nodeId)}/config/write`,
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                this._setStatus(statusEl, data.detail || `Write failed (${res.status})`);
                return;
            }
            this._setStatus(statusEl, `Write ${data.status || 'started'}…`);
            this._startWritePoll(statusEl);
        } catch (e) {
            this._setStatus(statusEl, `Write failed: ${e.message}`);
        }
    }

    _startWritePoll(statusEl) {
        this._stopWritePoll();
        const deadline = Date.now() + 60000;
        const poll = async () => {
            if (!this._nodeId) return;
            try {
                const res = await fetch(
                    `/api/admin/nodes/${encodeURIComponent(this._nodeId)}/config/write`,
                    { credentials: 'same-origin' },
                );
                const data = await res.json();
                if (data.status === 'idle') return;
                if (data.status === 'verifying') {
                    this._setStatus(statusEl, 'Verifying with follow-up read…');
                    return;
                }
                if (data.status === 'verified' || data.status === 'complete') {
                    this._setStatus(statusEl, 'Write verified.');
                    const jsonEl = this._root?.querySelector('[data-remote-json]');
                    if (jsonEl && data.verify_result) {
                        jsonEl.hidden = false;
                        jsonEl.textContent = JSON.stringify(data.verify_result, null, 2);
                    }
                    this._stopWritePoll();
                    return;
                }
                if (data.status === 'failed' || data.status === 'error'
                    || data.status === 'verify_timeout') {
                    this._setStatus(statusEl, data.error || data.status);
                    this._stopWritePoll();
                    return;
                }
                if (Date.now() > deadline) {
                    this._setStatus(statusEl, 'Write verification timed out.');
                    this._stopWritePoll();
                }
            } catch (e) {
                this._setStatus(statusEl, `Poll failed: ${e.message}`);
                this._stopWritePoll();
            }
        };
        poll();
        this._writePollTimer = setInterval(poll, 2000);
    }

    _stopWritePoll() {
        if (this._writePollTimer) {
            clearInterval(this._writePollTimer);
            this._writePollTimer = null;
        }
    }

    _setStatus(el, message) {
        if (el) el.textContent = message;
    }
}

window.NodeRemoteConfigPanel = NodeRemoteConfigPanel;
