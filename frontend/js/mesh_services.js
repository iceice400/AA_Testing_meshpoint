/**
 * Shared mesh operator services — settings, audio, and smart poller used by
 * Topology (MeshSense map) and Mesh Intelligence (Malla-style analytics).
 */
(function () {
    const settings = new TopologySettings();
    const audio = new TopologyAudio(settings);
    let poller = null;

    function detectObserver() {
        if (new URLSearchParams(location.search).has('observer')) return true;
        const role = window.sidebar?.identity?.role;
        return role === 'viewer';
    }

    function initPoller(options = {}) {
        const observer = options.observer ?? detectObserver();
        if (!poller) {
            poller = new SmartPoller({
                settings,
                store: options.store || null,
                observer,
                onAlert: options.onAlert,
                onQueueChange: options.onQueueChange,
            });
        } else {
            if (options.store) poller._store = options.store;
            if (options.onAlert) poller._onAlert = options.onAlert;
            if (options.onQueueChange) poller._onQueueChange = options.onQueueChange;
        }
        return poller;
    }

    window.meshServices = {
        settings,
        audio,
        detectObserver,
        initPoller,
        getPoller: () => poller,
    };
})();
