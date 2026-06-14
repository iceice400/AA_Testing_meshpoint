/**
 * Meshtastic vs MeshCore protocol helpers for topology UI.
 */
(function () {
    const FILTERS = ['all', 'meshtastic', 'meshcore'];

    function normalizeId(node) {
        if (node == null) return '';
        if (typeof node === 'string') {
            return String(node).trim().toLowerCase().replace(/^!/, '');
        }
        return String(node.node_id || node.id || '').trim().toLowerCase().replace(/^!/, '');
    }

    /** Infer protocol from explicit field or node-id shape (8 hex = MT, 12+ = MC). */
    function resolveNodeProtocol(node) {
        const p = (node?.protocol || '').toLowerCase();
        if (p === 'meshcore' || p === 'meshtastic') return p;
        const id = normalizeId(node);
        if (/^[0-9a-f]{12,}$/i.test(id)) return 'meshcore';
        if (/^[0-9a-f]{8}$/i.test(id)) return 'meshtastic';
        return 'meshtastic';
    }

    function protocolLabel(node) {
        return resolveNodeProtocol(node) === 'meshcore' ? 'MC' : 'MT';
    }

    function isMeshtasticNode(node) {
        return resolveNodeProtocol(node) === 'meshtastic';
    }

    function canMeshtasticTx(node) {
        if (!isMeshtasticNode(node)) return false;
        return /^[0-9a-f]{8}$/i.test(normalizeId(node));
    }

    function matchesProtocolFilter(node, filter) {
        if (!filter || filter === 'all') return true;
        return resolveNodeProtocol(node) === filter;
    }

    function filterNodes(nodes, filter) {
        if (!filter || filter === 'all') return nodes || [];
        return (nodes || []).filter((n) => matchesProtocolFilter(n, filter));
    }

    function protocolCounts(nodes) {
        let mt = 0;
        let mc = 0;
        for (const n of nodes || []) {
            if (resolveNodeProtocol(n) === 'meshcore') mc += 1;
            else mt += 1;
        }
        return { mt, mc, total: (nodes || []).length };
    }

    /** Unified roster role bucket for Meshtastic + MeshCore nodes. */
    function normalizeRole(role, node) {
        const proto = resolveNodeProtocol(node);
        const mtMap = { 0: 'CLIENT', 1: 'CLIENT', 2: 'ROUTER', 3: 'ROUTER', 4: 'REPEATER', 5: 'TRACKER', 6: 'SENSOR' };
        if (role != null && role !== '') {
            const n = Number(role);
            if (!Number.isNaN(n) && mtMap[n]) return mtMap[n];
        }
        const t = String(role || '').toUpperCase();
        if (!t || t === 'UNKNOWN' || t === 'UNSET') {
            return proto === 'meshcore' ? 'CLIENT' : 'CLIENT';
        }
        if (t.includes('ROUTER') || t.includes('GATEWAY')) return 'ROUTER';
        if (t.includes('REPEAT') || t.includes('RELAY')) return 'REPEATER';
        if (t.includes('TRACK')) return 'TRACKER';
        if (t.includes('SENSOR')) return 'SENSOR';
        if (t.includes('COMPANION')) return 'CLIENT';
        if (t.includes('CLIENT')) return 'CLIENT';
        return t;
    }

    function roleFilterIds() {
        return ['ROUTER', 'CLIENT', 'REPEATER', 'TRACKER', 'SENSOR', 'DARK', 'ACTIVE'];
    }

    window.TopologyProtocol = {
        FILTERS,
        normalizeId,
        resolveNodeProtocol,
        protocolLabel,
        isMeshtasticNode,
        canMeshtasticTx,
        matchesProtocolFilter,
        filterNodes,
        protocolCounts,
        normalizeRole,
        roleFilterIds,
    };
})();
