// `npm run dev` / `npm start`: the whole sandbox in one terminal. Starts the
// local server on its own test database (backend/sandbox/), waits until it
// answers, then opens the app pointed at it. Closing the app window, or Ctrl+C
// here, stops both. Nothing started from here can reach production — see
// ../environment.js and DESARROLLO.md.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { SANDBOX_API_URL } = require('../environment');

const FRONTEND_DIR = path.join(__dirname, '..');
const BACKEND_DIR = path.join(FRONTEND_DIR, '..', 'backend');
const { hostname: HOST, port: PORT } = new URL(SANDBOX_API_URL);
const STARTUP_TIMEOUT_MS = 20000;
// How long a process gets to shut down cleanly before it is killed outright.
const SHUTDOWN_GRACE_MS = 5000;

const children = [];
let stopping = false;

function log(message) {
    console.log(`[dev] ${message}`);
}

function isRunning(child) {
    return child.exitCode === null && child.signalCode === null;
}

function launch(label, command, args, options) {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
        readline.createInterface({ input: stream }).on('line', line => console.log(`${label} ${line}`));
    }
    children.push(child);
    return child;
}

function stopAll() {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (isRunning(child)) child.kill('SIGTERM');
    setTimeout(() => {
        for (const child of children) if (isRunning(child)) child.kill('SIGKILL');
    }, SHUTDOWN_GRACE_MS).unref();
}

// Ctrl+C in the terminal already reaches the server and the app directly (same
// process group), so give them a moment to stop on their own before signalling
// them a second time.
process.on('SIGINT', () => setTimeout(stopAll, 1500).unref());
process.on('SIGTERM', stopAll);

function portInUse() {
    return new Promise(resolve => {
        const socket = net.connect({ host: HOST, port: Number(PORT) });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

async function waitUntilHealthy(server) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline && isRunning(server)) {
        try {
            if ((await fetch(`${SANDBOX_API_URL}/api/health`)).ok) return true;
        } catch (_) {
            // Not listening yet.
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
}

async function main() {
    if (await portInUse()) {
        log(`El puerto ${PORT} ya está en uso: probablemente hay otro "npm run dev" abierto. Ciérrelo e intente de nuevo.`);
        process.exitCode = 1;
        return;
    }

    log('Iniciando el servidor sandbox (datos de prueba, nunca producción)...');
    const server = launch('[servidor]', process.execPath, ['server.js'], {
        cwd: BACKEND_DIR,
        env: {
            ...process.env,
            BASCULA_SANDBOX: '1',
            HOST,
            PORT,
            // Full error messages instead of the generic ones production shows.
            NODE_ENV: 'development',
            // No auth locally. Set, even though empty, so dotenv can't fill it
            // in from a backend/.env on this computer.
            API_KEY: ''
        }
    });

    let serverReady = false;
    server.on('exit', (code, signal) => {
        if (stopping || !serverReady) return;
        log(`El servidor sandbox se detuvo solo (${signal || `código ${code}`}); cerrando la app.`);
        process.exitCode = 1;
        stopAll();
    });

    if (!(await waitUntilHealthy(server))) {
        log('El servidor sandbox no arrancó; vea los mensajes de [servidor] arriba.');
        process.exitCode = 1;
        stopAll();
        return;
    }
    serverReady = true;

    log(`Servidor listo en ${SANDBOX_API_URL}. Abriendo la app...`);
    const appProcess = launch('[app]', require('electron'), ['.'], {
        cwd: FRONTEND_DIR,
        // What environment.js defaults to anyway, set explicitly so a
        // BASCULA_API_URL left over in this shell can't point the app elsewhere.
        env: { ...process.env, BASCULA_API_URL: SANDBOX_API_URL }
    });
    appProcess.on('exit', code => {
        if (!stopping) log('App cerrada; deteniendo el servidor sandbox.');
        if (code) process.exitCode = code;
        stopAll();
    });
}

main().catch(error => {
    console.error('[dev] Error inesperado:', error);
    process.exitCode = 1;
    stopAll();
});
