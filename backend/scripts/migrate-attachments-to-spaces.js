// One-time migration: uploads existing SQLite BLOB attachments to DigitalOcean
// Spaces and clears the BLOB column, freeing up disk space on the droplet.
// Safe to re-run — only touches rows that still have file_data but no file_key.
//
// Usage (on the droplet, with SPACES_* env vars set):
//   node backend/scripts/migrate-attachments-to-spaces.js
//
// Run a database backup first (a plain `cp` can catch the WAL file mid-write):
//   node backend/scripts/backup-database.js

const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const storage = require('../storage');

const TARGETS = [
    { table: 'corapsa', folder: 'corapsa-cliente', nameCol: 'file_name', mimeCol: 'file_mime_type', dataCol: 'file_data', keyCol: 'file_key' },
    { table: 'corapsa', folder: 'corapsa-nuestro', nameCol: 'file_nuestro', mimeCol: 'file_nuestro_mime_type', dataCol: 'file_nuestro_data', keyCol: 'file_nuestro_key' },
    { table: 'corapsa_pagos', folder: 'corapsa-pagos', nameCol: 'file_name', mimeCol: 'file_mime_type', dataCol: 'file_data', keyCol: 'file_key' },
    { table: 'gastos', folder: 'gastos', nameCol: 'file_name', mimeCol: 'file_mime_type', dataCol: 'file_data', keyCol: 'file_key' }
];

async function migrateTarget(db, target) {
    const { table, folder, nameCol, mimeCol, dataCol, keyCol } = target;
    const rows = await db.all(`
        SELECT id, ${nameCol} AS fileName, ${mimeCol} AS mimeType, ${dataCol} AS data
        FROM ${table}
        WHERE ${keyCol} IS NULL AND LENGTH(${dataCol}) > 0
    `);

    console.log(`${table}.${dataCol}: ${rows.length} attachment(s) to migrate`);

    let migrated = 0;
    for (const row of rows) {
        try {
            const key = await storage.uploadObject(folder, row.data, row.fileName, row.mimeType);
            await db.run(`UPDATE ${table} SET ${keyCol} = ?, ${dataCol} = NULL WHERE id = ?`, [key, row.id]);
            migrated += 1;
        } catch (error) {
            console.error(`  FAILED ${table}#${row.id} (${row.fileName}):`, error.message);
        }
    }
    console.log(`${table}.${dataCol}: migrated ${migrated}/${rows.length}`);
}

async function main() {
    if (!storage.isConfigured()) {
        console.error('SPACES_KEY / SPACES_SECRET / SPACES_BUCKET / SPACES_REGION / SPACES_ENDPOINT must all be set.');
        process.exitCode = 1;
        return;
    }

    const db = await open({
        filename: path.join(__dirname, '..', 'bascula.db'),
        driver: sqlite3.Database
    });

    try {
        for (const target of TARGETS) {
            await migrateTarget(db, target);
        }
        await db.exec('VACUUM;');
        console.log('Done. Ran VACUUM to reclaim disk space freed by cleared BLOBs.');
    } finally {
        await db.close();
    }
}

main().catch(error => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
});
