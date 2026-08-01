const fs = require('fs');
const path = require('path');

// Off by default: with no saved settings yet (first run) or a corrupt/missing
// settings file, the app must stay in "no data" mode rather than silently
// simulating — this is what makes the fail-closed behavior actually closed.
const DEFAULT_SCALE_SETTINGS = Object.freeze({
    testModeEnabled: false,
    comPort: '',
    baudRate: 9600,
    parsePattern: ''
});

function getSettingsPath(app) {
    return path.join(app.getPath('userData'), 'scale-settings.json');
}

function isValidRegex(pattern) {
    if (!pattern) return true;
    try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
        return true;
    } catch (_) {
        return false;
    }
}

function normalizeSettings(raw, { strict = false } = {}) {
    const merged = { ...DEFAULT_SCALE_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const parsePattern = String(merged.parsePattern || '');
    const patternValid = isValidRegex(parsePattern);

    if (!patternValid) {
        if (strict) throw new Error('El patrón de lectura no es una expresión regular válida.');
        console.warn('scale-settings.json tiene un parsePattern inválido; se ignorará.');
    }

    const baudRate = Number(merged.baudRate);

    return {
        testModeEnabled: Boolean(merged.testModeEnabled),
        comPort: String(merged.comPort || ''),
        baudRate: Number.isFinite(baudRate) && baudRate > 0 ? baudRate : DEFAULT_SCALE_SETTINGS.baudRate,
        parsePattern: patternValid ? parsePattern : ''
    };
}

function loadSettings(app) {
    const settingsPath = getSettingsPath(app);
    try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        return normalizeSettings(JSON.parse(raw));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('No se pudo leer scale-settings.json, usando valores por defecto:', error.message);
        }
        return { ...DEFAULT_SCALE_SETTINGS };
    }
}

function saveSettings(app, partial) {
    const current = loadSettings(app);
    const next = normalizeSettings({ ...current, ...partial }, { strict: true });
    fs.writeFileSync(getSettingsPath(app), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

module.exports = { DEFAULT_SCALE_SETTINGS, loadSettings, saveSettings, normalizeSettings };
