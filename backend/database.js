const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function ensureColumn(db, table, column, definition) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (!columns.some(item => item.name === column)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

function formatLocalIsoDate(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function addLocalDays(date, days) {
    const copy = new Date(date);
    copy.setHours(12, 0, 0, 0);
    copy.setDate(copy.getDate() + days);
    return copy;
}

function getCurrentWeekRange() {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const mondayOffset = today.getDay() === 0 ? -6 : 1 - today.getDay();
    const monday = addLocalDays(today, mondayOffset);
    return {
        monday,
        start: formatLocalIsoDate(monday),
        end: formatLocalIsoDate(addLocalDays(monday, 6))
    };
}

async function migrateLegacyPayrollAttendance(db) {
    const workers = await db.all(`
        SELECT id, dias_trabajados, extras
        FROM planilla
        WHERE COALESCE(asistencia_migrada, 0) = 0
        ORDER BY id
    `);

    if (workers.length === 0) return;

    const week = getCurrentWeekRange();
    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const worker of workers) {
            const existing = await db.get(
                'SELECT COUNT(*) AS total FROM planilla_asistencia WHERE trabajador_id = ?',
                [worker.id]
            );

            if (Number(existing?.total || 0) === 0) {
                const days = Math.min(7, Math.max(0, Math.floor(Number(worker.dias_trabajados || 0))));
                for (let index = 0; index < days; index += 1) {
                    const fecha = formatLocalIsoDate(addLocalDays(week.monday, index));
                    await db.run(`
                        INSERT OR IGNORE INTO planilla_asistencia
                            (trabajador_id, fecha, trabajado, hora_inicio, hora_fin)
                        VALUES (?, ?, 1, '07:00', '16:00')
                    `, [worker.id, fecha]);
                }
            }

            const extras = Math.max(0, Number(worker.extras || 0));
            if (extras > 0) {
                await db.run(`
                    INSERT INTO planilla_periodos
                        (trabajador_id, fecha_inicio, fecha_fin, extras)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(trabajador_id, fecha_inicio, fecha_fin)
                    DO UPDATE SET extras = excluded.extras, updated_at = CURRENT_TIMESTAMP
                `, [worker.id, week.start, week.end, extras]);
            }

            await db.run(
                'UPDATE planilla SET asistencia_migrada = 1 WHERE id = ?',
                [worker.id]
            );
        }

        await db.exec('COMMIT');
        console.log(`Planilla: ${workers.length} trabajador(es) migrados al control diario.`);
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
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
            precio_tonelada_propio REAL,
            precio_tonelada_cliente REAL,
            precio_tonelada_directo REAL,
            categoria TEXT NOT NULL DEFAULT 'ambos',
            unidad TEXT NOT NULL DEFAULT 'tonelada',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
            telefono TEXT NOT NULL DEFAULT '',
            destino TEXT NOT NULL DEFAULT 'CORAPSA',
            a_nombre_de TEXT NOT NULL DEFAULT '',
            toneladas REAL NOT NULL,
            precio REAL NOT NULL,
            total REAL NOT NULL,
            file_name TEXT NOT NULL DEFAULT 'Sin Archivo',
            file_mime_type TEXT NOT NULL DEFAULT '',
            file_data BLOB,
            file_nuestro TEXT NOT NULL DEFAULT 'Sin Archivo',
            file_nuestro_mime_type TEXT NOT NULL DEFAULT '',
            file_nuestro_data BLOB,
            pagado INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );



        CREATE TABLE IF NOT EXISTS corapsa_pagos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha_pago TEXT NOT NULL,
            periodo_inicio TEXT NOT NULL,
            periodo_fin TEXT NOT NULL,
            referencia TEXT NOT NULL DEFAULT '',
            destino TEXT NOT NULL DEFAULT 'CORAPSA',
            toneladas REAL NOT NULL,
            monto REAL NOT NULL,
            notas TEXT NOT NULL DEFAULT '',
            file_name TEXT NOT NULL DEFAULT 'Sin Archivo',
            file_mime_type TEXT NOT NULL DEFAULT '',
            file_data BLOB,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS gastos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TEXT NOT NULL,
            monto REAL NOT NULL,
            concepto TEXT NOT NULL,
            justificacion TEXT NOT NULL DEFAULT '',
            notas TEXT NOT NULL DEFAULT '',
            file_name TEXT NOT NULL DEFAULT 'Sin Archivo',
            file_mime_type TEXT NOT NULL DEFAULT '',
            file_data BLOB,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS planilla (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            apellido TEXT NOT NULL,
            telefono TEXT NOT NULL DEFAULT '',
            sueldo_base REAL NOT NULL,
            dias_trabajados REAL NOT NULL DEFAULT 0,
            extras REAL NOT NULL DEFAULT 0,
            asistencia_migrada INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS planilla_asistencia (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trabajador_id INTEGER NOT NULL,
            fecha TEXT NOT NULL,
            trabajado INTEGER NOT NULL DEFAULT 1,
            hora_inicio TEXT NOT NULL DEFAULT '07:00',
            hora_fin TEXT NOT NULL DEFAULT '16:00',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(trabajador_id, fecha),
            FOREIGN KEY (trabajador_id) REFERENCES planilla(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS planilla_periodos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trabajador_id INTEGER NOT NULL,
            fecha_inicio TEXT NOT NULL,
            fecha_fin TEXT NOT NULL,
            extras REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(trabajador_id, fecha_inicio, fecha_fin),
            FOREIGN KEY (trabajador_id) REFERENCES planilla(id) ON DELETE CASCADE
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
        CREATE INDEX IF NOT EXISTS idx_corapsa_pagos_periodo ON corapsa_pagos(periodo_inicio, periodo_fin);
        CREATE INDEX IF NOT EXISTS idx_corapsa_pagos_fecha_pago ON corapsa_pagos(fecha_pago);
        CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
        CREATE INDEX IF NOT EXISTS idx_planilla_asistencia_fecha ON planilla_asistencia(fecha);
        CREATE INDEX IF NOT EXISTS idx_planilla_asistencia_trabajador ON planilla_asistencia(trabajador_id);
        CREATE INDEX IF NOT EXISTS idx_planilla_periodos_rango ON planilla_periodos(fecha_inicio, fecha_fin);
    `);

    // Seeds the destino companies that used to be a hardcoded enum, so existing
    // installs keep working once "destino" is validated against this table.
    await db.exec(`
        INSERT OR IGNORE INTO companies (nombre) VALUES ('CORAPSA'), ('AGROTOR'), ('DINANT');
    `);

    // Compatible migrations for databases created by earlier project versions.
    await ensureColumn(db, 'clientes', 'unidad', "TEXT NOT NULL DEFAULT 'tonelada'");
    await ensureColumn(db, 'clientes', 'precio_tonelada_propio', 'REAL');
    await ensureColumn(db, 'clientes', 'precio_tonelada_cliente', 'REAL');
    // Base price for Compra Directo (Recibos Externos) purchases, adjusted
    // independently from the Acopio (weigh-station) prices above. NULL means
    // "not set yet" — getStoredDirectoPrice() falls back to the Propio ton
    // price so existing clients keep today's autofill behavior until this is
    // adjusted for the first time.
    await ensureColumn(db, 'clientes', 'precio_tonelada_directo', 'REAL');
    // Whether the client is an Acopio (weigh-station) customer, a Directo
    // (direct-to-company) customer, or both. Existing clients default to
    // 'ambos' so ajuste-global keeps adjusting them exactly as it did before
    // this column existed, until someone recategorizes them explicitly.
    await ensureColumn(db, 'clientes', 'categoria', "TEXT NOT NULL DEFAULT 'ambos'");
    await ensureColumn(db, 'clientes', 'created_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(db, 'clientes', 'updated_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(db, 'clientes', 'identidad', "TEXT NOT NULL DEFAULT ''");

    await ensureColumn(db, 'camiones_en_patio', 'cliente_nombre_snapshot', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'camiones_en_patio', 'precio_aplicado', 'REAL NOT NULL DEFAULT 0');
    await ensureColumn(db, 'camiones_en_patio', 'unidad', "TEXT NOT NULL DEFAULT 'tonelada'");
    await ensureColumn(db, 'camiones_en_patio', 'casual_snapshot', 'TEXT');
    await ensureColumn(db, 'camiones_en_patio', 'created_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    // Captured when the truck joins the weigh-in queue, so the printed receipt
    // can show both Fecha Entrada and Fecha Salida (the latter is set at finalize).
    await ensureColumn(db, 'camiones_en_patio', 'fecha_entrada', 'TEXT');
    await ensureColumn(db, 'camiones_en_patio', 'hora_entrada', 'TEXT');
    await ensureColumn(db, 'camiones_en_patio', 'identidad_snapshot', "TEXT NOT NULL DEFAULT ''");
    // Client-generated id carried by the offline-queue "create" op (see
    // offlineQueue.js). Lets POST /api/camiones-patio be safely retried: a
    // redelivery whose first attempt actually succeeded server-side (client
    // timed out waiting for the response) finds its own row by this key
    // instead of inserting a duplicate truck.
    await ensureColumn(db, 'camiones_en_patio', 'client_op_id', 'TEXT');
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_camiones_en_patio_client_op_id ON camiones_en_patio(client_op_id) WHERE client_op_id IS NOT NULL;');

    await ensureColumn(db, 'transacciones', 'unidad', "TEXT NOT NULL DEFAULT 'tonelada'");
    await ensureColumn(db, 'transacciones', 'created_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(db, 'transacciones', 'fecha_entrada', 'TEXT');
    await ensureColumn(db, 'transacciones', 'hora_entrada', 'TEXT');
    await ensureColumn(db, 'transacciones', 'identidad', "TEXT NOT NULL DEFAULT ''");
    // Printed ticket number, independent of the internal auto-increment id so it
    // can be corrected/seeded to match a physical ticket book if needed.
    await ensureColumn(db, 'transacciones', 'numero_boleta', 'INTEGER');
    // Client-generated id carried by the offline-queue "finalize" op (see
    // offlineQueue.js). Lets /finalizar be safely retried: a redelivery whose
    // first attempt actually succeeded server-side (client timed out waiting
    // for the response) finds its own transaction by this key instead of
    // re-inserting or 404ing on the already-deleted patio row.
    await ensureColumn(db, 'transacciones', 'client_op_id', 'TEXT');
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transacciones_client_op_id ON transacciones(client_op_id) WHERE client_op_id IS NOT NULL;');

    await ensureColumn(db, 'corapsa', 'telefono', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'corapsa', 'destino', "TEXT NOT NULL DEFAULT 'CORAPSA'");
    await ensureColumn(db, 'corapsa', 'a_nombre_de', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'corapsa', 'file_mime_type', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'corapsa', 'file_data', 'BLOB');
    await ensureColumn(db, 'corapsa', 'file_key', 'TEXT');
    await ensureColumn(db, 'corapsa', 'file_nuestro', "TEXT NOT NULL DEFAULT 'Sin Archivo'");
    await ensureColumn(db, 'corapsa', 'file_nuestro_mime_type', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'corapsa', 'file_nuestro_data', 'BLOB');
    await ensureColumn(db, 'corapsa', 'file_nuestro_key', 'TEXT');
    await ensureColumn(db, 'corapsa', 'pagado', 'INTEGER NOT NULL DEFAULT 0');
    // True when the receipt is paperwork for fruit already weighed/paid at our
    // own Acopio scale (transacciones). Excluded from Compra Directo in the
    // Overview so it isn't counted twice toward Compra Total de Palma.
    await ensureColumn(db, 'corapsa', 'es_producto_propio', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, 'corapsa', 'created_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(db, 'corapsa', 'updated_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");

    await ensureColumn(db, 'corapsa_pagos', 'referencia', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'corapsa_pagos', 'destino', "TEXT NOT NULL DEFAULT 'CORAPSA'");
    await ensureColumn(db, 'corapsa_pagos', 'notas', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'corapsa_pagos', 'file_name', "TEXT NOT NULL DEFAULT 'Sin Archivo'");
    await ensureColumn(db, 'corapsa_pagos', 'file_mime_type', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'corapsa_pagos', 'file_data', 'BLOB');
    await ensureColumn(db, 'corapsa_pagos', 'file_key', 'TEXT');
    await ensureColumn(db, 'corapsa_pagos', 'created_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(db, 'corapsa_pagos', 'updated_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");

    await ensureColumn(db, 'gastos', 'file_mime_type', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(db, 'gastos', 'file_data', 'BLOB');
    await ensureColumn(db, 'gastos', 'file_key', 'TEXT');
    // Persistent, user-editable notes about the expense — separate from
    // "justificacion", which is only ever a one-time reason for an edit and
    // gets blanked in the UI every time the modal opens (see corapsa_pagos.notas).
    const hadNotasColumn = (await db.all("PRAGMA table_info(gastos)")).some(column => column.name === 'notas');
    await ensureColumn(db, 'gastos', 'notas', "TEXT NOT NULL DEFAULT ''");
    if (!hadNotasColumn) {
        // One-time backfill: before "notas" existed, "justificacion" doubled as
        // the gasto's free-text notes, so carry over whatever was already there
        // instead of letting it disappear from the renamed "Notas" column.
        await db.run("UPDATE gastos SET notas = justificacion WHERE notas = '' AND justificacion != ''");
    }
    await ensureColumn(db, 'gastos', 'created_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(db, 'gastos', 'updated_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");

    await ensureColumn(db, 'planilla', 'asistencia_migrada', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, 'planilla', 'created_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    await ensureColumn(db, 'planilla', 'updated_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");

    // Each backfill below is scoped with a WHERE clause so it only rewrites rows
    // that still need repair — after the first run on a given database, these
    // become no-op scans instead of a full-table rewrite on every server start.
    await db.exec(`
        UPDATE clientes
        SET precio_tonelada_propio = COALESCE(
                precio_tonelada_propio,
                CASE
                    WHEN unidad = 'quintal' THEN ROUND(precio_flete_propio * 22.04, 2)
                    ELSE precio_flete_propio
                END
            ),
            precio_tonelada_cliente = COALESCE(
                precio_tonelada_cliente,
                CASE
                    WHEN unidad = 'quintal' THEN ROUND(precio_flete_cliente * 22.04, 2)
                    ELSE precio_flete_cliente
                END
            ),
            created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), CURRENT_TIMESTAMP)
        WHERE precio_tonelada_propio IS NULL
           OR precio_tonelada_cliente IS NULL
           OR created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = '';

        UPDATE camiones_en_patio
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP)
        WHERE created_at IS NULL OR TRIM(created_at) = '';

        UPDATE transacciones
        SET created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP)
        WHERE created_at IS NULL OR TRIM(created_at) = '';

        UPDATE corapsa
        SET file_name = COALESCE(NULLIF(TRIM(file_name), ''), 'Sin Archivo'),
            file_mime_type = COALESCE(file_mime_type, ''),
            file_nuestro = COALESCE(NULLIF(TRIM(file_nuestro), ''), 'Sin Archivo'),
            file_nuestro_mime_type = COALESCE(file_nuestro_mime_type, ''),
            created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), CURRENT_TIMESTAMP)
        WHERE file_name IS NULL OR TRIM(file_name) = ''
           OR file_mime_type IS NULL
           OR file_nuestro IS NULL OR TRIM(file_nuestro) = ''
           OR file_nuestro_mime_type IS NULL
           OR created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = '';

        UPDATE corapsa_pagos
        SET referencia = COALESCE(referencia, ''),
            notas = COALESCE(notas, ''),
            file_name = COALESCE(NULLIF(TRIM(file_name), ''), 'Sin Archivo'),
            file_mime_type = COALESCE(file_mime_type, ''),
            created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), CURRENT_TIMESTAMP)
        WHERE referencia IS NULL
           OR notas IS NULL
           OR file_name IS NULL OR TRIM(file_name) = ''
           OR file_mime_type IS NULL
           OR created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = '';

        UPDATE gastos
        SET file_name = COALESCE(NULLIF(TRIM(file_name), ''), 'Sin Archivo'),
            file_mime_type = COALESCE(file_mime_type, ''),
            created_at = COALESCE(NULLIF(TRIM(created_at), ''), CURRENT_TIMESTAMP),
            updated_at = COALESCE(NULLIF(TRIM(updated_at), ''), CURRENT_TIMESTAMP)
        WHERE file_name IS NULL OR TRIM(file_name) = ''
           OR file_mime_type IS NULL
           OR created_at IS NULL OR TRIM(created_at) = ''
           OR updated_at IS NULL OR TRIM(updated_at) = '';
    `);

    await repairLegacyQueueIds(db);
    await migrateLegacyPayrollAttendance(db);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_camiones_created_at ON camiones_en_patio(created_at);');

    // numero_boleta is scanned via MAX() on every truck finalize (the busiest
    // write path) and can be hand-edited to an arbitrary value via PUT
    // /api/transacciones/:id, so it needs both an index and, ideally, a
    // uniqueness guarantee. The UNIQUE index is attempted first; if manual
    // edits already left duplicates on this database it falls back to a
    // plain index instead of blocking startup, and self-heals to unique the
    // next time the server starts after the duplicates are cleaned up.
    try {
        await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_transacciones_numero_boleta ON transacciones(numero_boleta) WHERE numero_boleta IS NOT NULL;');
    } catch (error) {
        console.warn(`No se pudo crear un índice único para numero_boleta (probablemente ya existen boletas duplicadas): ${error.message}`);
        await db.exec('CREATE INDEX IF NOT EXISTS idx_transacciones_numero_boleta ON transacciones(numero_boleta);');
    }

    return db;
}

module.exports = initializeDB;