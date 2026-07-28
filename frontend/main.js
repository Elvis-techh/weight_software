const { dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;
let scaleSimulationTimer = null;
let simulationPreset = 'loaded';

const SCALE_SIMULATION_ENABLED = process.env.SCALE_SIMULATION !== 'false';
const SCALE_PRESETS = Object.freeze({
    loaded: { weight: 20500, label: 'CARGADO' },
    empty: { weight: 8500, label: 'VACÍO' }
});

function getSimulationPreset(name = simulationPreset) {
    return SCALE_PRESETS[name] || SCALE_PRESETS.loaded;
}

function emitSimulatedScaleData() {
    if (!SCALE_SIMULATION_ENABLED || !mainWindow || mainWindow.isDestroyed()) return;

    const preset = getSimulationPreset();
    const jitter = Math.floor(Math.random() * 5) - 2;

    mainWindow.webContents.send('scale-data', {
        weight: preset.weight + jitter,
        stable: true,
        source: `simulator:${simulationPreset}`,
        preset: simulationPreset
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        show: false,
        backgroundColor: '#f3f4f6',
        title: 'Báscula Central - Terminal de Pesaje',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.webContents.once('did-finish-load', emitSimulatedScaleData);
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function startScaleSimulation() {
    stopScaleSimulation();
    if (!SCALE_SIMULATION_ENABLED) return;

    emitSimulatedScaleData();
    scaleSimulationTimer = setInterval(emitSimulatedScaleData, 500);
}

function stopScaleSimulation() {
    if (!scaleSimulationTimer) return;
    clearInterval(scaleSimulationTimer);
    scaleSimulationTimer = null;
}

function registerScaleSimulationIpc() {
    ipcMain.removeHandler('scale-simulation:set-preset');
    ipcMain.handle('scale-simulation:set-preset', (_event, presetName) => {
        const requestedPreset = String(presetName || '');
        if (!Object.hasOwn(SCALE_PRESETS, requestedPreset)) {
            throw new Error('Preset de simulación inválido.');
        }

        simulationPreset = requestedPreset;
        emitSimulatedScaleData();

        return {
            ok: true,
            preset: simulationPreset,
            ...getSimulationPreset()
        };
    });
}

app.whenReady().then(() => {
    registerScaleSimulationIpc();
    createWindow();
    startScaleSimulation();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // 1. Check for updates silently
    autoUpdater.checkForUpdatesAndNotify();

    // 2. When an update is ready, show a pop-up to the user
    autoUpdater.on('update-downloaded', (info) => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Actualización disponible',
            message: `La versión ${info.version} de Báscula Central está lista.`,
            detail: '¿Deseas reiniciar la aplicación ahora para instalarla?',
            buttons: ['Reiniciar e Instalar', 'Más tarde']
        }).then((result) => {
            if (result.response === 0) {
                // If they click the first button, restart and install
                autoUpdater.quitAndInstall();
            }
        });
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    stopScaleSimulation();
    ipcMain.removeHandler('scale-simulation:set-preset');
});