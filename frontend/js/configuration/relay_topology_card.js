/**
 * Configuration → Advanced — topology-aware smart relay (experimental).
 */

class RelayTopologyCard {
    constructor(api) {
        this._api = api;
        this._root = null;
        this._values = {};
    }

    mount(root) {
        this._root = root;
        this._root.innerHTML = `
            <article class="cfg-card" id="cfg-relay-topology">
                <header class="cfg-card__head">
                    <h3 class="cfg-card__title">Topology-aware relay</h3>
                    <p class="cfg-card__hint">
                        Uses live NEIGHBORINFO / TRACEROUTE edges to defer or skip base-station relay TX.
                        Priority-list nodes bypass these filters. All off by default.
                    </p>
                </header>
                <form class="cfg-form" data-relay-topology-form>
                    <label class="cfg-field cfg-field--inline">
                        <input type="checkbox" data-topo-enabled>
                        <span class="cfg-field__label">Enable topology-aware relay</span>
                    </label>
                    <fieldset class="cfg-fieldset" data-topo-fields>
                        <legend class="cfg-field__label">Listen-before-relay</legend>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Base delay (ms)</span>
                            <input class="cfg-field__input" type="number" min="0" max="2000" step="10"
                                   data-listen-ms>
                            <span class="cfg-field__hint">0 = transmit immediately. 150 ms typical.</span>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Max delay (ms)</span>
                            <input class="cfg-field__input" type="number" min="0" max="5000" step="10"
                                   data-listen-max-ms>
                        </label>
                    </fieldset>
                    <fieldset class="cfg-fieldset" data-topo-fields>
                        <legend class="cfg-field__label">Redundant-sector suppression</legend>
                        <label class="cfg-field cfg-field--inline">
                            <input type="checkbox" data-suppression-enabled>
                            <span class="cfg-field__label">Skip relay when sender mesh looks redundant</span>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Min neighbors</span>
                            <input class="cfg-field__input" type="number" min="1" max="20" step="1"
                                   data-suppression-min-neighbors>
                        </label>
                        <label class="cfg-field">
                            <span class="cfg-field__label">Cluster overlap (%)</span>
                            <input class="cfg-field__input" type="number" min="10" max="100" step="5"
                                   data-suppression-overlap>
                            <span class="cfg-field__hint">Start at 50; raise toward 80 only after field validation.</span>
                        </label>
                    </fieldset>
                    <label class="cfg-field">
                        <span class="cfg-field__label">Graph max age (seconds)</span>
                        <input class="cfg-field__input" type="number" min="300" max="86400" step="60"
                               data-graph-max-age>
                    </label>
                    <p class="cfg-field__hint" data-topo-live-stats aria-live="polite"></p>
                    <div class="cfg-card__actions">
                        <button class="terminal-button terminal-button--primary"
                                type="submit">Save topology relay</button>
                    </div>
                    <p class="cfg-status" data-relay-topology-status aria-live="polite"></p>
                </form>
            </article>
        `;

        this._enabledEl = this._root.querySelector('[data-topo-enabled]');
        this._listenMsEl = this._root.querySelector('[data-listen-ms]');
        this._listenMaxMsEl = this._root.querySelector('[data-listen-max-ms]');
        this._suppressionEl = this._root.querySelector('[data-suppression-enabled]');
        this._minNeighborsEl = this._root.querySelector('[data-suppression-min-neighbors]');
        this._overlapEl = this._root.querySelector('[data-suppression-overlap]');
        this._graphAgeEl = this._root.querySelector('[data-graph-max-age]');
        this._statsEl = this._root.querySelector('[data-topo-live-stats]');
        this._statusEl = this._root.querySelector('[data-relay-topology-status]');
        this._fieldsets = this._root.querySelectorAll('[data-topo-fields]');

        this._enabledEl.addEventListener('change', () => this._syncFieldsetDisabled());
        this._root.querySelector('[data-relay-topology-form]')
            .addEventListener('submit', (e) => this._onSubmit(e));
    }

    render(config) {
        const topo = (config.relay && config.relay.topology) || {};
        this._values = {
            enabled: topo.enabled === true,
            listen_window_ms: topo.listen_window_ms != null ? topo.listen_window_ms : 0,
            listen_window_max_ms: topo.listen_window_max_ms != null ? topo.listen_window_max_ms : 400,
            suppression_enabled: topo.suppression_enabled === true,
            suppression_min_neighbors: topo.suppression_min_neighbors != null
                ? topo.suppression_min_neighbors : 2,
            suppression_overlap_percent: topo.suppression_overlap_percent != null
                ? topo.suppression_overlap_percent : 50,
            graph_max_age_seconds: topo.graph_max_age_seconds != null
                ? topo.graph_max_age_seconds : 3600,
        };

        this._enabledEl.checked = this._values.enabled;
        this._listenMsEl.value = String(this._values.listen_window_ms);
        this._listenMaxMsEl.value = String(this._values.listen_window_max_ms);
        this._suppressionEl.checked = this._values.suppression_enabled;
        this._minNeighborsEl.value = String(this._values.suppression_min_neighbors);
        this._overlapEl.value = String(this._values.suppression_overlap_percent);
        this._graphAgeEl.value = String(this._values.graph_max_age_seconds);
        this._syncFieldsetDisabled();
        this._loadLiveStats();
    }

    _syncFieldsetDisabled() {
        const on = this._enabledEl.checked;
        this._fieldsets.forEach((fs) => {
            fs.querySelectorAll('input').forEach((input) => {
                input.disabled = !on;
            });
        });
        this._graphAgeEl.disabled = !on;
    }

    async _loadLiveStats() {
        if (!this._statsEl) return;
        const status = await this._api.get('/api/device/status');
        const relay = status && status.relay;
        const topoStats = relay && relay.topology_relay;
        if (!topoStats || !topoStats.graph) {
            this._statsEl.textContent = '';
            return;
        }
        const reasons = relay.rejection_reasons || {};
        const redundant = reasons.topology_redundant || 0;
        const deferred = relay.deferred_cancelled || 0;
        const graph = topoStats.graph;
        this._statsEl.textContent =
            `Live: ${graph.node_count} graph nodes, ${graph.edge_count} edges · `
            + `${redundant} topology suppressions · ${deferred} deferred relays cancelled`;
    }

    _readForm() {
        const listenMs = Number(this._listenMsEl.value);
        const listenMax = Number(this._listenMaxMsEl.value);
        if (listenMax < listenMs) {
            throw new Error('Max delay must be ≥ base delay.');
        }
        return {
            enabled: this._enabledEl.checked,
            listen_window_ms: listenMs,
            listen_window_max_ms: listenMax,
            suppression_enabled: this._suppressionEl.checked,
            suppression_min_neighbors: Number(this._minNeighborsEl.value),
            suppression_overlap_percent: Number(this._overlapEl.value),
            graph_max_age_seconds: Number(this._graphAgeEl.value),
        };
    }

    async _onSubmit(event) {
        event.preventDefault();
        let payload;
        try {
            payload = this._readForm();
        } catch (err) {
            this._setStatus('error', err.message);
            return;
        }

        this._setStatus('pending', 'Saving…');
        const result = await this._api.put('/api/config/relay', { topology: payload });
        if (!result) {
            this._setStatus('error', 'Save failed.');
            return;
        }
        this._setStatus('success', 'Saved.');
        this._api.toast('Topology relay settings applied (no restart required).');
        this._api.refresh();
    }

    _setStatus(kind, message) {
        if (!this._statusEl) return;
        this._statusEl.dataset.kind = kind;
        this._statusEl.textContent = message;
    }
}

window.RelayTopologyCard = RelayTopologyCard;
