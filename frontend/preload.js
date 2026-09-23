const { contextBridge, ipcRenderer } = require('electron');

// Set by main.js from environment.js, as switches on this renderer's command line.
function switchValue(name) {
    const prefix = `--${name}=`;
    const arg = process.argv.find(value => value.startsWith(prefix));
    return arg === undefined ? '' : arg.slice(prefix.length);
}

contextBridge.exposeInMainWorld('electronAPI', {
    // The server this window talks to: production for the installed app, the
    // local sandbox for `npm start` / `npm run dev` (see environment.js).
    apiUrl: switchValue('bascula-api-url') || process.env.BASCULA_API_URL || '',
    // True for any run that isn't the installed app, so the page can flag a
    // development window that is pointed at real data.
    devBuild: switchValue('bascula-dev-build') === '1',

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

    saveReceiptAsPdf(data) {
        return ipcRenderer.invoke('receipt:save-pdf', data);
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