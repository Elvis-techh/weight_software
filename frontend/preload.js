const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
    }
});