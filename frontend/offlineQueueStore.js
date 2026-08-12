const fs = require('fs');
const path = require('path');

// Durable home for the renderer's offline outbox (see js/offlineQueue.js).
// A plain JSON file in userData, written synchronously — same pattern as
// scaleSettings.js — so a handful of pending patio-queue operations survive
// even an ungraceful power-loss restart, not just a clean app quit.

function getQueuePath(app) {
    return path.join(app.getPath('userData'), 'offline-queue.json');
}

function loadQueue(app) {
    try {
        const raw = fs.readFileSync(getQueuePath(app), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('No se pudo leer offline-queue.json, iniciando con cola vacía:', error.message);
        }
        return [];
    }
}

function saveQueue(app, queue) {
    const list = Array.isArray(queue) ? queue : [];
    fs.writeFileSync(getQueuePath(app), JSON.stringify(list, null, 2), 'utf8');
    return list;
}

module.exports = { loadQueue, saveQueue };
