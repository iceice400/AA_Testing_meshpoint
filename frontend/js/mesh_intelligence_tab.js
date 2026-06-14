/**
 * Mesh Intelligence tab — Malla-inspired operator workspace.
 *
 * [INTEL SIDEBAR] | [PACKET BROWSER]
 * [CHANNEL UTILIZATION — full width bottom]
 */
class MeshIntelligenceTab {
    constructor(containerId) {
        this._container = document.getElementById(containerId);
        this._rendered = false;
        this._hours = 24;
        this._device = null;
        this._topologyStatus = null;
        this._selectedNode = null;
        this._meshNodes = [];
        this._storeRef = null;

        const svc = window.meshServices;
        this._settings = svc?.settings || new TopologySettings();
        this._audio = svc?.audio || new TopologyAudio(this._settings);
        this._observer = svc?.detectObserver?.() ?? false;
        this._poller = window.meshServices?.initPoller({
            store: this._store(),
            observer: this._observer,
            onAlert: (a) => this.pushAlert(a),
            onQueueChange: (queue, state) => this._intel?.updateQueueStatus(queue, state),
        });
        this._intel = null;
        this._chBar = null;
        this._settingsUnsub = this._settings.onChange(() => {
            if (this._rendered) this._chBar?.refresh(this._hours);
        });
    }

    getIntel() { return this._intel; }
    getPoller() { return this._poller; }

    bindStore(store) {
        if (!store) return;
        this._storeRef = store;
        if (this._poller) this._poller._store = store;
        if (this._intel) {
            this._intel._store = store;
        }
    }

    _store() {
        return this._storeRef || window.topologyStore || null;
    }

    pushAlert(alert) {
        this._intel?.pushAlert(alert);
    }

    async refresh() {
        if (!this._container) return;
        this.bindStore(this._store());
        if (!this._rendered) {
            this._buildLayout();
            this._rendered = true;
        }
        this._hours = this._settings.get('hours') || 24;
        try {
            const [statusRes, deviceRes] = await Promise.all([
                fetch('/api/analytics/topology/status', { credentials: 'same-origin' }),
                fetch('/api/device'),
            ]);
            this._device = deviceRes.ok ? await deviceRes.json() : null;
            if (this._intel && this._device?.node_id) {
                this._intel.setDeviceId(this._device.node_id);
            }
            if (statusRes.ok) {
                const status = await statusRes.json();
                const txReady = status.traceroute_available !== false
                    && status.meshtastic_tx_enabled !== false;
                this._poller?.setTxReady(txReady);
                this._topologyStatus = status;
                this._intel?.setTopologyStatus(status);
            }
            this._chBar?.refresh(this._hours);
            window.packetsTab?.refresh?.();
        } catch (e) {
            console.error('Mesh Intelligence refresh failed:', e);
        }
    }

    applyMeshNodes(nodes) {
        if (!Array.isArray(nodes)) return;
        this._meshNodes = nodes;
    }

    setSelectedNode(node) {
        this._selectedNode = node;
        this._intel?.setSelectedNode(node);
    }

    ingestPacket(packet) {
        const src = packet?.source_id;
        if (!src || !this._poller) return;

        const trace = window.TopologyTrace?.bestTraceRoute?.(packet);
        if (trace) {
            const dest = trace.route[trace.route.length - 1];
            this._poller.recordTraceReply(dest, trace);
            if (this._rendered) {
                const hops = window.TopologyTrace.hopCount(trace.route);
                this._intel?.pushAlert({
                    type: 'route',
                    node_id: dest,
                    node_name: dest,
                    message: `Traceroute reply — ${hops} hop(s), ${trace.route.length} nodes.`,
                });
                this._intel?._renderTraceHistory?.();
                const mesh = this._meshNodes.find(
                    (n) => (n.node_id || n.id || '').replace(/^!/, '').toLowerCase() === dest,
                );
                if (mesh) this.setSelectedNode(mesh);
                else this._intel?.setSelectedNode(this._selectedNode);
            }
        }

        const srcNorm = src ? String(src).replace(/^!/, '').toLowerCase() : '';
        const node = this._meshNodes.find(
            (n) => String(n.node_id || n.id).replace(/^!/, '').toLowerCase() === srcNorm,
        ) || { node_id: srcNorm || src, id: srcNorm || src };
        this._poller?.notePacket(node, packet);
    }

    _buildLayout() {
        this._intel = new TopologyIntel('intel-sidebar-host', {
            store: this._store(),
            settings: this._settings,
            poller: this._poller,
            audio: this._audio,
            observer: this._observer,
        });
        this._intel.setOnAction((name, detail) => this._intelAction(name, detail));

        this._chBar = new TopologyChannelBar('intel-chbar-host');

        this.bindStore(this._store());

        document.addEventListener('sidebar:routeActivated', (event) => {
            const route = event.detail?.route;
            if (route !== 'intelligence' && route !== 'packets') return;
            this.refresh();
        });

        window.topologyDock = this._intel;
    }

    _intelAction(name, detail) {
        if (name === 'traceHistory') {
            const idNorm = String(detail || '').replace(/^!/, '').toLowerCase();
            const nodes = this._meshNodes.length
                ? this._meshNodes
                : (this._store()?.getMeshNodeList?.() || []);
            const node = nodes.find(
                (n) => String(n.node_id || n.id).replace(/^!/, '').toLowerCase() === idNorm,
            ) || { node_id: idNorm, id: idNorm };
            this.setSelectedNode(node);
            window.topologyTab?.selectNode?.(node);
            return;
        }
        if (name === 'pollAll') {
            const nodes = this._meshNodes.length
                ? this._meshNodes
                : (this._store()?.getMeshNodeList?.() || []);
            const n = this._poller?.pollAll(nodes) || 0;
            this._intel?.pushAlert({
                type: 'info', node_id: 'system', node_name: 'INTEL',
                message: `Queued ${n} trace${n === 1 ? '' : 's'}.`,
            });
            return;
        }
        if (name === 'pollRouters') {
            const nodes = this._meshNodes.length
                ? this._meshNodes
                : (this._store()?.getMeshNodeList?.() || []);
            const n = this._poller?.pollAllRouters(nodes) || 0;
            this._intel?.pushAlert({
                type: 'info', node_id: 'system', node_name: 'INTEL',
                message: `Queued ${n} router trace${n === 1 ? '' : 's'}.`,
            });
            return;
        }
        if (name === 'export') {
            const data = this._store()?.exportJson();
            if (!data) return;
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `meshpoint-topology-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this._intel?.pushAlert({
                type: 'info', node_id: 'system', node_name: 'INTEL', message: 'Snapshot exported.',
            });
            return;
        }
        if (name === 'refresh' || name === 'hoursChanged') {
            this._hours = this._settings.get('hours') || 24;
            window.topologyTab?.refresh?.();
            this.refresh();
            return;
        }
        if (name === 'inactChanged') {
            window.topologyTab?.refresh?.();
        }
    }
}

try {
    window.meshIntelligenceTab = new MeshIntelligenceTab('intelligence-panel');
    window.meshIntelligenceTab._buildLayout();
    window.meshIntelligenceTab._rendered = true;
} catch (err) {
    console.error('MeshIntelligenceTab failed to initialize:', err);
}
