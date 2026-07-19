const { contextBridge, ipcRenderer } = require('electron');

// We expose a secure API to the HTML frontend
contextBridge.exposeInMainWorld('electronAPI', {
    // This listens for the 'scale-data' sent from main.js
    onScaleData: (callback) => ipcRenderer.on('scale-data', (_event, value) => callback(value))
});