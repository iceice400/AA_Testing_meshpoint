/**
 * Traceroute / routing payload helpers — ignore empty TX probes, accept replies.
 */
(function () {
    function normHop(hop) {
        if (hop == null || hop === '') return '';
        return String(hop).trim().toLowerCase().replace(/^!/, '');
    }

    function normRoute(route) {
        if (!Array.isArray(route)) return [];
        return route.map(normHop).filter(Boolean);
    }

    /** Minimum 2 hops in path (source + at least one other node). */
    function isValidRoute(route) {
        return normRoute(route).length >= 2;
    }

    /**
     * Extract usable route paths from a live packet (TRACEROUTE or ROUTING).
     * Ignores empty RouteDiscovery probes (outbound TX requests).
     */
    function extractTraceRoutes(packet) {
        const payload = packet?.decoded_payload;
        if (!payload || typeof payload !== 'object') return [];

        const out = [];
        const push = (route, snrTowards, snrBack) => {
            const path = normRoute(route);
            if (path.length < 2) return;
            out.push({
                route: path,
                snr_towards: Array.isArray(snrTowards) ? snrTowards : [],
                snr_back: Array.isArray(snrBack) ? snrBack : [],
            });
        };

        push(payload.route, payload.snr_towards, payload.snr_back);
        push(payload.route_reply, payload.snr_towards, payload.snr_back);
        push(payload.route_request, payload.snr_towards, payload.snr_back);

        return out;
    }

    function isTracePacket(packet) {
        const type = (packet?.packet_type || '').toLowerCase();
        return type === 'traceroute' || type === 'routing';
    }

    function bestTraceRoute(packet) {
        const routes = extractTraceRoutes(packet);
        if (!routes.length) return null;
        return routes.reduce((best, cur) => (
            cur.route.length > best.route.length ? cur : best
        ), routes[0]);
    }

    function hopCount(route) {
        const path = normRoute(route);
        return Math.max(0, path.length - 1);
    }

    window.TopologyTrace = {
        normHop,
        normRoute,
        isValidRoute,
        extractTraceRoutes,
        isTracePacket,
        bestTraceRoute,
        hopCount,
    };
})();
