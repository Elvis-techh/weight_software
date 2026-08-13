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
    },

    printReceipt(data) {
        return ipcRenderer.invoke('receipt:print', data);
    },

    printListado(data) {
        return ipcRenderer.invoke('listado:print', data);
    },

    saveListadoAsPdf(data) {
        return ipcRenderer.invoke('listado:save-pdf', data);
    },

    printCorapsaListado(data) {
        return ipcRenderer.invoke('corapsa-listado:print', data);
    },

    saveCorapsaListadoAsPdf(data) {
        return ipcRenderer.invoke('corapsa-listado:save-pdf', data);
    },

    loadOfflineQueue() {
        return ipcRenderer.invoke('offline-queue:load');
    },

    saveOfflineQueue(queue) {
        return ipcRenderer.invoke('offline-queue:save', queue);
    },

    warnOfflineSyncIssue(message) {
        return ipcRenderer.invoke('offline-queue:warn', message);
    }
});