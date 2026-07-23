const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

// This function opens the connection and creates the tables if they are missing
async function initializeDB() {
    // 1. Open or create the database file named 'bascula.db'
    const db = await open({
        filename: path.join(__dirname, 'bascula.db'),
        driver: sqlite3.Database
    });

    console.log("Conectado a la base de datos SQLite.");

    // 2. Run the SQL blueprints we mapped out
    await db.exec(`
        CREATE TABLE IF NOT EXISTS camiones_en_patio (
            id TEXT PRIMARY KEY,
            cliente_id TEXT NOT NULL,
            placa TEXT,
            conductor TEXT,
            flete TEXT,
            peso_bruto REAL,
            peso_tara REAL,
            casual_snapshot TEXT
        );

        CREATE TABLE IF NOT EXISTS transacciones (
            id INTEGER PRIMARY KEY,
            fecha TEXT NOT NULL,
            hora TEXT NOT NULL,
            placa TEXT,
            conductor TEXT,
            cliente_nombre TEXT NOT NULL,
            peso_bruto REAL NOT NULL,
            peso_tara REAL NOT NULL,
            neto REAL NOT NULL,
            precio_aplicado REAL NOT NULL,
            total REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY,
            nombre TEXT NOT NULL,
            apellido TEXT,
            telefono TEXT,
            ubicacion TEXT,
            precio_flete_propio REAL NOT NULL,
            precio_flete_cliente REAL NOT NULL,
            unidad TEXT NOT NULL DEFAULT 'tonelada'
        );
    `);

    console.log("Tablas verificadas/creadas exitosamente.");

    return db;
}

module.exports = initializeDB;