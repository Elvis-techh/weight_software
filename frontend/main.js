const { dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const scaleSettings = require('./scaleSettings');
const scaleReader = require('./scaleReader');
const offlineQueueStore = require('./offlineQueueStore');
const environment = require('./environment');

// Which server this run talks to (see environment.js). Resolved before anything
// reads userData — the offline outbox, scale settings, update.log and
// Chromium's own storage all live there — because the folder depends on it.
// For the installed app on production the folder is left exactly as it was.
const appEnvironment = environment.resolveEnvironment({
    isPackaged: app.isPackaged,
    argv: process.argv,
    env: process.env
});
const environmentUserData = environment.userDataPath(app.getPath('userData'), appEnvironment);
if (environmentUserData !== app.getPath('userData')) app.setPath('userData', environmentUserData);

// Packaged apps have no attached console, so without this, autoUpdater
// failures (no internet, blocked firewall, bad manifest, etc.) are
// completely invisible — nothing logs and no dialog appears. This gives
// us a file to check after the fact instead of guessing blind.
function logUpdate(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    try {
        fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), line + '\n', 'utf8');
    } catch (_) {
        // Best-effort logging only — never let a logging failure affect the update flow.
    }
}

// Without these, an uncaught exception or unhandled promise rejection in the
// main process terminates the whole app with no dialog and no attached
// console to see why — the kiosk just silently vanishes. Logging and
// swallowing it instead keeps the app (and the scale connection) alive for
// a bug that's very unlikely to be fatal to the running process.
process.on('uncaughtException', (error) => {
    logUpdate(`Uncaught exception: ${error?.stack || error}`);
});

process.on('unhandledRejection', (reason) => {
    logUpdate(`Unhandled promise rejection: ${reason?.stack || reason}`);
});

let mainWindow = null;
let scaleSimulationTimer = null;
let simulationPreset = 'loaded';
let currentScaleSettings = null;

// A renderer crash is the one failure the two handlers above can't see: the
// main process survives it, so nothing logs and no dialog appears — the
// operator is just left with a blank window while the app still looks alive.
// Recovery is a reload (the offline outbox lives on disk and the scale is
// owned by the main process, so nothing pending is lost), but only one per
// cooldown: a page that crashes during load would otherwise reload forever
// and bury the very fault we added this to surface.
const RENDERER_CRASH_RELOAD_COOLDOWN_MS = 60000;
let lastRendererCrashAt = 0;

const SCALE_PRESETS = Object.freeze({
    loaded: { weight: 20500, label: 'CARGADO' },
    empty: { weight: 8500, label: 'VACÍO' }
});

function getSimulationPreset(name = simulationPreset) {
    return SCALE_PRESETS[name] || SCALE_PRESETS.loaded;
}

function sendScaleData(data) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('scale-data', data);
}

function emitSimulatedScaleData() {
    if (!currentScaleSettings?.testModeEnabled) return;

    const preset = getSimulationPreset();
    const jitter = Math.floor(Math.random() * 5) - 2;

    sendScaleData({
        weight: preset.weight + jitter,
        stable: true,
        source: `simulator:${simulationPreset}`,
        preset: simulationPreset
    });
}

function startScaleSimulation() {
    stopScaleSimulation();
    if (!currentScaleSettings?.testModeEnabled) return;

    emitSimulatedScaleData();
    scaleSimulationTimer = setInterval(emitSimulatedScaleData, 500);
}

function stopScaleSimulation() {
    if (!scaleSimulationTimer) return;
    clearInterval(scaleSimulationTimer);
    scaleSimulationTimer = null;
}

// Single entry point for "what should be feeding the scale-data channel right
// now" — test mode drives the simulator, otherwise the real serial reader
// owns it (and reports 'disconnected' itself if nothing is configured/working).
function applyScaleSettings(settings) {
    currentScaleSettings = settings;
    stopScaleSimulation();
    scaleReader.closeActivePort();

    if (settings.testModeEnabled) {
        startScaleSimulation();
    } else {
        scaleReader.startReading(settings, sendScaleData);
    }
}

function createWindow() {
    // Never ask for more room than the monitor actually has — on a display
    // smaller than the usual 1000x700 floor, Electron would otherwise still
    // enforce that minimum and the window wouldn't fit the screen at all.
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: Math.min(1200, screenWidth),
        height: Math.min(800, screenHeight),
        minWidth: Math.min(1000, screenWidth),
        minHeight: Math.min(700, screenHeight),
        show: false,
        backgroundColor: '#f3f4f6',
        title: 'Báscula Central - Terminal de Pesaje',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            // Switches rather than IPC so they're already there, synchronously,
            // when globals.js reads the server address at page load.
            additionalArguments: [
                `--bascula-api-url=${appEnvironment.apiUrl}`,
                `--bascula-dev-build=${appEnvironment.devBuild ? 1 : 0}`
            ]
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow?.show());
    // `on`, not `once`: after a crash-reload below, the fresh renderer needs the
    // scale re-wired too, otherwise it comes back looking healthy with a dead
    // weight display. applyScaleSettings stops the simulator and closes the
    // active port before re-opening, so running it again is safe.
    mainWindow.webContents.on('did-finish-load', () => applyScaleSettings(currentScaleSettings));
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        // Also fires on normal teardown (quit, window close) — not a crash.
        if (details?.reason === 'clean-exit') return;

        logUpdate(`Renderer process gone: reason=${details?.reason || 'unknown'}, exitCode=${details?.exitCode}`);
        if (!mainWindow || mainWindow.isDestroyed()) return;

        const now = Date.now();
        const crashedAgainImmediately = now - lastRendererCrashAt < RENDERER_CRASH_RELOAD_COOLDOWN_MS;
        lastRendererCrashAt = now;

        if (crashedAgainImmediately) {
            dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'La aplicación no pudo recuperarse',
                message: 'La pantalla volvió a fallar inmediatamente después de recuperarse.',
                detail: 'Cierre y vuelva a abrir Báscula Central. Los pesajes guardados sin conexión no se pierden al reiniciar. Si sigue ocurriendo, envíe el archivo update.log de la carpeta de datos de la aplicación.',
                buttons: ['Entendido']
            });
            return;
        }

        mainWindow.reload();
        // After the reload, not instead of it. A silent recovery would reset the
        // form under the operator mid-pesaje and look like their own mistyping;
        // this is the same must-acknowledge treatment as the offline-sync
        // warning, and for the same reason — it must not go unseen.
        dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'La pantalla se reinició',
            message: 'Báscula Central se recuperó de una falla en la pantalla.',
            detail: 'Verifique el pesaje que estaba capturando antes de continuar: lo que no se había guardado debe ingresarse de nuevo.',
            buttons: ['Entendido']
        });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function waitForLoad(win) {
    return new Promise((resolve, reject) => {
        win.webContents.once('did-finish-load', () => resolve());
        win.webContents.once('did-fail-load', (_event, _errorCode, errorDescription) => {
            reject(new Error(errorDescription || 'No se pudo cargar la boleta para imprimir.'));
        });
        // A crashed renderer fires neither of the two above, so without this the
        // await never settles: the caller's `finally` never runs, the offscreen
        // window leaks, and the print silently hangs forever. Rejecting turns it
        // into a normal failure the caller already knows how to report and clean
        // up after. (Only covers a crash during load — one during the print call
        // itself still hangs; that path has no timeout either way.)
        win.webContents.once('render-process-gone', (_event, details) => {
            if (details?.reason === 'clean-exit') return;
            reject(new Error(`La ventana de impresión falló (${details?.reason || 'desconocido'}).`));
        });
    });
}

// Both the boleta and the listado print on the same physical A4 portrait
// paper the printer is actually loaded with (listado used to request a
// landscape page, which some printers/drivers don't honor correctly and
// simply clip to the paper's real width instead).
const PAGE_SIZE_A4_PORTRAIT = 'A4';

// Resolves once the print dialog is dismissed, whether the user actually
// printed or just closed it — a cancel isn't a failure worth surfacing.
// Rejects only when printing itself can't happen (e.g. no printer/CUPS
// destination configured), so the caller can fall back to a saved PDF.
function printViaDialog(win) {
    return new Promise((resolve, reject) => {
        win.webContents.print(
            {
                silent: false,
                printBackground: true,
                pageSize: PAGE_SIZE_A4_PORTRAIT,
                margins: { marginType: 'none' }
            },
            (success, failureReason) => {
                if (success || failureReason === 'cancelled') {
                    resolve();
                } else {
                    reject(new Error(failureReason || 'No se pudo imprimir el documento.'));
                }
            }
        );
    });
}

async function renderWindowToPdfBuffer(win) {
    return win.webContents.printToPDF({
        pageSize: PAGE_SIZE_A4_PORTRAIT,
        printBackground: true,
        margins: { marginType: 'none' }
    });
}

// Used when there's no printer available to print to (common on a fresh Linux
// dev box with no CUPS destination configured, but can happen anywhere) so the
// operator still gets the document instead of a hard failure.
async function exportWindowAsPdf(win, { fileName }) {
    const pdfBuffer = await renderWindowToPdfBuffer(win);
    const dir = path.join(app.getPath('documents'), 'Boletas Bascula Central');
    const filePath = path.join(dir, fileName);

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, pdfBuffer);
    shell.openPath(filePath);

    return filePath;
}

// Loads receipt/receipt.html into an offscreen window, feeds it the transaction
// data via the same window.setReceiptData() hook the standalone template exposes,
// then prints that window and tears it down. Keeps the receipt's mm-precise layout
// fully isolated from the main app's Tailwind styles instead of hiding/showing a
// shared print section.
async function printReceipt(data) {
    const receiptWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    try {
        const loaded = waitForLoad(receiptWindow);
        receiptWindow.loadFile(path.join(__dirname, 'receipt', 'receipt.html'));
        await loaded;

        // JSON is valid JS expression syntax, but U+2028/U+2029 are legal in JSON
        // strings and historically broke JS string literals, so they're escaped
        // defensively before being handed to executeJavaScript as source text.
        const payload = JSON.stringify(data ?? {})
            .split(String.fromCharCode(0x2028)).join('\\u2028')
            .split(String.fromCharCode(0x2029)).join('\\u2029');
        await receiptWindow.webContents.executeJavaScript(`window.setReceiptData(${payload})`);

        try {
            await printViaDialog(receiptWindow);
            return { ok: true, mode: 'print' };
        } catch (printError) {
            logUpdate(`Impresión de boleta falló, exportando a PDF en su lugar: ${printError.message}`);
            const numero = String(data?.numero || '').trim().replace(/[^a-zA-Z0-9-]/g, '') || Date.now();
            const filePath = await exportWindowAsPdf(receiptWindow, { fileName: `boleta-${numero}.pdf` });
            return { ok: true, mode: 'pdf', path: filePath };
        }
    } finally {
        if (!receiptWindow.isDestroyed()) receiptWindow.destroy();
    }
}

// Opens an offscreen window on the given receipt/ HTML file, feeds it a data
// payload via the given window.<setterName>() hook, then hands it to callback
// (print, export to a fixed path, or export to an operator-chosen path) and
// always tears the window down afterward. Shared by every *Listado print/save
// pair (transactions, Corapsa, ...) so the window setup/teardown only lives
// in one place.
async function withPrintableWindow(htmlFileName, setterName, data, callback) {
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    try {
        const loaded = waitForLoad(win);
        win.loadFile(path.join(__dirname, 'receipt', htmlFileName));
        await loaded;

        const payload = JSON.stringify(data ?? {})
            .split(String.fromCharCode(0x2028)).join('\\u2028')
            .split(String.fromCharCode(0x2029)).join('\\u2029');
        await win.webContents.executeJavaScript(`window.${setterName}(${payload})`);

        return await callback(win);
    } finally {
        if (!win.isDestroyed()) win.destroy();
    }
}

// Mirrors printReceipt() but for a filtered-rows table (a "listado"), which
// has no natural "number" for the PDF filename — filePrefix distinguishes
// the transactions listado from the Corapsa one, etc.
async function printListadoDocument(htmlFileName, setterName, data, filePrefix) {
    return withPrintableWindow(htmlFileName, setterName, data, async win => {
        try {
            await printViaDialog(win);
            return { ok: true, mode: 'print' };
        } catch (printError) {
            logUpdate(`Impresión de ${filePrefix} falló, exportando a PDF en su lugar: ${printError.message}`);
            const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
            const filePath = await exportWindowAsPdf(win, { fileName: `${filePrefix}-${stamp}.pdf` });
            return { ok: true, mode: 'pdf', path: filePath };
        }
    });
}

// The explicit "Guardar" action for a listado: unlike printListadoDocument()'s
// no-printer PDF fallback (which always lands in the same auto-created
// Documents subfolder), this lets the operator pick exactly where it goes.
async function saveListadoDocumentAsPdf(htmlFileName, setterName, data, { dialogTitle, filePrefix }) {
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: dialogTitle,
        defaultPath: path.join(app.getPath('documents'), `${filePrefix}-${stamp}.pdf`),
        filters: [{ name: 'Documento PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: true, mode: 'cancelled' };

    return withPrintableWindow(htmlFileName, setterName, data, async win => {
        const pdfBuffer = await renderWindowToPdfBuffer(win);
        await fs.promises.writeFile(filePath, pdfBuffer);
        shell.openPath(filePath);
        return { ok: true, mode: 'pdf', path: filePath };
    });
}

function printListado(data) {
    return printListadoDocument('listado.html', 'setListadoData', data, 'listado');
}

function saveListadoAsPdf(data) {
    return saveListadoDocumentAsPdf('listado.html', 'setListadoData', data, {
        dialogTitle: 'Guardar listado como PDF',
        filePrefix: 'listado'
    });
}

function printCorapsaListado(data) {
    return printListadoDocument('corapsa-listado.html', 'setCorapsaListadoData', data, 'recibos-externos');
}

function saveCorapsaListadoAsPdf(data) {
    return saveListadoDocumentAsPdf('corapsa-listado.html', 'setCorapsaListadoData', data, {
        dialogTitle: 'Guardar listado de recibos externos como PDF',
        filePrefix: 'recibos-externos'
    });
}

function registerReceiptIpc() {
    ipcMain.removeHandler('receipt:print');
    ipcMain.handle('receipt:print', (_event, data) => printReceipt(data));
}

function registerListadoIpc() {
    ipcMain.removeHandler('listado:print');
    ipcMain.handle('listado:print', (_event, data) => printListado(data));
    ipcMain.removeHandler('listado:save-pdf');
    ipcMain.handle('listado:save-pdf', (_event, data) => saveListadoAsPdf(data));
}

function registerCorapsaListadoIpc() {
    ipcMain.removeHandler('corapsa-listado:print');
    ipcMain.handle('corapsa-listado:print', (_event, data) => printCorapsaListado(data));
    ipcMain.removeHandler('corapsa-listado:save-pdf');
    ipcMain.handle('corapsa-listado:save-pdf', (_event, data) => saveCorapsaListadoAsPdf(data));
}

function registerOfflineQueueIpc() {
    ipcMain.removeHandler('offline-queue:load');
    ipcMain.handle('offline-queue:load', () => offlineQueueStore.loadQueue(app));

    ipcMain.removeHandler('offline-queue:save');
    ipcMain.handle('offline-queue:save', (_event, queue) => offlineQueueStore.saveQueue(app, queue));

    // A must-acknowledge native dialog, not just a toast — this fires only for
    // the rare cases where an offline-captured value (a boleta number, or a
    // sync that failed outright) turned out to disagree with the server once
    // reconnected, which is exactly the kind of thing that must not go unseen.
    ipcMain.removeHandler('offline-queue:warn');
    ipcMain.handle('offline-queue:warn', (_event, message) => {
        return dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Revisar sincronización sin conexión',
            message: 'Se detectó un problema al sincronizar cambios guardados sin conexión.',
            detail: String(message || ''),
            buttons: ['Entendido']
        });
    });
}

function registerScaleIpc() {
    ipcMain.removeHandler('scale-simulation:set-preset');
    ipcMain.handle('scale-simulation:set-preset', (_event, presetName) => {
        // Guarded: without this check, a stray call to this channel could inject a fake
        // reading into the same channel real weighing depends on, even in hardware mode.
        if (!currentScaleSettings?.testModeEnabled) {
            throw new Error('El modo de prueba no está activo.');
        }

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

    ipcMain.removeHandler('scale:list-ports');
    ipcMain.handle('scale:list-ports', () => scaleReader.listPorts());

    ipcMain.removeHandler('scale:get-settings');
    ipcMain.handle('scale:get-settings', () => currentScaleSettings);

    ipcMain.removeHandler('scale:save-settings');
    ipcMain.handle('scale:save-settings', (_event, partial) => {
        const saved = scaleSettings.saveSettings(app, partial);
        applyScaleSettings(saved);
        return saved;
    });

    ipcMain.removeHandler('scale:test-connection');
    ipcMain.handle('scale:test-connection', async (_event, candidateSettings) => {
        // Serial ports are exclusive-access: release the live reader first, run the
        // test on its own throwaway port, then always resume the live (saved) settings
        // afterward — a test never leaves the app's actual feed broken.
        stopScaleSimulation();
        scaleReader.closeActivePort();
        try {
            return await scaleReader.testConnection(candidateSettings || {});
        } finally {
            applyScaleSettings(currentScaleSettings);
        }
    });
}

app.whenReady().then(() => {
    // The sandbox never has a real scale attached, so its first run starts in
    // test mode rather than the fail-closed default meant for the station.
    if (appEnvironment.sandbox && !fs.existsSync(scaleSettings.getSettingsPath(app))) {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        scaleSettings.saveSettings(app, { testModeEnabled: true });
    }
    currentScaleSettings = scaleSettings.loadSettings(app);
    registerScaleIpc();
    registerReceiptIpc();
    registerListadoIpc();
    registerCorapsaListadoIpc();
    registerOfflineQueueIpc();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // 1. Check for updates silently
    logUpdate(`App started, version ${app.getVersion()}. Checking for updates...`);
    autoUpdater.on('error', error => logUpdate(`Update error: ${error?.message || error}`));
    autoUpdater.on('update-available', info => logUpdate(`Update available: ${info.version}`));
    autoUpdater.on('update-not-available', info => logUpdate(`No update available (latest published: ${info?.version || 'unknown'})`));
    autoUpdater.checkForUpdatesAndNotify().catch(error => logUpdate(`checkForUpdatesAndNotify failed: ${error?.message || error}`));

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
    scaleReader.closeActivePort();
    ipcMain.removeHandler('scale-simulation:set-preset');
    ipcMain.removeHandler('scale:list-ports');
    ipcMain.removeHandler('scale:get-settings');
    ipcMain.removeHandler('scale:save-settings');
    ipcMain.removeHandler('scale:test-connection');
    ipcMain.removeHandler('receipt:print');
    ipcMain.removeHandler('listado:print');
    ipcMain.removeHandler('offline-queue:load');
    ipcMain.removeHandler('offline-queue:save');
    ipcMain.removeHandler('offline-queue:warn');
});