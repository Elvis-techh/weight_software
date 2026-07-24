const express = require('express');
const cors = require('cors');
const initializeDB = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

let db;

// Initialize Database connection on startup
initializeDB().then(database => {
    db = database;
}).catch(err => {
    console.error("Error al inicializar SQLite:", err);
});

// 1. GET: Fetch all clients from SQLite
app.get('/api/clientes', async (req, res) => {
    try {
        const rows = await db.all('SELECT * FROM clientes');
        const clientes = rows.map(r => ({
            id: r.id,
            nombre: r.nombre,
            apellido: r.apellido,
            telefono: r.telefono,
            ubicacion: r.ubicacion,
            precioFletePropio: r.precio_flete_propio,
            precioFleteCliente: r.precio_flete_cliente,
            unidad: r.unidad // Send the unit back to the frontend
        }));
        res.json(clientes);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

// 2. POST: Insert a new client into SQLite
app.post('/api/clientes', async (req, res) => {
    try {
        const c = req.body;
        const id = c.id || Date.now();

        await db.run(`
            INSERT INTO clientes (id, nombre, apellido, telefono, ubicacion, precio_flete_propio, precio_flete_cliente, unidad)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            c.nombre,
            c.apellido || '',
            c.telefono || '',
            c.ubicacion || '',
            c.precioFletePropio,
            c.precioFleteCliente,
            c.unidad || 'tonelada'
        ]);

        const nuevoCliente = { ...c, id };
        res.status(201).json({ cliente: nuevoCliente });
    } catch (error) {
        console.error("Error al guardar cliente:", error);
        res.status(500).json({ error: { message: "Error al guardar el cliente en la base de datos." } });
    }
});

// 3. POST: Ajuste Global for all clients
app.post('/api/clientes/ajuste-global', async (req, res) => {
    try {
        const { monto } = req.body;

        if (typeof monto !== 'number') {
            return res.status(400).json({ error: { message: "Monto inválido para el ajuste global." } });
        }

        // Update both price columns for ALL clients in the database simultaneously
        await db.run(`
            UPDATE clientes 
            SET precio_flete_propio = precio_flete_propio + ?, 
                precio_flete_cliente = precio_flete_cliente + ?
        `, [monto, monto]);

        res.json({ message: "Ajuste global aplicado correctamente a todos los clientes." });
    } catch (error) {
        console.error("Error en ajuste global:", error);
        res.status(500).json({ error: { message: "Error al actualizar la base de datos." } });
    }
});

// 4. PUT: Update an existing client
app.put('/api/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const c = req.body;

        await db.run(`
            UPDATE clientes 
            SET nombre = ?, apellido = ?, telefono = ?, ubicacion = ?, precio_flete_propio = ?, precio_flete_cliente = ?, unidad = ?
            WHERE id = ?
        `, [c.nombre, c.apellido || '', c.telefono || '', c.ubicacion || '', c.precioFletePropio, c.precioFleteCliente, c.unidad, id]);

        // Send back the updated client
        res.json({ message: "Cliente actualizado", cliente: { ...c, id: Number(id) } });
    } catch (error) {
        console.error("Error al actualizar cliente:", error);
        res.status(500).json({ error: { message: "Error al actualizar la base de datos." } });
    }
});

// 5. DELETE: Remove a client
app.delete('/api/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.run('DELETE FROM clientes WHERE id = ?', [id]);
        res.json({ message: "Cliente eliminado correctamente." });
    } catch (error) {
        console.error("Error al eliminar cliente:", error);
        res.status(500).json({ error: { message: "Error al eliminar de la base de datos." } });
    }
});

// ----------------------------------------------

// 1. GET: Fetch all active trucks from SQLite
app.get('/api/camiones-patio', async (req, res) => {
    try {
        const rows = await db.all('SELECT * FROM camiones_en_patio');
        const camiones = rows.map(r => ({
            id: r.id,
            clienteId: r.cliente_id === 'casual' ? 'casual' : Number(r.cliente_id),
            placa: r.placa,
            conductor: r.conductor,
            flete: r.flete,
            pesoBruto: r.peso_bruto,
            pesoTara: r.peso_tara,
            casualSnapshot: r.casual_snapshot ? JSON.parse(r.casual_snapshot) : null
        }));
        res.json(camiones);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

// 2. POST: Insert a new truck into SQLite
app.post('/api/camiones-patio', async (req, res) => {
    try {
        const truck = req.body;
        const id = truck.id || Date.now().toString().slice(-6);
        const snapshotStr = truck.casualSnapshot ? JSON.stringify(truck.casualSnapshot) : null;

        await db.run(`
            INSERT INTO camiones_en_patio (id, cliente_id, placa, conductor, flete, peso_bruto, peso_tara, casual_snapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            String(truck.clienteId),
            truck.placa || "S/P",
            truck.conductor || "Desconocido",
            truck.flete || "Propio",
            truck.pesoBruto ?? null,
            truck.pesoTara ?? null,
            snapshotStr
        ]);

        const newTruck = { ...truck, id };
        // Removed ok: true so apiRequest returns this exact object
        res.status(201).json({ camion: newTruck });
    } catch (error) {
        console.error("Error al insertar en patio:", error);
        res.status(500).json({ error: { message: "Error al guardar en la base de datos." } });
    }
});

// 3. PATCH: Update a truck with its second weight
app.patch('/api/camiones-patio/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        if (updates.pesoBruto !== undefined) {
            await db.run('UPDATE camiones_en_patio SET peso_bruto = ? WHERE id = ?', [updates.pesoBruto, id]);
        }
        if (updates.pesoTara !== undefined) {
            await db.run('UPDATE camiones_en_patio SET peso_tara = ? WHERE id = ?', [updates.pesoTara, id]);
        }

        const row = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        if (!row) {
            return res.status(404).json({ error: { message: "Camión no encontrado en la cola." } });
        }

        res.json({
            id: row.id,
            clienteId: row.cliente_id === 'casual' ? 'casual' : Number(row.cliente_id),
            placa: row.placa,
            conductor: row.conductor,
            flete: row.flete,
            pesoBruto: row.peso_bruto,
            pesoTara: row.peso_tara,
            casualSnapshot: row.casual_snapshot ? JSON.parse(row.casual_snapshot) : null
        });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

// 4. POST (Finalizar): Move truck to permanent transacciones table
app.post('/api/camiones-patio/:id/finalizar', async (req, res) => {
    try {
        const { id } = req.params;
        const finalData = req.body;

        const truck = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        if (!truck) {
            return res.status(404).json({ error: { message: "Camión no encontrado para finalizar." } });
        }

        const neto = Math.abs(truck.peso_bruto - truck.peso_tara);
        const total = (neto / 1000) * finalData.precioAplicado;
        const transaccionId = Date.now();

        await db.run(`
            INSERT INTO transacciones (id, fecha, hora, placa, conductor, cliente_nombre, peso_bruto, peso_tara, neto, precio_aplicado, total)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            transaccionId,
            finalData.fecha,
            finalData.hora,
            truck.placa,
            truck.conductor,
            finalData.clienteNombre,
            truck.peso_bruto,
            truck.peso_tara,
            neto,
            finalData.precioAplicado,
            total
        ]);

        await db.run('DELETE FROM camiones_en_patio WHERE id = ?', [id]);

        const transaccion = {
            id: transaccionId,
            fecha: finalData.fecha,
            hora: finalData.hora,
            placa: truck.placa,
            conductor: truck.conductor,
            clienteNombre: finalData.clienteNombre,
            neto,
            precioAplicado: finalData.precioAplicado,
            total
        };

        res.json({ transaccion });
    } catch (error) {
        console.error("Error al finalizar transacción:", error);
        res.status(500).json({ error: { message: error.message } });
    }
});

// 5. DELETE: Remove truck from yard manually
app.delete('/api/camiones-patio/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.run('DELETE FROM camiones_en_patio WHERE id = ?', [id]);
        res.json({ message: "Vehículo eliminado exitosamente." });
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
});

// --- RUTAS DE REPORTES ---

// GET: Fetch all completed transactions for the Reportes tab
app.get('/api/transacciones', async (req, res) => {
    try {
        // Fetch everything, ordering by newest first
        const rows = await db.all('SELECT * FROM transacciones ORDER BY id DESC');
        res.json(rows);
    } catch (error) {
        console.error("Error al obtener transacciones:", error);
        res.status(500).json({ error: { message: "Error al leer la base de datos." } });
    }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor de Báscula Central corriendo en puerto ${PORT}`);
});