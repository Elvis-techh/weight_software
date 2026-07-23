const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onScaleData: (callback) => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on('scale-data', listener);
        return () => ipcRenderer.removeListener('scale-data', listener);
    }
});