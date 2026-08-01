const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Local-testing override: `BASCULA_API_URL=http://localhost:3000 npm start`
    // points the app at a local backend instead of production. Unset in any
    // packaged build, so installed apps always default to production.
    apiUrl: process.env.BASCULA_API_URL || '',

    onScaleData(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('onScaleData requiere una función callback.');
        }

        const listener = (_event, value) => {
            const weight = Number(value?.weight);
            callback({
                weight: Number.isFinite(weight) ? weight : 0,
                stable: Boolean(value?.stable),
                source: String(value?.source || 'electron'),
                preset: String(value?.preset || '')
            });
        };

        ipcRenderer.on('scale-data', listener);
        return () => ipcRenderer.removeListener('scale-data', listener);
    },

    setScaleSimulationPreset(preset) {
        return ipcRenderer.invoke('scale-simulation:set-preset', preset);
    },

    listScalePorts() {
        return ipcRenderer.invoke('scale:list-ports');
    },

    getScaleSettings() {
        return ipcRenderer.invoke('scale:get-settings');
    },

    saveScaleSettings(settings) {
        return ipcRenderer.invoke('scale:save-settings', settings);
    },

    testScaleConnection(settings) {
        return ipcRenderer.invoke('scale:test-connection', settings);
    }
});