const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomicWrite');

// Durable home for the renderer's offline outbox (see js/offlineQueue.js).
// A plain JSON file in userData, written synchronously — same pattern as
// scaleSettings.js — so a handful of pending patio-queue operations survive
// even an ungraceful power-loss restart, not just a clean app quit.
//
// Nothing here may ever read a failure as "the queue is empty". The renderer
// starts from an empty queue when a load fails, so the very next enqueue would
// write a one-operation file straight over N weighings nobody has synced yet —
// a transient antivirus lock or EIO turning into permanent data loss, in the
// one module whose entire job is not losing those weighings. So a load that
// fails for any reason other than "no file yet" moves the unreadable file
// aside for a human to recover, and if even that fails, refuses to save over
// it at all.

// Set while a file we could neither read nor move aside is still sitting at
// the live path. saveQueue keys off this to stay out of the way.
let unreadableQueueMessage = null;

function getQueuePath(app) {
    return path.join(app.getPath('userData'), 'offline-queue.json');
}

// Moves the bytes we couldn't read out of the live path, so a person can still
// recover the pending weighings from them by hand and the app can go back to
// persisting new ones without overwriting anything.
function preserveUnreadableQueue(queuePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const corruptPath = `${queuePath}.${stamp}.corrupt`;
    try {
        fs.renameSync(queuePath, corruptPath);
    } catch (error) {
        // Already gone (deleted by hand between the failed read and now) means
        // there is nothing left to protect, which is the outcome we wanted.
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    return corruptPath;
}

// Gets the unusable file out of the way and reports what the operator needs to
// hear. `corruptPath: null` in the result means it is STILL at the live path,
// and therefore that saving has to stay blocked.
function quarantineQueue(queuePath, reason) {
    try {
        const corruptPath = preserveUnreadableQueue(queuePath);
        unreadableQueueMessage = null;
        return { queue: [], failure: { message: reason, corruptPath } };
    } catch (error) {
        unreadableQueueMessage =
            `${reason} Tampoco se pudo apartar el archivo (${error.code || error.message}).`;
        return { queue: [], failure: { message: unreadableQueueMessage, corruptPath: null } };
    }
}

// Returns { queue, failure }: `failure` is non-null whenever the queue on disk
// could not be read, so the caller can tell the operator instead of quietly
// carrying on with an empty outbox.
function loadQueue(app) {
    const queuePath = getQueuePath(app);
    const fileName = path.basename(queuePath);

    let raw;
    try {
        raw = fs.readFileSync(queuePath, 'utf8');
    } catch (error) {
        // No file yet is the normal first-run / nothing-pending case, and the
        // only one where an empty queue is actually the truth.
        if (error.code === 'ENOENT') {
            unreadableQueueMessage = null;
            return { queue: [], failure: null };
        }
        return quarantineQueue(queuePath, `No se pudo leer ${fileName} (${error.code || error.message}).`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return quarantineQueue(queuePath, `${fileName} no contiene JSON válido (${error.message}).`);
    }

    // A file that parses but isn't a list is as unusable as one that doesn't
    // parse, and just as likely to be holding real weighings.
    if (!Array.isArray(parsed)) {
        return quarantineQueue(queuePath, `${fileName} no contiene una lista de operaciones.`);
    }

    unreadableQueueMessage = null;
    return { queue: parsed, failure: null };
}

// For the caller to use when it can't even get a verdict out of loadQueue (an
// unexpected throw): the file's state is then unknown, which is precisely the
// case that must not be treated as "empty". Blocks saving on the same terms as
// a file we couldn't move aside, and self-heals the same way.
function blockPersistence(reason) {
    unreadableQueueMessage = reason;
}

function saveQueue(app, queue) {
    const queuePath = getQueuePath(app);

    if (unreadableQueueMessage) {
        // Whatever made the file unreadable is often transient — an antivirus
        // scan or backup agent holding it open — so retry moving it aside on
        // every save. That way the outbox heals itself once the file is free
        // instead of staying dead for the rest of the session.
        try {
            preserveUnreadableQueue(queuePath);
            unreadableQueueMessage = null;
        } catch (error) {
            throw new Error(
                `${unreadableQueueMessage} No se guardarán cambios nuevos en disco ` +
                'para no sobrescribir los que ya estaban ahí.'
            );
        }
    }

    const list = Array.isArray(queue) ? queue : [];
    writeFileAtomic(queuePath, JSON.stringify(list, null, 2));
    return list;
}

module.exports = { loadQueue, saveQueue, blockPersistence };
