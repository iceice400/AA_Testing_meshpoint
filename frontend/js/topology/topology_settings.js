/**
 * Topology tab operator settings — MeshSense-aligned defaults in localStorage.
 */
(function () {
    const STORAGE_KEY = 'meshpoint.topology.settings.v2';

    const DEFAULTS = {
        autoOn: true,
        rateLimitMin: 15,
        staticHrs: 24,
        staticCooldownMult: 4,
        inactMin: 60,
        relayPrefix: '[MP]',
        audioOn: false,
        staticMoveM: 110,
        edgesOn: true,
        darkInfOn: true,
        labelsOn: true,
        hours: 24,
    };

    class TopologySettings {
        constructor() {
            this._data = { ...DEFAULTS, ...this._load() };
            this._listeners = new Set();
        }

        get(key) {
            return this._data[key];
        }

        set(key, value) {
            if (!(key in DEFAULTS)) return;
            this._data[key] = value;
            this._save();
            this._emit();
        }

        getAll() {
            return { ...this._data };
        }

        onChange(fn) {
            this._listeners.add(fn);
            return () => this._listeners.delete(fn);
        }

        _load() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                return raw ? JSON.parse(raw) : {};
            } catch (_e) {
                return {};
            }
        }

        _save() {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
            } catch (_e) { /* quota */ }
        }

        _emit() {
            this._listeners.forEach((fn) => {
                try { fn(this.getAll()); } catch (e) { console.error('TopologySettings:', e); }
            });
        }
    }

    window.TopologySettings = TopologySettings;
})();
