/**
 * MeshSense-style smart traceroute queue with firmware-compliant spacing.
 */
(function () {
    const FIRMWARE_TR_LIMIT_MS = 30_000;
    const MIN_DEQUEUE_MS = 800;
    const MT_NODE_ID_RE = /^[0-9a-f]{8}$/;

    function isMeshtasticNodeId(id) {
        const n = String(id || '').replace(/^!/, '').toLowerCase();
        return MT_NODE_ID_RE.test(n);
    }

    function haversineM(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = (d) => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    class SmartPoller {
        constructor(options = {}) {
            this._settings = options.settings;
            this._store = options.store;
            this._onAlert = options.onAlert || (() => {});
            this._onQueueChange = options.onQueueChange || (() => {});
            this._observer = options.observer === true;

            this._queue = [];
            this._draining = false;
            this._cooldown = false;
            this._lastTraceAt = new Map();
            this._traceMeta = new Map();
            this._positionHistory = new Map();
            this._mobile = new Map();
            this._txReady = null;
        }

        get queueSize() {
            return this._queue.length;
        }

        getQueue() {
            return this._queue.map((e) => ({ ...e }));
        }

        getState() {
            if (this._cooldown) return 'ratelimit';
            if (this._draining || this._queue.length) return 'queue';
            return 'idle';
        }

        isQueued(nodeId) {
            return this._queue.some((e) => e.nodeId === nodeId);
        }

        setTxReady(ready) {
            this._txReady = ready;
        }

        clearQueue() {
            this._queue = [];
            this._onQueueChange(this.getQueue(), this.getState());
        }

        notePacket(node, packet) {
            if (!node?.node_id && !node?.id) return;
            const id = node.node_id || node.id;
            const now = Date.now();

            if (node.latitude != null && node.longitude != null) {
                this._trackMovement(id, node.latitude, node.longitude, now);
            }

            if (!this._settings?.get('autoOn') || this._observer) return;
            if (!this._shouldAutoTrace(id, packet, now)) return;
            this.enqueue(id, 'auto', 2);
        }

        enqueue(nodeId, reason = 'manual', priority = 5) {
            if (this._observer) return false;
            if (!isMeshtasticNodeId(nodeId)) return false;
            if (this._queue.some((e) => e.nodeId === nodeId)) return false;
            this._queue.push({
                nodeId,
                reason,
                priority,
                force: reason === 'manual',
                enqueuedAt: Date.now(),
                state: 'pending',
            });
            this._queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
            this._onQueueChange(this.getQueue(), this.getState());
            if (!this._draining) this.drainQueue();
            return true;
        }

        /** Immediate traceroute for operator ↯ button (bypasses queue). */
        async traceNode(nodeId, { force = true, reason = 'manual' } = {}) {
            if (!isMeshtasticNodeId(nodeId)) {
                this._onAlert({
                    type: 'warn',
                    node_id: nodeId,
                    node_name: nodeId,
                    message: 'Invalid node ID for Meshtastic traceroute (need 8 hex chars).',
                });
                return { success: false, error: 'invalid node id' };
            }
            if (this._observer) {
                this._onAlert({
                    type: 'warn',
                    node_id: nodeId,
                    node_name: nodeId,
                    message: 'Observer mode — traceroute disabled.',
                });
                return { success: false, error: 'observer' };
            }
            return this._fireTrace(nodeId, { force, reason });
        }

        pollAll(nodes) {
            if (this._observer) return 0;
            let n = 0;
            for (const node of nodes || []) {
                if (this.enqueue(node.node_id || node.id, 'bulk', 3)) n += 1;
            }
            return n;
        }

        pollAllRouters(nodes) {
            if (this._observer) return 0;
            let n = 0;
            for (const node of nodes || []) {
                if (!this._isRouter(node.role)) continue;
                if (this.enqueue(node.node_id || node.id, 'routers', 8)) n += 1;
            }
            return n;
        }

        _isRouter(role) {
            if (role == null) return false;
            const t = String(role).toLowerCase();
            return t === 'router' || t === 'repeater' || t === '2' || t === '4';
        }

        _shouldAutoTrace(nodeId, packet, now) {
            const rateMs = (this._settings.get('rateLimitMin') || 15) * 60_000;
            const mult = this._isStatic(nodeId) ? (this._settings.get('staticCooldownMult') || 4) : 1;
            const cooldown = rateMs * mult;
            const last = this._lastTraceAt.get(nodeId) || 0;
            if (now - last < cooldown) return false;

            const type = (packet?.packet_type || '').toLowerCase();
            if (type === 'traceroute' && packet?.decoded_payload) {
                this._updateTraceMeta(nodeId, packet.decoded_payload);
                return false;
            }

            const meta = this._traceMeta.get(nodeId);
            if (!meta) return true;

            const hops = packet?.hop_limit != null ? packet.hop_limit : null;
            if (hops != null && meta.lastHop != null && hops !== meta.lastHop) return true;
            return false;
        }

        _updateTraceMeta(nodeId, payload) {
            const route = payload.route || [];
            this._traceMeta.set(nodeId, {
                hopCount: Math.max(0, route.length - 1),
                lastHop: route.length ? route.length - 1 : null,
                snrTowards: payload.snr_towards || [],
                snrBack: payload.snr_back || [],
                route,
                updatedAt: Date.now(),
            });
        }

        recordTraceReply(nodeId, payload) {
            this._updateTraceMeta(nodeId, payload || {});
        }

        getTraceMeta(nodeId) {
            return this._traceMeta.get(nodeId) || null;
        }

        _trackMovement(nodeId, lat, lng, now) {
            const hist = this._positionHistory.get(nodeId) || [];
            hist.push({ lat, lng, ts: now });
            const staticMs = (this._settings.get('staticHrs') || 24) * 3600_000;
            const cutoff = now - staticMs;
            const trimmed = hist.filter((p) => p.ts >= cutoff);
            this._positionHistory.set(nodeId, trimmed);

            const threshold = this._settings.get('staticMoveM') || 110;
            let maxDist = 0;
            if (trimmed.length >= 2) {
                const first = trimmed[0];
                for (const p of trimmed) {
                    maxDist = Math.max(maxDist, haversineM(first.lat, first.lng, p.lat, p.lng));
                }
            }
            this._mobile.set(nodeId, maxDist > threshold);
        }

        isStatic(nodeId) {
            return this._mobile.has(nodeId) && !this._mobile.get(nodeId);
        }

        _isStatic(nodeId) {
            return this.isStatic(nodeId);
        }

        async _fireTrace(nodeId, { force = false, reason = 'auto' } = {}) {
            if (this._txReady === false) {
                this._onAlert({
                    type: 'warn',
                    node_id: nodeId,
                    node_name: nodeId,
                    message: 'Meshtastic TX unavailable — enable onboard TX for traceroute.',
                });
                return { success: false, error: 'TX unavailable' };
            }

            const qs = force ? '?force=true' : '';
            const url = `/api/analytics/topology/traceroute/${encodeURIComponent(nodeId)}${qs}`;

            this._onAlert({
                type: 'route',
                node_id: nodeId,
                node_name: nodeId,
                message: `[RouteRequest] Traceroute → ${nodeId} (${reason}${force ? ', force' : ''}).`,
            });

            try {
                const res = await fetch(url, {
                    method: 'POST',
                    credentials: 'same-origin',
                });
                const data = await res.json().catch(() => ({}));

                if (res.status === 401 || res.status === 403) {
                    this._onAlert({
                        type: 'warn',
                        node_id: nodeId,
                        node_name: nodeId,
                        message: res.status === 403
                            ? 'Admin login required for traceroute.'
                            : 'Sign in to send traceroute.',
                    });
                    return { success: false, error: data.detail || 'auth required' };
                }

                if (res.status === 503) {
                    this._onAlert({
                        type: 'warn',
                        node_id: nodeId,
                        node_name: nodeId,
                        message: data.detail || 'Topology TX not configured on this node.',
                    });
                    return { success: false, error: data.detail };
                }

                if (data.skipped) {
                    const wait = data.cooldown_remaining_s || 30;
                    this._onAlert({
                        type: 'warn',
                        node_id: nodeId,
                        node_name: nodeId,
                        message: `Traceroute on cooldown — retry in ~${wait}s.`,
                    });
                    return data;
                }

                if (!res.ok || !data.success) {
                    this._onAlert({
                        type: 'warn',
                        node_id: nodeId,
                        node_name: nodeId,
                        message: data.detail || data.error || `Traceroute failed (${res.status}).`,
                    });
                    return { success: false, error: data.detail || data.error };
                }

                this._lastTraceAt.set(nodeId, Date.now());
                this._onAlert({
                    type: 'info',
                    node_id: nodeId,
                    node_name: nodeId,
                    message: 'Traceroute sent — watch for reply on air.',
                });
                return data;
            } catch (e) {
                console.error('SmartPoller trace failed:', e);
                this._onAlert({
                    type: 'warn',
                    node_id: nodeId,
                    node_name: nodeId,
                    message: `Traceroute error: ${e.message || e}`,
                });
                return { success: false, error: String(e.message || e) };
            }
        }

        async drainQueue() {
            if (this._draining || !this._queue.length || this._observer) return;
            this._draining = true;
            this._onQueueChange(this.getQueue(), this.getState());

            while (this._queue.length) {
                const entry = this._queue[0];
                entry.state = 'sending';
                this._onQueueChange(this.getQueue(), this.getState());

                await this._fireTrace(entry.nodeId, {
                    force: entry.force === true,
                    reason: entry.reason,
                });

                this._queue.shift();
                this._onQueueChange(this.getQueue(), this.getState());

                if (this._queue.length) {
                    this._cooldown = true;
                    this._onQueueChange(this.getQueue(), this.getState());
                    const wait = Math.max(FIRMWARE_TR_LIMIT_MS, MIN_DEQUEUE_MS);
                    await new Promise((r) => setTimeout(r, wait));
                    this._cooldown = false;
                }
            }

            this._draining = false;
            this._onQueueChange(this.getQueue(), this.getState());
        }
    }

    window.SmartPoller = SmartPoller;
})();
