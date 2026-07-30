const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Default strategy: first signed float found in the line. Matches both a bare
// "20500" reading and a structured one like "ST,GS,+012345,lb" -> 12345.
const DEFAULT_WEIGHT_REGEX = /[-+]?\d+(?:\.\d+)?/;

// Rolling-window stability heuristic, hardware-agnostic (works regardless of
// what protocol the real scale turns out to speak). Tolerance roughly matches
// the old simulator's own +-2 jitter range.
const STABILITY_SAMPLE_COUNT = 3;
const STABILITY_TOLERANCE_LBS = 3;

const STALE_AFTER_MS = 3000;
const WATCHDOG_INTERVAL_MS = 1000;

let activePort = null;
let activeParser = null;
let activeSettings = null;
let recentReadings = [];
let lastLineReceivedAt = 0;
let watchdogTimer = null;
let staleNotified = false;
let onReading = () => {};

function parseWeightFromLine(line, parsePattern) {
    let regex = DEFAULT_WEIGHT_REGEX;
    if (parsePattern) {
        try {
            regex = new RegExp(parsePattern);
        } catch (_) {
            regex = DEFAULT_WEIGHT_REGEX;
        }
    }
    const match = regex.exec(line);
    if (!match) return null;
    const raw = match.length > 1 && match[1] !== undefined ? match[1] : match[0];
    const weight = Number(raw);
    return Number.isFinite(weight) ? weight : null;
}

function computeStability(weight) {
    recentReadings.push(weight);
    if (recentReadings.length > STABILITY_SAMPLE_COUNT) recentReadings.shift();
    if (recentReadings.length < STABILITY_SAMPLE_COUNT) return false;
    const max = Math.max(...recentReadings);
    const min = Math.min(...recentReadings);
    return (max - min) <= STABILITY_TOLERANCE_LBS;
}

function emitDisconnected() {
    if (staleNotified) return;
    staleNotified = true;
    recentReadings = [];
    onReading({ weight: 0, stable: false, source: 'disconnected', preset: '' });
}

function emitReading(weight) {
    staleNotified = false;
    const stable = computeStability(weight);
    onReading({ weight, stable, source: 'scale', preset: '' });
}

function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
}

function startWatchdog() {
    stopWatchdog();
    watchdogTimer = setInterval(() => {
        if (lastLineReceivedAt && (Date.now() - lastLineReceivedAt > STALE_AFTER_MS)) {
            emitDisconnected();
        }
    }, WATCHDOG_INTERVAL_MS);
}

// Closes whatever port/parser/watchdog is currently active. Safe to call when
// nothing is open. Does not touch `activeSettings` so a caller can resume later.
function closeActivePort() {
    stopWatchdog();
    if (activeParser) {
        activeParser.removeAllListeners();
        activeParser = null;
    }
    if (activePort) {
        const port = activePort;
        activePort = null;
        port.removeAllListeners();
        if (port.isOpen) port.close(() => {});
    }
    recentReadings = [];
    lastLineReceivedAt = 0;
    staleNotified = false;
}

// Applies `settings` as the live configuration and (re)opens hardware if
// appropriate. `readingCallback` receives every {weight, stable, source, preset}
// event, including the immediate 'disconnected' one when nothing is configured.
function startReading(settings, readingCallback) {
    closeActivePort();
    activeSettings = settings;
    onReading = typeof readingCallback === 'function' ? readingCallback : () => {};

    if (settings.testModeEnabled) {
        // Test mode owns the scale-data channel via the simulator instead — stay idle.
        return;
    }

    if (!settings.comPort) {
        emitDisconnected();
        return;
    }

    try {
        activePort = new SerialPort({ path: settings.comPort, baudRate: settings.baudRate, autoOpen: false });
    } catch (error) {
        console.error('No se pudo crear el puerto serial:', error.message);
        emitDisconnected();
        return;
    }

    activeParser = activePort.pipe(new ReadlineParser({ delimiter: '\n' }));
    activeParser.on('data', line => {
        lastLineReceivedAt = Date.now();
        const weight = parseWeightFromLine(String(line), settings.parsePattern);
        if (weight !== null) emitReading(weight);
    });

    activePort.on('error', error => {
        console.error('Error del puerto serial:', error.message);
        emitDisconnected();
    });
    activePort.on('close', () => emitDisconnected());

    activePort.open(error => {
        if (error) {
            console.error('No se pudo abrir el puerto serial:', error.message);
            emitDisconnected();
            return;
        }
        lastLineReceivedAt = 0;
        startWatchdog();
    });
}

function resumeActiveReader() {
    if (activeSettings) startReading(activeSettings, onReading);
}

async function listPorts() {
    try {
        const ports = await SerialPort.list();
        return ports.map(p => ({ path: p.path, manufacturer: p.manufacturer || '' }));
    } catch (error) {
        console.error('No se pudo listar los puertos seriales:', error.message);
        return [];
    }
}

// Opens a throwaway port with candidate settings, waits (bounded) for one line,
// reports the raw line + parsed weight, then closes. Never touches the active reader.
function testConnection({ comPort, baudRate, parsePattern }) {
    return new Promise(resolve => {
        let settled = false;
        let testPort;

        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (testPort) {
                testPort.removeAllListeners();
                if (testPort.isOpen) testPort.close(() => {});
            }
            resolve(result);
        };

        const timeout = setTimeout(() => {
            finish({ ok: false, error: 'No se recibió ninguna lectura en 4 segundos.' });
        }, 4000);

        if (!comPort) {
            finish({ ok: false, error: 'Seleccione un puerto COM.' });
            return;
        }

        try {
            testPort = new SerialPort({ path: comPort, baudRate, autoOpen: false });
        } catch (error) {
            finish({ ok: false, error: error.message });
            return;
        }

        const parser = testPort.pipe(new ReadlineParser({ delimiter: '\n' }));
        parser.once('data', line => {
            const rawLine = String(line);
            const parsedWeight = parseWeightFromLine(rawLine, parsePattern);
            finish({ ok: parsedWeight !== null, rawLine, parsedWeight });
        });

        testPort.on('error', error => finish({ ok: false, error: error.message }));

        testPort.open(error => {
            if (error) finish({ ok: false, error: error.message });
        });
    });
}

module.exports = {
    startReading,
    closeActivePort,
    resumeActiveReader,
    listPorts,
    testConnection,
    parseWeightFromLine
};
