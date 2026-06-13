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

    function normDest(dest) {
        const id = normHop(dest);
        if (!id || id === 'ffffffff' || id === 'ffff' || id === '00000000') return '';
        return id;
    }

    /** Chain packet source, relay hops, and destination into a full path. */
    function buildTracePath(sourceId, destinationId, route) {
        const src = normHop(sourceId);
        const dest = normDest(destinationId);
        const relays = normRoute(route);
        const path = [];
        if (src) path.push(src);
        for (const hop of relays) {
            if (!path.length || path[path.length - 1] !== hop) path.push(hop);
        }
        if (dest && (!path.length || path[path.length - 1] !== dest)) path.push(dest);
        return path;
    }

    /**
     * Extract usable route paths from a live packet (TRACEROUTE or ROUTING).
     * Empty outbound probes still yield a direct source→destination hop.
     */
    function extractTraceRoutes(packet) {
        const payload = packet?.decoded_payload;
        if (!payload || typeof payload !== 'object') return [];

        const sourceId = normHop(packet?.source_id);
        const destId = packet?.destination_id;
        const out = [];
        const seen = new Set();

        const pushPath = (path, snrTowards, snrBack) => {
            if (path.length < 2) return;
            const key = path.join('>');
            if (seen.has(key)) return;
            seen.add(key);
            out.push({
                route: path,
                snr_towards: Array.isArray(snrTowards) ? snrTowards : [],
                snr_back: Array.isArray(snrBack) ? snrBack : [],
            });
        };

        const routeFields = [
            payload.route,
            payload.route_reply,
            payload.route_request,
        ];
        for (const route of routeFields) {
            if (!Array.isArray(route)) continue;
            pushPath(
                buildTracePath(sourceId, destId, route),
                payload.snr_towards,
                payload.snr_back,
            );
        }

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
        normDest,
        buildTracePath,
        isValidRoute,
        extractTraceRoutes,
        isTracePacket,
        bestTraceRoute,
        hopCount,
    };
})();
