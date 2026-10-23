// Snapshots bascula.db and, when Spaces is configured, uploads the snapshot
// off the droplet — the only copy of clientes/transacciones/planilla/precios
// otherwise lives in the single SQLite file on local disk (see backend/bascula.db).
//
// Uses SQLite's VACUUM INTO instead of a plain `cp`: the app runs in WAL mode
// (see database.js) so a raw file copy can land mid-write and produce a
// snapshot that doesn't open cleanly. VACUUM INTO takes a consistent
// point-in-time snapshot through the driver itself, safely alongside the
// live server process.
//
// Usage: node backend/scripts/backup-database.js
// Intended to run on a schedule — see deploy/bascula-backup.service + .timer.

const fs = require('fs');
const os = require('os');
const path = require('path');
// Must run BEFORE ../storage is required — storage.js reads every SPACES_*
// var at module load. The systemd unit supplies them via EnvironmentFile, but
// a manual `node scripts/backup-database.js` got none of them, so the upload
// silently no-op'd and the "backup" never left the droplet.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const storage = require('../storage');

const DB_PATH = path.join(__dirname, '..', 'bascula.db');
const LOCAL_BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
// Local copies are a stopgap for same-disk failures only (a bad deploy, a
// fat-fingered delete) — they die with the droplet, unlike the Spaces upload
// below. Two days rather than seven because the timer now runs hourly: at 7
// days that would be ~168 snapshots sitting on the droplet's disk. Spaces
// keeps the long tail; local only needs to cover "undo the last few hours".
const LOCAL_RETENTION_DAYS = Number(process.env.BACKUP_LOCAL_RETENTION_DAYS || 2);

// Spaces layout. Every hourly snapshot used to be kept forever (~1,250 files,
// 1.2 GiB after two months, each a full copy of the database). Now:
//   backups/hourly/  every snapshot, deleted after HOURLY_RETENTION_DAYS
//   backups/daily/   one per day, kept forever — the last snapshot of that day
// so any hour of the last week can still be restored, and older history
// survives at one copy per day.
const SPACES_HOURLY_PREFIX = 'backups/hourly/';
const SPACES_DAILY_PREFIX = 'backups/daily/';
// Never under 1 day, so a typo in .env can't delete the snapshot just uploaded.
const HOURLY_RETENTION_DAYS = Math.max(1, Number(process.env.BACKUP_HOURLY_RETENTION_DAYS) || 7);
// "Which day" a snapshot belongs to follows the station's clock, not UTC:
// a 20:00 shift-end snapshot is 02:00 UTC the next day.
const BACKUP_TIMEZONE = process.env.BACKUP_TIMEZONE || 'America/Tegucigalpa';
const SQLITE_MIME_TYPE = 'application/vnd.sqlite3';

function timestampForFilename(date) {
    return date.toISOString().replace(/[:.]/g, '-');
}

// Inverse of timestampForFilename(), read from the end of any key or file name
// this script produced (including the old `backups/<uuid>-bascula-...` keys).
// Returns null for anything else, so pruning never touches a file it didn't name.
function snapshotTimeFromName(name) {
    const match = /bascula-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.db$/.exec(name);
    if (!match) return null;
    const [, day, hours, minutes, seconds, millis] = match;
    return new Date(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`);
}

const localDayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BACKUP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

function dailyKeyFor(date) {
    return `${SPACES_DAILY_PREFIX}bascula-${localDayFormatter.format(date)}.db`;
}

async function uploadToSpaces(localPath, fileName, takenAt) {
    const hourlyKey = SPACES_HOURLY_PREFIX + fileName;
    await storage.putObjectAtKey(hourlyKey, await fs.promises.readFile(localPath), SQLITE_MIME_TYPE);
    console.log(`Respaldo subido a Spaces: ${hourlyKey}`);

    // Overwritten every hour, so the copy that survives for each day is its
    // last snapshot: the whole day's work. Server-side copy, no second upload.
    const dailyKey = dailyKeyFor(takenAt);
    await storage.copyObject(hourlyKey, dailyKey);
    console.log(`Copia del día actualizada: ${dailyKey}`);

    // Only reached when both steps above succeeded. If the daily copy keeps
    // failing, hourly snapshots pile up instead of being pruned away.
    await pruneOldHourlyBackups(takenAt);
}

async function pruneOldHourlyBackups(now) {
    const cutoff = now.getTime() - HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const object of await storage.listObjects(SPACES_HOURLY_PREFIX)) {
        const takenAt = snapshotTimeFromName(object.key);
        if (!takenAt || takenAt.getTime() >= cutoff) continue;
        await storage.deleteObject(object.key);
        removed += 1;
    }
    if (removed > 0) console.log(`Respaldos por hora con más de ${HOURLY_RETENTION_DAYS} días eliminados de Spaces: ${removed}`);
}

async function pruneOldLocalBackups() {
    const cutoff = Date.now() - LOCAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const entries = await fs.promises.readdir(LOCAL_BACKUP_DIR).catch(() => []);
    for (const entry of entries) {
        if (!entry.startsWith('bascula-') || !entry.endsWith('.db')) continue;
        const filePath = path.join(LOCAL_BACKUP_DIR, entry);
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.promises.unlink(filePath).catch(() => {});
    }
}

async function main() {
    const startedAt = new Date();
    const fileName = `bascula-${timestampForFilename(startedAt)}.db`;

    await fs.promises.mkdir(LOCAL_BACKUP_DIR, { recursive: true });
    const localPath = path.join(LOCAL_BACKUP_DIR, fileName);

    // VACUUM INTO refuses to overwrite an existing file and needs a fresh path,
    // so snapshot to a tmp location first, then move it into place.
    const tmpPath = path.join(os.tmpdir(), fileName);
    await fs.promises.rm(tmpPath, { force: true });

    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    try {
        await db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
        await db.close();
    }
    await fs.promises.rename(tmpPath, localPath);
    console.log(`Respaldo local creado: ${localPath}`);

    if (storage.isConfigured()) {
        await uploadToSpaces(localPath, fileName, startedAt);
    } else {
        console.warn(
            'ADVERTENCIA: SPACES_* no está configurado — el respaldo solo existe en este disco, ' +
            'lo cual no protege contra la pérdida del droplet. Configure SPACES_* para subirlo fuera del servidor.'
        );
    }

    await pruneOldLocalBackups();
    return localPath;
}

module.exports = {
    runBackup: main,
    // For scripts/reorganize-spaces-backups.js, which moves the old flat
    // backups/ layout into this one.
    uploadToSpaces, snapshotTimeFromName, dailyKeyFor,
    SPACES_HOURLY_PREFIX, SPACES_DAILY_PREFIX, HOURLY_RETENTION_DAYS
};

// Only run automatically when invoked directly (`node backup-database.js`),
// not when reset-database.js requires this module to take a safety snapshot
// before wiping data.
if (require.main === module) {
    main().catch(error => {
        console.error('Falló el respaldo de la base de datos:', error);
        process.exitCode = 1;
    });
}
