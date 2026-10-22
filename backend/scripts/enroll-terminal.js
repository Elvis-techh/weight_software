// Creates the credential for one weighing terminal and prints it ONCE; only
// its SHA-256 is stored. Enter it in that terminal under Configuración de
// Báscula → Token de la terminal. Safe to run while the server is up (WAL +
// busy_timeout). The server creates the terminales table on start, so run the
// new server once before the first enrollment.
//
// Usage, from backend/:
//   node scripts/enroll-terminal.js "Báscula principal"
//   node scripts/enroll-terminal.js --listar
//   node scripts/enroll-terminal.js --revocar 3
// With BASCULA_SANDBOX=1 it works on the sandbox database instead.
//
// Revoking takes effect within a minute (the server caches valid tokens for
// that long). Once any terminal is enrolled, a request with neither a valid
// token nor the old API_KEY is refused — revoking every terminal never turns
// auth back off.

const crypto = require('crypto');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { DB_PATH } = require('../database');

async function main() {
    const [first, second] = process.argv.slice(2);
    if (!fs.existsSync(DB_PATH)) throw new Error(`No existe la base de datos ${DB_PATH}.`);

    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout = 5000;');
    try {
        const table = await db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'terminales'");
        if (!table) throw new Error('La tabla terminales no existe todavía: inicie una vez el servidor actualizado.');

        if (first === '--listar') {
            console.table(await db.all('SELECT id, nombre, creado_en, revocado_en FROM terminales ORDER BY id'));
            return;
        }
        if (first === '--revocar') {
            const result = await db.run(
                "UPDATE terminales SET revocado_en = datetime('now') WHERE id = ? AND revocado_en IS NULL",
                [Number(second)]
            );
            console.log(result.changes ? `Terminal ${second} revocada.` : 'No hay una terminal activa con ese id.');
            return;
        }

        const nombre = String(first || '').trim();
        if (!nombre || nombre.startsWith('--')) {
            throw new Error('Indique el nombre de la terminal, por ejemplo: node scripts/enroll-terminal.js "Báscula principal"');
        }

        const token = crypto.randomBytes(32).toString('base64url');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const { lastID } = await db.run('INSERT INTO terminales (nombre, token_hash) VALUES (?, ?)', [nombre, hash]);
        console.log(`Terminal #${lastID} "${nombre}" creada. Token (no se volverá a mostrar):\n\n${token}\n`);
    } finally {
        await db.close();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
