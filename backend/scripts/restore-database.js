// Restores bascula.db from a snapshot taken by backup-database.js.
//
// This exists because the obvious `cp snapshot.db bascula.db` is WRONG and
// fails silently. The app runs in WAL mode, so an unclean shutdown (power
// loss, OOM kill, `kill -9`) leaves a hot bascula.db-wal on disk. Copying a
// snapshot over bascula.db while those sidecar files are still there makes
// SQLite replay the dead instance's WAL on top of the restored file: the
// snapshot's contents are discarded, the crashed instance's are resurrected,
// and PRAGMA integrity_check still reports "ok". Measured on a real snapshot:
// 73,000 transacciones restored as 0, with no error anywhere.
//
// So: remove the sidecars, copy, then read the restored file back and print
// row counts, so the operator can confirm what actually landed instead of
// assuming.
//
// Usage (backend/ as the working directory, server stopped):
//   pm2 stop bascula-backend
//   node scripts/restore-database.js backups/bascula-<timestamp>.db --confirm
//   pm2 start bascula-backend

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = path.join(__dirname, '..', 'bascula.db');
const SIDECARS = [`${DB_PATH}-wal`, `${DB_PATH}-shm`];

// Printed after the restore so the operator sees what they actually got. Same
// tables reset-database.js wipes, which are the ones worth confirming.
const COUNTED_TABLES = [
    'clientes',
    'camiones_en_patio',
    'transacciones',
    'corapsa',
    'corapsa_pagos',
    'gastos',
    'planilla',
    'auditoria'
];

async function countRows(filename) {
    const db = await open({ filename, driver: sqlite3.Database });
    try {
        const check = await db.get('PRAGMA integrity_check');
        const counts = {};
        for (const table of COUNTED_TABLES) {
            // A snapshot from an older schema may legitimately lack a table.
            const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`).catch(() => null);
            counts[table] = row ? Number(row.n) : null;
        }
        return { integrity: check?.integrity_check || 'desconocido', counts };
    } finally {
        await db.close();
    }
}

function formatCounts(counts) {
    return COUNTED_TABLES
        .map(table => `    ${table.padEnd(20)} ${counts[table] === null ? '(no existe)' : String(counts[table])}`)
        .join('\n');
}

async function main() {
    const args = process.argv.slice(2);
    const snapshotArg = args.find(value => !value.startsWith('--'));

    if (!snapshotArg) {
        console.error(
            'Indique el archivo de respaldo a restaurar.\n' +
            'Ejemplo: node scripts/restore-database.js backups/bascula-2026-08-27T04-00-00-000Z.db --confirm'
        );
        process.exitCode = 1;
        return;
    }

    const snapshotPath = path.resolve(snapshotArg);
    if (!fs.existsSync(snapshotPath)) {
        console.error(`No se encontró el archivo de respaldo: ${snapshotPath}`);
        process.exitCode = 1;
        return;
    }

    // Read the snapshot BEFORE touching anything, so a corrupt or truncated
    // download is caught while the current database is still intact.
    console.log(`Verificando el respaldo: ${snapshotPath}`);
    let snapshot;
    try {
        snapshot = await countRows(snapshotPath);
    } catch (error) {
        console.error(`El respaldo no se pudo abrir como base de datos SQLite: ${error.message}`);
        process.exitCode = 1;
        return;
    }

    if (snapshot.integrity !== 'ok') {
        console.error(`El respaldo no pasó integrity_check (${snapshot.integrity}). No se restauró nada.`);
        process.exitCode = 1;
        return;
    }

    console.log('  integrity_check: ok');
    console.log(formatCounts(snapshot.counts));

    const hotSidecars = SIDECARS.filter(file => fs.existsSync(file));
    const currentExists = fs.existsSync(DB_PATH);

    if (!args.includes('--confirm')) {
        console.error(
            '\nEsto REEMPLAZA backend/bascula.db con el respaldo de arriba.\n' +
            (hotSidecars.length
                ? `Se eliminarán también ${hotSidecars.length} archivo(s) WAL/SHM del cierre anterior.\n`
                : '') +
            'Detenga el servidor primero (pm2 stop bascula-backend) y vuelva a correr con --confirm.'
        );
        process.exitCode = 1;
        return;
    }

    // Keep the file being replaced. If this restore turns out to be the wrong
    // snapshot, the state it overwrote is still on disk to go back to.
    if (currentExists) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const asidePath = `${DB_PATH}.reemplazada-${stamp}`;
        await fs.promises.rename(DB_PATH, asidePath);
        console.log(`\nBase de datos anterior movida a: ${asidePath}`);
    }

    // The whole point of this script: the sidecars must go, and they must go
    // AFTER the old database has been moved aside (they belong to it, not to
    // the snapshot being restored).
    for (const file of SIDECARS) {
        await fs.promises.rm(file, { force: true });
    }
    if (hotSidecars.length) {
        console.log(`Eliminados ${hotSidecars.length} archivo(s) WAL/SHM del cierre anterior.`);
    }

    await fs.promises.copyFile(snapshotPath, DB_PATH);
    console.log(`Respaldo copiado a: ${DB_PATH}`);

    // Read the restored file back through a fresh connection — this is the
    // check that would have caught the silent-WAL-replay bug.
    const restored = await countRows(DB_PATH);
    console.log('\nContenido restaurado (verificado leyendo bascula.db):');
    console.log(`  integrity_check: ${restored.integrity}`);
    console.log(formatCounts(restored.counts));

    const mismatched = COUNTED_TABLES.filter(table => restored.counts[table] !== snapshot.counts[table]);
    if (mismatched.length > 0 || restored.integrity !== 'ok') {
        console.error(
            `\nLA RESTAURACIÓN NO COINCIDE con el respaldo (${mismatched.join(', ') || 'integrity_check'}).\n` +
            'NO inicie el servidor. Revise que no queden archivos -wal/-shm en backend/.'
        );
        process.exitCode = 1;
        return;
    }

    console.log('\nRestauración verificada. Ya puede iniciar el servidor (pm2 start bascula-backend).');
}

main().catch(error => {
    console.error('Falló la restauración:', error);
    process.exitCode = 1;
});
