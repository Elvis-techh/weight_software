const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function ensureColumn(db, table, column, definition) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (!columns.some(item => item.name === column)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

async function repairLegacyQueueIds(db) {
    const columns = await db.all('PRAGMA table_info(camiones_en_patio)');
    const idColumn = columns.find(column => column.name === 'id');

    if (!idColumn) {
        throw new Error('La tabla camiones_en_patio no contiene la columna id.');
    }

    const legacyTextId = String(idColumn.type || '').toUpperCase() !== 'INTEGER';
    if (!legacyTextId) return;

    const invalidRows = await db.all(`
        SELECT rowid AS internalRowId
        FROM camiones_en_patio
        WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''
        ORDER BY rowid
    `);

    if (invalidRows.length === 0) return;

    console.warn(`Reparando ${invalidRows.length} registro(s) antiguos de camiones_en_patio sin ID.`);

    for (const row of invalidRows) {
        const baseId = `legacy-${row.internalRowId}`;
        let candidate = baseId;
        let suffix = 1;

        while (await db.get('SELECT 1 FROM camiones_en_patio WHERE id = ?', [candidate])) {
            candidate = `${baseId}-${suffix}`;
            suffix += 1;
        }

        await db.run(
            'UPDATE camiones_en_patio SET id = ? WHERE rowid = ?',
            [candidate, row.internalRowId]
        );
    }
}

async function initializeDB() {
    const db = await open({
        filename: path.join(__dirname, 'bascula.db'),
        driver: sqlite3.Database
    });

    await db.exec('PRAGMA foreign_keys = ON;');
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA busy_timeout = 5000;');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            apellido TEXT NOT NULL DEFAULT '',
            telefono TEXT NOT NULL DEFAULT '',
            ubicacion TEXT NOT NULL DEFAULT '',
            precio_flete_propio REAL NOT NULL DEFAULT 0,
            precio_flete_cliente REAL NOT NULL DEFAULT 0,
            unidad TEXT NOT NULL DEFAULT 'tonelada',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS camiones_en_patio (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_id TEXT NOT NULL,
            cliente_nombre_snapshot TEXT NOT NULL DEFAULT '',
            placa TEXT NOT NULL DEFAULT 'S/P',
            conductor TEXT NOT NULL DEFAULT 'Desconocido',
            flete TEXT NOT NULL DEFAULT 'Propio',
            peso_bruto REAL,
            peso_tara REAL,
            precio_aplicado REAL NOT NULL DEFAULT 0,
            unidad TEXT NOT NULL DEFAULT 'tonelada',
            casual_snapshot TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS transacciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TEXT NOT NULL,
            hora TEXT NOT NULL,
            placa TEXT NOT NULL DEFAULT 'S/P',
            conductor TEXT NOT NULL DEFAULT 'Desconocido',
            cliente_nombre TEXT NOT NULL,
            peso_bruto REAL NOT NULL,
            peso_tara REAL NOT NULL,
            neto REAL NOT NULL,
            precio_aplicado REAL NOT NULL,
            total REAL NOT NULL,
            unidad TEXT NOT NULL DEFAULT 'tonelada',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS corapsa (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TEXT NOT NULL,
            recibo_in TEXT NOT NULL,
            recibo_out TEXT NOT NULL DEFAULT '',
            cliente TEXT NOT NULL,
            toneladas REAL NOT NULL,
            precio REAL NOT NULL,
            total REAL NOT NULL,
            file_name TEXT NOT NULL DEFAULT 'Sin Archivo',
            file_nuestro TEXT NOT NULL DEFAULT 'Sin Archivo',
            pagado INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS gastos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TEXT NOT NULL,
            monto REAL NOT NULL,
            concepto TEXT NOT NULL,
            justificacion TEXT NOT NULL DEFAULT '',
            file_name TEXT NOT NULL DEFAULT 'Sin Archivo',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS planilla (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            apellido TEXT NOT NULL,
            telefono TEXT NOT NULL DEFAULT '',
            sueldo_base REAL NOT NULL,
            dias_trabajados REAL NOT NULL DEFAULT 6,
            extras REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS auditoria (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entidad TEXT NOT NULL,
            entidad_id TEXT,
            accion TEXT NOT NULL,
            justificacion TEXT NOT NULL DEFAULT '',
            detalles TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_transacciones_fecha ON transacciones(fecha);
        CREATE INDEX IF NOT EXISTS idx_corapsa_fecha ON corapsa(fecha);
        CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
    `);

    // Compatible migrations for databases created by earlier project versions.
    await ensureColumn(db, 'clientes', 'unidad', "TEXT NOT NULL DEFAULT 'tonelada'");
    await ensureColumn(db, 'clientes', 'created_at', 'TEXT');
    await ensureColumn(db, 'clientes', 'updated_at', 'TEXT');

    await ensureColumn(db, 'camiones_en_patio', 'cliente_nombre_snapshot', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'camiones_en_patio', 'precio_aplicado', 'REAL NOT NULL DEFAULT 0');
    await ensureColumn(db, 'camiones_en_patio', 'unidad', "TEXT NOT NULL DEFAULT 'tonelada'");
    await ensureColumn(db, 'camiones_en_patio', 'casual_snapshot', 'TEXT');
    await ensureColumn(db, 'camiones_en_patio', 'created_at', 'TEXT');

    await ensureColumn(db, 'transacciones', 'unidad', "TEXT NOT NULL DEFAULT 'tonelada'");
    await ensureColumn(db, 'transacciones', 'created_at', 'TEXT');

    await db.exec(`
        UPDATE clientes
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), CURRENT_TIMESTAMP);

        UPDATE camiones_en_patio
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP);

        UPDATE transacciones
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP);
    `);

    await repairLegacyQueueIds(db);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_camiones_created_at ON camiones_en_patio(created_at);');

    return db;
}

module.exports = initializeDB;