/* STREAMING_CHUNK: Importing Electron modules and path helpers... */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

/* STREAMING_CHUNK: Defining the browser window creation logic... */
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

    // Load our single HTML file containing the entire UI
    mainWindow.loadFile('index.html');

    // Clean up window memory when closed
    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

/* STREAMING_CHUNK: Managing the Electron application lifecycle... */
app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    
    // Start simulating scale data to send to the UI
    startScaleSimulation();
});

// For Windows/Linux compatibility
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

/* STREAMING_CHUNK: Simulating hardware serial stream data... */
// This simulates sending the physical RS232 scale data to the UI.
// Later we will replace this with real "serialport" library calls!
function startScaleSimulation() {
    setInterval(() => {
        if (mainWindow) {
            // Generate a random heavy weight around 20,500kg
            const jitter = Math.floor(Math.random() * 40) - 20;
            const simulatedWeight = 20500 + jitter;
            
            // Check if weight is stable (low jitter)
            const isStable = Math.abs(jitter) < 8;

            // Send this weight data securely down to the UI
            mainWindow.webContents.send('scale-data', {
                weight: simulatedWeight,
                stable: isStable
            });
        }
    }, 500); // Send data twice per second
}