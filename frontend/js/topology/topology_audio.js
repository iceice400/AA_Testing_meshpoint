/**
 * Topology-specific audio tones (MeshSense-style alerts).
 * Extends the global soundEngine when topology audio is enabled.
 */
(function () {
    const RECIPES = {
        batteryCritical: {
            interval: 0.06,
            notes: [{ freq: 880, duration: 0.14, gain: 0.06 }],
        },
        warning: {
            interval: 0.05,
            notes: [{ freq: 660, duration: 0.12, gain: 0.05 }],
        },
        newNode: {
            interval: 0.04,
            notes: [{ freq: 440, duration: 0.1, gain: 0.05 }],
        },
        tracerouteReply: {
            interval: 0.04,
            notes: [{ freq: 528, duration: 0.12, gain: 0.05 }],
        },
    };

    class TopologyAudio {
        constructor(settings) {
            this._settings = settings;
            this._ctx = null;
        }

        play(name) {
            if (!this._settings?.get('audioOn')) return;
            const ctx = this._getContext();
            if (!ctx) return;
            const recipe = RECIPES[name];
            if (!recipe) return;
            this._render(ctx, recipe);
        }

        _getContext() {
            try {
                if (!this._ctx) {
                    const Ctor = window.AudioContext || window.webkitAudioContext;
                    if (!Ctor) return null;
                    this._ctx = new Ctor();
                }
                if (this._ctx.state === 'suspended') this._ctx.resume();
                return this._ctx;
            } catch (_e) {
                return null;
            }
        }

        _render(ctx, recipe) {
            const now = ctx.currentTime;
            recipe.notes.forEach((note, idx) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = note.type || 'sine';
                osc.frequency.value = note.freq;
                const start = now + idx * (recipe.interval ?? 0.05);
                const end = start + (note.duration ?? 0.12);
                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(note.gain ?? 0.05, start + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, end);
                osc.connect(gain).connect(ctx.destination);
                osc.start(start);
                osc.stop(end + 0.02);
            });
        }
    }

    window.TopologyAudio = TopologyAudio;
})();
