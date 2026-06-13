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
    };
})();
