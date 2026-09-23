// Loads a copy of a real backup (or any bascula.db) into the sandbox that
// `npm run dev` uses, to test against realistic data. It only ever writes
// backend/sandbox/bascula-sandbox.db — never backend/bascula.db — so even run
// on the droplet by mistake it cannot touch the real database. Production →
// sandbox is safe; the other direction never is.
//
// Usage, with the sandbox (`npm run dev`) closed:
//   npm run sandbox:load-backup -- <archivo.db>        (from frontend/)
//   node scripts/sandbox-load-backup.js <archivo.db>   (from backend/)
// DESARROLLO.md explains how to copy a snapshot down from the droplet.

const fs = require('fs');
const net = require('net');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const SANDBOX_DIR = path.join(__dirname, '..', 'sandbox');
const SANDBOX_DB = path.join(SANDBOX_DIR, 'bascula-sandbox.db');
// The load being replaced, kept once so picking the wrong file can be undone.
const PREVIOUS_DB = path.join(SANDBOX_DIR, 'bascula-sandbox.anterior.db');
const STAGING_DB = path.join(SANDBOX_DIR, 'bascula-sandbox.cargando.db');
// The port in SANDBOX_API_URL (frontend/environment.js).
const SANDBOX_PORT = 3100;

// The same tables restore-database.js reports.
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

const withSidecars = file => [file, `${file}-wal`, `${file}-shm`];

async function inspect(filename, mode) {
    const db = await open({ filename, driver: sqlite3.Database, mode });
    try {
        const check = await db.get('PRAGMA integrity_check');
        const counts = {};
        for (const table of COUNTED_TABLES) {
            // An older snapshot may legitimately lack a table.
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

function sandboxIsRunning() {
    return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port: SANDBOX_PORT });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

async function removeWithSidecars(file) {
    for (const part of withSidecars(file)) await fs.promises.rm(part, { force: true });
}

// A database's -wal/-shm belong to it, so they move with it or not at all.
async function moveWithSidecars(from, to) {
    const targets = withSidecars(to);
    for (const [index, part] of withSidecars(from).entries()) {
        await fs.promises.rename(part, targets[index]).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
}

async function main() {
    const arg = process.argv.slice(2).find(value => !value.startsWith('--'));
    if (!arg) {
        console.error(
            'Indique el archivo .db a cargar en el sandbox.\n' +
            'Ejemplo: npm run sandbox:load-backup -- ~/Descargas/bascula-2026-09-23T01-00-00-000Z.db'
        );
        process.exitCode = 1;
        return;
    }

    // npm runs scripts from the package folder; INIT_CWD is where the command
    // was typed, which is what a relative path means to the person typing it.
    const source = path.resolve(process.env.INIT_CWD || process.cwd(), arg);
    if (!fs.existsSync(source)) {
        console.error(`No se encontró el archivo: ${source}`);
        process.exitCode = 1;
        return;
    }
    if (withSidecars(SANDBOX_DB).concat(withSidecars(PREVIOUS_DB)).includes(source)) {
        console.error('Ese archivo ya es parte del sandbox. Indique un respaldo o una base distinta.');
        process.exitCode = 1;
        return;
    }
    if (await sandboxIsRunning()) {
        console.error('El sandbox está abierto (npm run dev). Ciérrelo antes de cargar otra base.');
        process.exitCode = 1;
        return;
    }

    // Read the source before touching anything, so a corrupt or truncated file
    // is caught while the current sandbox is still intact.
    console.log(`Verificando: ${source}`);
    let original;
    try {
        original = await inspect(source, sqlite3.OPEN_READONLY);
    } catch (error) {
        console.error(`No se pudo abrir como base de datos SQLite: ${error.message}`);
        process.exitCode = 1;
        return;
    }
    if (original.integrity !== 'ok') {
        console.error(`El archivo no pasó integrity_check (${original.integrity}). No se cargó nada.`);
        process.exitCode = 1;
        return;
    }
    console.log('  integrity_check: ok');
    console.log(formatCounts(original.counts));

    // VACUUM INTO rather than a file copy: it reads through SQLite, so it also
    // takes the writes still sitting in a live database's -wal file (the old
    // backend/bascula.db, say), and it leaves the source untouched.
    await fs.promises.mkdir(SANDBOX_DIR, { recursive: true });
    await removeWithSidecars(STAGING_DB);
    const reader = await open({ filename: source, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        await reader.run('VACUUM INTO ?', STAGING_DB);
    } finally {
        await reader.close();
    }

    await removeWithSidecars(PREVIOUS_DB);
    await moveWithSidecars(SANDBOX_DB, PREVIOUS_DB);
    await fs.promises.rename(STAGING_DB, SANDBOX_DB);

    const loaded = await inspect(SANDBOX_DB);
    const mismatched = COUNTED_TABLES.filter(table => loaded.counts[table] !== original.counts[table]);
    if (mismatched.length > 0 || loaded.integrity !== 'ok') {
        console.error(
            `\nLa copia NO coincide con el original (${mismatched.join(', ') || 'integrity_check'}). ` +
            'No abra el sandbox; vuelva a intentarlo.'
        );
        process.exitCode = 1;
        return;
    }

    console.log(`\nCargado en ${SANDBOX_DB} y verificado.`);
    if (fs.existsSync(PREVIOUS_DB)) console.log(`La carga anterior quedó en ${PREVIOUS_DB}.`);
    console.log(
        '\nLa próxima vez que abra el sandbox (npm run dev) usará estos datos.\n' +
        '- Si vienen de producción son datos reales: se quedan en esta computadora (backend/sandbox/ no se sube a git).\n' +
        '- Los adjuntos (fotos/PDF) de producción viven en Spaces y no se abren en el sandbox.'
    );
}

main().catch(error => {
    console.error('Falló la carga:', error);
    process.exitCode = 1;
});
