const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Default strategy: first signed float found in the line. Matches both a bare
// "20500" reading and a structured one like "ST,GS,+012345,lb" -> 12345.
const DEFAULT_WEIGHT_REGEX = /[-+]?\d+(?:\.\d+)?/;

// Rolling-window stability heuristic, hardware-agnostic (works regardless of
// what protocol the real scale turns out to speak). Readings must agree for a
// full second, not just three lines: indicators commonly send 10-20 lines a
// second, so three lines was a 150-300 ms window, shorter than a truck's
// settling sway. Tolerance roughly matches the old simulator's +-2 jitter.
const STABILITY_WINDOW_MS = 1000;
const STABILITY_MIN_SAMPLES = 3;
const STABILITY_TOLERANCE_LBS = 3;
// Lines with no readable weight (overload "OL", "------", an error code, a
// changed print format) prove the cable is alive, not that the scale is
// readable. After this long with only those, the screen says so instead of
// keeping the last stable weight up.
const INVALID_FRAME_AFTER_MS = 1500;
// A custom pattern runs on every line in the main process, so a long one (and
// the catastrophic backtracking it can bring) is refused.
const MAX_PATTERN_LENGTH = 200;

const STALE_AFTER_MS = 3000;
const WATCHDOG_INTERVAL_MS = 1000;
const RECONNECT_DELAY_MS = 5000;
// If the configured comPort was reassigned by the OS (a second adapter,
// device re-enumeration), reconnecting retries that same stale path forever
// with nothing telling anyone. After this many consecutive failed opens
// (~30s at RECONNECT_DELAY_MS=5000) flag it once instead of retrying silently.
const MAX_SILENT_RECONNECT_ATTEMPTS = 6;

let activePort = null;
let activeParser = null;
let activeSettings = null;
let recentReadings = [];
let lastLineReceivedAt = 0;
let watchdogTimer = null;
let staleNotified = false;
let onReading = () => {};
let reconnectTimer = null;
let consecutiveOpenFailures = 0;
let portNotFoundNoticeSent = false;

function noteOpenFailure() {
    consecutiveOpenFailures += 1;
    if (consecutiveOpenFailures === MAX_SILENT_RECONNECT_ATTEMPTS && !portNotFoundNoticeSent) {
        portNotFoundNoticeSent = true;
        onReading({ weight: 0, stable: false, source: 'disconnected', preset: '', staleReason: 'port-not-found' });
    }
}

function noteOpenSuccess() {
    consecutiveOpenFailures = 0;
    portNotFoundNoticeSent = false;
}

// Compiled once per settings change, not once per line.
function compilePattern(parsePattern) {
    if (parsePattern instanceof RegExp) return parsePattern;
    if (!parsePattern || parsePattern.length > MAX_PATTERN_LENGTH) return DEFAULT_WEIGHT_REGEX;
    try {
        return new RegExp(parsePattern);
    } catch (_) {
        return DEFAULT_WEIGHT_REGEX;
    }
}

function parseWeightFromLine(line, parsePattern) {
    const match = compilePattern(parsePattern).exec(line);
    if (!match) return null;
    const raw = match.length > 1 && match[1] !== undefined ? match[1] : match[0];
    const weight = Number(raw);
    return Number.isFinite(weight) ? weight : null;
}

// The indicator's own status where the frame carries it, e.g.
// "ST,GS,+012345,lb" (stable) or "US,GS,+012345,lb" (in motion). null when the
// frame doesn't say.
function readFrameFlags(line) {
    const upper = String(line).toUpperCase();
    return {
        motion: /\b(US|MOTION)\b/.test(upper) ? true : /\bST\b/.test(upper) ? false : null,
        unit: /\bKGS?\b/.test(upper) ? 'kg' : /\bLBS?\b/.test(upper) ? 'lb' : null
    };
}

function computeStability(weight, now, motion) {
    recentReadings.push({ weight, at: now });
    // Keep the last second of readings, but never fewer than the minimum.
    while (recentReadings.length > STABILITY_MIN_SAMPLES && now - recentReadings[1].at >= STABILITY_WINDOW_MS) {
        recentReadings.shift();
    }
    if (motion === true) return false; // the indicator itself says it's moving
    if (recentReadings.length < STABILITY_MIN_SAMPLES) return false;
    if (now - recentReadings[0].at < STABILITY_WINDOW_MS) return false;
    const weights = recentReadings.map(sample => sample.weight);
    return Math.max(...weights) - Math.min(...weights) <= STABILITY_TOLERANCE_LBS;
}

function emitDisconnected() {
    if (staleNotified) return;
    staleNotified = true;
    recentReadings = [];
    onReading({ weight: 0, stable: false, source: 'disconnected', preset: '' });
}

// 'invalid' readings carry weight 0 and never count as stable, so neither PESO
// button can capture while one is on screen.
function emitInvalid(staleReason) {
    recentReadings = [];
    onReading({ weight: 0, stable: false, source: 'invalid', preset: '', staleReason });
}

function emitReading(weight, line = '') {
    staleNotified = false;
    const { motion, unit } = readFrameFlags(line);
    if (unit === 'kg') {
        // Every price and limit in the app is in pounds; a kg frame stored as
        // lb is 2.2x off. Refuse it, and the screen says why.
        emitInvalid('unit-kg');
        return;
    }
    onReading({ weight, stable: computeStability(weight, Date.now(), motion), source: 'scale', preset: '' });
}

function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
}

function stopReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
}

// Retries the last-used settings after a bumped cable, a scale power-cycle,
// or a port that briefly fails to open. Only ever armed from an unexpected
// error/close while a listener is still attached — closeActivePort() strips
// listeners before an intentional close, so that path never schedules one.
function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        resumeActiveReader();
    }, RECONNECT_DELAY_MS);
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
// `onClosed`, if given, fires once the OS handle has actually been released
// (or immediately if there was nothing to close) — callers that are about to
// exit the process need this: on Windows a COM port close is asynchronous, and
// killing the process before it finishes can leave the handle stuck until the
// cable is unplugged.
function closeActivePort(onClosed) {
    const done = typeof onClosed === 'function' ? onClosed : () => {};
    stopWatchdog();
    stopReconnectTimer();
    if (activeParser) {
        activeParser.removeAllListeners();
        activeParser = null;
    }
    if (activePort) {
        const port = activePort;
        activePort = null;
        port.removeAllListeners();
        if (port.isOpen) {
            port.close(() => done());
        } else {
            done();
        }
    } else {
        done();
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
        consecutiveOpenFailures = 0;
        portNotFoundNoticeSent = false;
        return;
    }

    if (!settings.comPort) {
        consecutiveOpenFailures = 0;
        portNotFoundNoticeSent = false;
        emitDisconnected();
        return;
    }

    try {
        activePort = new SerialPort({ path: settings.comPort, baudRate: settings.baudRate, autoOpen: false });
    } catch (error) {
        console.error('No se pudo crear el puerto serial:', error.message);
        emitDisconnected();
        noteOpenFailure();
        return;
    }

    const compiledPattern = compilePattern(settings.parsePattern);
    let lastValidReadingAt = Date.now();
    let invalidFrameNotified = false;
    activeParser = activePort.pipe(new ReadlineParser({ delimiter: '\n' }));
    activeParser.on('data', line => {
        const now = Date.now();
        const text = String(line);
        lastLineReceivedAt = now;
        const weight = parseWeightFromLine(text, compiledPattern);
        if (weight !== null) {
            lastValidReadingAt = now;
            invalidFrameNotified = false;
            emitReading(weight, text);
            return;
        }
        // The cable is alive (the watchdog stays quiet) but nothing readable is
        // coming: say so once, instead of leaving the last weight on screen.
        if (!invalidFrameNotified && now - lastValidReadingAt > INVALID_FRAME_AFTER_MS) {
            invalidFrameNotified = true;
            staleNotified = false;
            emitInvalid('invalid-frame');
        }
    });
    // .pipe() never forwards 'error' from source to destination, so the parser
    // needs its own handler — without one, a parser fault is an unhandled
    // EventEmitter error. main.js's uncaughtException handler stops it from
    // crashing the app, but nothing here would ever call scheduleReconnect(),
    // so the feed would stay "disconnected" forever with no retry.
    activeParser.on('error', error => {
        console.error('Error del parser de báscula:', error.message);
        emitDisconnected();
        scheduleReconnect();
    });

    activePort.on('error', error => {
        console.error('Error del puerto serial:', error.message);
        emitDisconnected();
        scheduleReconnect();
    });
    activePort.on('close', () => {
        emitDisconnected();
        scheduleReconnect();
    });

    activePort.open(error => {
        if (error) {
            console.error('No se pudo abrir el puerto serial:', error.message);
            emitDisconnected();
            noteOpenFailure();
            scheduleReconnect();
            return;
        }
        noteOpenSuccess();
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
        // Swallowing this into [] used to make a broken native binding / driver
        // failure look exactly like "no scale plugged in" — worst possible
        // moment to be ambiguous is first-time kiosk setup. Rethrow so the IPC
        // call rejects and the renderer can tell the technician this is a
        // software problem, not a hardware one.
        console.error('No se pudo listar los puertos seriales:', error.message);
        throw error;
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
            const { unit } = readFrameFlags(rawLine);
            finish({
                ok: parsedWeight !== null && unit !== 'kg',
                rawLine,
                parsedWeight,
                ...(unit === 'kg' ? { error: 'El indicador envía kilogramos; configúrelo en libras (lb)' } : {})
            });
        });
        parser.once('error', error => finish({ ok: false, error: error.message }));

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
    parseWeightFromLine,
    readFrameFlags,
    MAX_PATTERN_LENGTH
};
