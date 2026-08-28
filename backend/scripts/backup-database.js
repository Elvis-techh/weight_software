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

function timestampForFilename(date) {
    return date.toISOString().replace(/[:.]/g, '-');
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
        const buffer = await fs.promises.readFile(localPath);
        const key = await storage.uploadObject('backups', buffer, fileName, 'application/vnd.sqlite3');
        console.log(`Respaldo subido a Spaces: ${key}`);
    } else {
        console.warn(
            'ADVERTENCIA: SPACES_* no está configurado — el respaldo solo existe en este disco, ' +
            'lo cual no protege contra la pérdida del droplet. Configure SPACES_* para subirlo fuera del servidor.'
        );
    }

    await pruneOldLocalBackups();
    return localPath;
}

module.exports = { runBackup: main };

// Only run automatically when invoked directly (`node backup-database.js`),
// not when reset-database.js requires this module to take a safety snapshot
// before wiping data.
if (require.main === module) {
    main().catch(error => {
        console.error('Falló el respaldo de la base de datos:', error);
        process.exitCode = 1;
    });
}
