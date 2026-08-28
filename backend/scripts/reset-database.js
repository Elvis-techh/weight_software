// One-time cleanup: wipes all test data before going live, keeping the
// schema and the "companies" (destino) config table intact.
//
// Deletes everything from: clientes, camiones_en_patio, transacciones,
// corapsa, corapsa_pagos, gastos, planilla, planilla_asistencia,
// planilla_periodos, auditoria. Does NOT touch "companies" (CORAPSA/AGROTOR/
// DINANT are real destino names, not test data).
//
// Takes an automatic backup first (see backup-database.js) so this is
// recoverable if run by mistake, and best-effort deletes any test
// attachments already uploaded to Spaces so they don't linger as orphans.
//
// Usage (on the droplet, backend/ as the working directory):
//   node scripts/reset-database.js --confirm
// Stop the server (pm2 stop <app-name>) first — this writes directly to
// bascula.db outside the app's write-queue/API-key gates.

const path = require('path');
// Before ../storage — see the same note in backup-database.js. It matters more
// here: without it, the safety backup this script takes before wiping every
// table would only ever land on the same disk it is about to wipe.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const storage = require('../storage');
const { runBackup } = require('./backup-database');

const DB_PATH = path.join(__dirname, '..', 'bascula.db');

// Order matters: children before parents, even though the FK columns are
// declared ON DELETE CASCADE — explicit beats implicit for a destructive
// script like this.
const TABLES_TO_WIPE = [
    'camiones_en_patio',
    'transacciones',
    'corapsa',
    'corapsa_pagos',
    'gastos',
    'planilla_asistencia',
    'planilla_periodos',
    'planilla',
    'clientes',
    'auditoria'
];

const ATTACHMENT_KEY_COLUMNS = [
    { table: 'corapsa', columns: ['file_key', 'file_nuestro_key'] },
    { table: 'corapsa_pagos', columns: ['file_key'] },
    { table: 'gastos', columns: ['file_key'] }
];

async function collectAttachmentKeys(db) {
    const keys = [];
    for (const { table, columns } of ATTACHMENT_KEY_COLUMNS) {
        const rows = await db.all(`SELECT ${columns.join(', ')} FROM ${table}`);
        for (const row of rows) {
            for (const column of columns) {
                if (row[column]) keys.push(row[column]);
            }
        }
    }
    return keys;
}

async function main() {
    if (!process.argv.includes('--confirm')) {
        console.error(
            'Esto borra TODOS los clientes, transacciones, recibos externos, gastos, planilla y auditoría ' +
            '(deja intacta la tabla "companies"). Vuelva a correr con --confirm para proceder.\n' +
            'Ejemplo: node scripts/reset-database.js --confirm'
        );
        process.exitCode = 1;
        return;
    }

    // Fail closed rather than printing a warning nobody reads in the middle of
    // a wall of delete counts: without Spaces, the "safety backup" below lands
    // only on the disk this script is about to wipe, which is not a backup at
    // all if the reason for restoring is that the droplet is gone.
    if (!storage.isConfigured() && !process.argv.includes('--allow-local-only-backup')) {
        console.error(
            'SPACES_* no está configurado, así que el respaldo de seguridad quedaría ÚNICAMENTE en este disco.\n' +
            'Configure SPACES_* en backend/.env (ver .env.example) y vuelva a intentarlo, o acepte el riesgo\n' +
            'explícitamente: node scripts/reset-database.js --confirm --allow-local-only-backup'
        );
        process.exitCode = 1;
        return;
    }

    console.log('Creando respaldo de seguridad antes de borrar...');
    const backupPath = await runBackup();
    console.log(`Respaldo listo: ${backupPath}`);

    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    try {
        await db.exec('PRAGMA foreign_keys = ON;');

        const attachmentKeys = await collectAttachmentKeys(db);

        await db.exec('BEGIN IMMEDIATE');
        try {
            for (const table of TABLES_TO_WIPE) {
                const result = await db.run(`DELETE FROM ${table}`);
                console.log(`  ${table}: ${result.changes || 0} fila(s) borradas`);
            }
            await db.run(
                `DELETE FROM sqlite_sequence WHERE name IN (${TABLES_TO_WIPE.map(() => '?').join(', ')})`,
                TABLES_TO_WIPE
            );
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }

        await db.exec('VACUUM');

        if (attachmentKeys.length > 0) {
            if (storage.isConfigured()) {
                console.log(`Borrando ${attachmentKeys.length} adjunto(s) de prueba en Spaces...`);
                for (const key of attachmentKeys) await storage.deleteObject(key);
            } else {
                console.warn(
                    `ADVERTENCIA: SPACES_* no está configurado — ${attachmentKeys.length} adjunto(s) de prueba ` +
                    'quedaron huérfanos en el bucket y deben borrarse manualmente si aplica.'
                );
            }
        }
    } finally {
        await db.close();
    }

    console.log('Listo. La base de datos quedó limpia para producción (companies se conservó).');
}

main().catch(error => {
    console.error('Falló el borrado de datos de prueba:', error);
    process.exitCode = 1;
});
