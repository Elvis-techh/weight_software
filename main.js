const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;
let scaleSimulationTimer = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        title: "Báscula Central - Terminal de Pesaje",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    startScaleSimulation();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (scaleSimulationTimer) clearInterval(scaleSimulationTimer);
});

function startScaleSimulation() {
    if (scaleSimulationTimer) clearInterval(scaleSimulationTimer);
    scaleSimulationTimer = setInterval(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            const jitter = Math.floor(Math.random() * 40) - 20;
            const simulatedWeight = 20500 + jitter;
            mainWindow.webContents.send('scale-data', {
                weight: simulatedWeight,
                stable: Math.abs(jitter) < 8
            });
        }
    }, 500);
}