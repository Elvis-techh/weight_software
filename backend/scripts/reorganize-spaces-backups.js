// One-time move of the old flat Spaces layout (every hourly snapshot kept
// forever as backups/<uuid>-bascula-<timestamp>.db) into the one
// backup-database.js now writes:
//   - the last snapshot of each day is copied to backups/daily/ (kept forever)
//   - snapshots from the last HOURLY_RETENTION_DAYS move to backups/hourly/
//   - the rest are deleted, but only once their day's daily copy is confirmed
//
// Without --confirm it only prints the plan and changes nothing. Safe to
// re-run: a day that already has a daily copy is not copied again, and
// anything a failed run left behind is picked up the next time.
//
// Usage (backend/ as the working directory):
//   node scripts/reorganize-spaces-backups.js             # dry run
//   node scripts/reorganize-spaces-backups.js --confirm   # apply

const path = require('path');
// Before ../storage — see the same note in backup-database.js.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const storage = require('../storage');
const {
    snapshotTimeFromName, dailyKeyFor,
    SPACES_HOURLY_PREFIX, SPACES_DAILY_PREFIX, HOURLY_RETENTION_DAYS
} = require('./backup-database');

const toMiB = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;
const sumSizes = objects => objects.reduce((total, object) => total + object.size, 0);

async function main() {
    if (!storage.isConfigured()) {
        console.error('SPACES_KEY / SPACES_SECRET / SPACES_BUCKET / SPACES_REGION / SPACES_ENDPOINT must all be set.');
        process.exitCode = 1;
        return;
    }
    const confirm = process.argv.includes('--confirm');
    const cutoff = Date.now() - HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const all = await storage.listObjects('backups/');
    const inNewLayout = key => key.startsWith(SPACES_HOURLY_PREFIX) || key.startsWith(SPACES_DAILY_PREFIX);
    const legacy = [];
    const unknown = [];
    for (const object of all) {
        if (inNewLayout(object.key)) continue;
        const takenAt = snapshotTimeFromName(object.key);
        if (takenAt) legacy.push({ ...object, takenAt, dailyKey: dailyKeyFor(takenAt) });
        else unknown.push(object);
    }

    const existingDaily = new Set(all.filter(o => o.key.startsWith(SPACES_DAILY_PREFIX)).map(o => o.key));
    const lastOfDay = new Map();
    for (const object of legacy) {
        const current = lastOfDay.get(object.dailyKey);
        if (!current || object.takenAt > current.takenAt) lastOfDay.set(object.dailyKey, object);
    }
    const dailyCopies = [...lastOfDay.values()]
        .filter(object => !existingDaily.has(object.dailyKey))
        .sort((a, b) => a.takenAt - b.takenAt);
    const toHourly = legacy.filter(object => object.takenAt.getTime() >= cutoff);
    const toDelete = legacy.filter(object => object.takenAt.getTime() < cutoff);

    console.log(`Respaldos con el formato anterior: ${legacy.length} (${toMiB(sumSizes(legacy))})`);
    console.log(`  Copia del día a ${SPACES_DAILY_PREFIX}: ${dailyCopies.length} día(s) (${toMiB(sumSizes(dailyCopies))})`);
    for (const object of dailyCopies) console.log(`    ${object.dailyKey}  <-  ${object.key}`);
    console.log(`  Mover a ${SPACES_HOURLY_PREFIX} (últimos ${HOURLY_RETENTION_DAYS} días): ${toHourly.length} (${toMiB(sumSizes(toHourly))})`);
    console.log(`  Eliminar (más viejos, ya cubiertos por su copia del día): ${toDelete.length} (${toMiB(sumSizes(toDelete))})`);
    if (unknown.length > 0) {
        console.log(`  Sin tocar (nombre no reconocido): ${unknown.length}`);
        for (const object of unknown) console.log(`    ${object.key}`);
    }

    if (!confirm) {
        console.log('\nSimulación: no se cambió nada. Para aplicarlo: node scripts/reorganize-spaces-backups.js --confirm');
        return;
    }

    // Copies first; any failure throws here, before anything is deleted.
    for (const object of dailyCopies) await storage.copyObject(object.key, object.dailyKey);
    console.log(`Copias del día creadas: ${dailyCopies.length}`);

    for (const object of toHourly) {
        const fileName = /bascula-[^/]*\.db$/.exec(object.key)[0];
        await storage.copyObject(object.key, SPACES_HOURLY_PREFIX + fileName);
        await storage.deleteObject(object.key);
    }
    console.log(`Movidos a ${SPACES_HOURLY_PREFIX}: ${toHourly.length}`);

    // Re-read rather than trust the copies above: a snapshot is only deleted
    // when its day's copy is really there.
    const confirmedDaily = new Set((await storage.listObjects(SPACES_DAILY_PREFIX)).map(o => o.key));
    let deleted = 0;
    let deletedBytes = 0;
    let kept = 0;
    for (const object of toDelete) {
        if (!confirmedDaily.has(object.dailyKey)) {
            kept += 1;
            continue;
        }
        await storage.deleteObject(object.key);
        deleted += 1;
        deletedBytes += object.size;
        if (deleted % 100 === 0) console.log(`  ...${deleted}/${toDelete.length} eliminados`);
    }
    console.log(`Eliminados: ${deleted} (${toMiB(deletedBytes)})`);
    if (kept > 0) {
        console.error(`ATENCIÓN: ${kept} respaldo(s) NO se eliminaron porque su copia del día no aparece. Vuelva a correr el script.`);
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error('Falló la reorganización de respaldos:', error);
    process.exitCode = 1;
});
