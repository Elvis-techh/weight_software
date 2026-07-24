const express = require('express');
const cors = require('cors');
const initializeDB = require('./database');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const VALID_UNITS = new Set(['tonelada', 'quintal']);
const VALID_FREIGHT_TYPES = new Set(['Propio', 'Cliente']);
const LBS_PER_METRIC_TON = 2204.62262185;
const LBS_PER_QUINTAL = 100;

let db;
let server;
let writeQueue = Promise.resolve();
let queueIdSequence = 0;

class HttpError extends Error {
    constructor(status, message, code = 'REQUEST_ERROR', details = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function asyncHandler(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendData(res, data, status = 200) {
    res.status(status).json({ ok: true, data });
}

function serializeDatabaseAccess(req, res, next) {
    if (req.method === 'OPTIONS') return next();

    const previous = writeQueue;
    let release;
    writeQueue = new Promise(resolve => { release = resolve; });

    previous.finally(() => {
        let released = false;
        const unlock = () => {
            if (released) return;
            released = true;
            release();
        };

        res.once('finish', unlock);
        res.once('close', unlock);
        next();
    });
}


function asText(value, { required = false, field = 'campo', maxLength = 250 } = {}) {
    const text = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (required && !text) throw new HttpError(400, `${field} es obligatorio.`, 'VALIDATION_ERROR');
    if (text.length > maxLength) throw new HttpError(400, `${field} excede ${maxLength} caracteres.`, 'VALIDATION_ERROR');
    return text;
}

function asNumber(value, { required = false, min = -Infinity, field = 'valor' } = {}) {
    if ((value === null || value === undefined || value === '') && !required) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new HttpError(400, `${field} no es válido.`, 'VALIDATION_ERROR');
    if (number < min) throw new HttpError(400, `${field} debe ser mayor o igual que ${min}.`, 'VALIDATION_ERROR');
    return number;
}

function asUnit(value) {
    const unit = String(value || 'tonelada');
    if (!VALID_UNITS.has(unit)) throw new HttpError(400, 'Unidad de medida inválida.', 'VALIDATION_ERROR');
    return unit;
}

function asFreightType(value) {
    const type = String(value || 'Propio');
    if (!VALID_FREIGHT_TYPES.has(type)) throw new HttpError(400, 'Tipo de flete inválido.', 'VALIDATION_ERROR');
    return type;
}

function requireJustification(body) {
    return asText(body?.justificacion ?? body?.razon, {
        required: true,
        field: 'La justificación',
        maxLength: 500
    });
}

function safeJsonParse(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
}

function mapClient(row) {
    return {
        id: row.id,
        nombre: row.nombre,
        apellido: row.apellido || '',
        telefono: row.telefono || '',
        ubicacion: row.ubicacion || '',
        precioFletePropio: Number(row.precio_flete_propio || 0),
        precioFleteCliente: Number(row.precio_flete_cliente || 0),
        unidad: row.unidad === 'quintal' ? 'quintal' : 'tonelada'
    };
}

function mapTruck(row) {
    return {
        id: row.id,
        clienteId: row.cliente_id === 'casual' ? 'casual' : Number(row.cliente_id),
        clienteNombreSnapshot: row.cliente_nombre_snapshot || '',
        placa: row.placa,
        conductor: row.conductor,
        flete: row.flete,
        pesoBruto: row.peso_bruto == null ? null : Number(row.peso_bruto),
        pesoTara: row.peso_tara == null ? null : Number(row.peso_tara),
        precioAplicado: Number(row.precio_aplicado || 0),
        unidad: row.unidad === 'quintal' ? 'quintal' : 'tonelada',
        casualSnapshot: safeJsonParse(row.casual_snapshot)
    };
}

function mapTransaction(row) {
    return {
        id: row.id,
        fecha: row.fecha,
        hora: row.hora,
        placa: row.placa,
        conductor: row.conductor,
        clienteNombre: row.cliente_nombre,
        pesoBruto: Number(row.peso_bruto || 0),
        pesoTara: Number(row.peso_tara || 0),
        neto: Number(row.neto || 0),
        precioAplicado: Number(row.precio_aplicado || 0),
        total: Number(row.total || 0),
        unidad: row.unidad === 'quintal' ? 'quintal' : 'tonelada'
    };
}

function mapCorapsa(row) {
    return {
        id: row.id,
        fecha: row.fecha,
        reciboIn: row.recibo_in,
        reciboOut: row.recibo_out,
        cliente: row.cliente,
        toneladas: Number(row.toneladas || 0),
        precio: Number(row.precio || 0),
        total: Number(row.total || 0),
        fileName: row.file_name || 'Sin Archivo',
        fileNuestro: row.file_nuestro || 'Sin Archivo',
        pagado: Boolean(row.pagado)
    };
}

function mapExpense(row) {
    return {
        id: row.id,
        fecha: row.fecha,
        monto: Number(row.monto || 0),
        concepto: row.concepto,
        justificacion: row.justificacion || '',
        fileName: row.file_name || 'Sin Archivo'
    };
}

function mapWorker(row) {
    return {
        id: row.id,
        nombre: row.nombre,
        apellido: row.apellido,
        telefono: row.telefono || '',
        sueldoBase: Number(row.sueldo_base || 0),
        diasTrabajados: Number(row.dias_trabajados ?? 6),
        extras: Number(row.extras || 0)
    };
}

async function logAudit({ entity, entityId, action, justification = '', details = null }) {
    await db.run(
        `INSERT INTO auditoria (entidad, entidad_id, accion, justificacion, detalles)
         VALUES (?, ?, ?, ?, ?)`,
        [entity, entityId == null ? null : String(entityId), action, justification, details ? JSON.stringify(details) : null]
    );
}

async function withTransaction(callback) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await callback();
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function createQueueId() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        queueIdSequence = (queueIdSequence + 1) % 1000;
        const candidate = String((Date.now() * 1000) + queueIdSequence);
        const exists = await db.get('SELECT 1 FROM camiones_en_patio WHERE id = ?', [candidate]);
        if (!exists) return candidate;
    }

    throw new HttpError(503, 'No se pudo generar un ID único para el vehículo.', 'ID_GENERATION_FAILED');
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(serializeDatabaseAccess);

app.get('/api/health', (_req, res) => {
    sendData(res, { status: 'ok' });
});

// CLIENTES
app.get('/api/clientes', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM clientes ORDER BY id DESC');
    sendData(res, rows.map(mapClient));
}));

app.post('/api/clientes/ajuste-global', asyncHandler(async (req, res) => {
    const monto = asNumber(req.body?.monto, { required: true, field: 'El monto' });
    const razon = requireJustification(req.body);
    if (monto === 0) throw new HttpError(400, 'El monto del ajuste no puede ser cero.', 'VALIDATION_ERROR');

    const clientes = await withTransaction(async () => {
        const minimums = await db.get(`
            SELECT MIN(precio_flete_propio) AS propio, MIN(precio_flete_cliente) AS cliente
            FROM clientes
        `);
        if ((minimums?.propio ?? 0) + monto < 0 || (minimums?.cliente ?? 0) + monto < 0) {
            throw new HttpError(409, 'El ajuste dejaría uno o más precios negativos.', 'NEGATIVE_PRICE');
        }

        await db.run(`
            UPDATE clientes
            SET precio_flete_propio = precio_flete_propio + ?,
                precio_flete_cliente = precio_flete_cliente + ?,
                updated_at = CURRENT_TIMESTAMP
        `, [monto, monto]);
        await logAudit({ entity: 'clientes', action: 'ajuste_global', justification: razon, details: { monto } });
        return (await db.all('SELECT * FROM clientes ORDER BY id DESC')).map(mapClient);
    });

    sendData(res, { clientes });
}));

app.post('/api/clientes', asyncHandler(async (req, res) => {
    const client = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { field: 'El apellido', maxLength: 120 }),
        telefono: asText(req.body?.telefono, { field: 'El teléfono', maxLength: 40 }),
        ubicacion: asText(req.body?.ubicacion, { field: 'La ubicación', maxLength: 200 }),
        precioFletePropio: asNumber(req.body?.precioFletePropio, { required: true, min: 0, field: 'El precio de flete propio' }),
        precioFleteCliente: asNumber(req.body?.precioFleteCliente, { required: true, min: 0, field: 'El precio de flete cliente' }),
        unidad: asUnit(req.body?.unidad)
    };

    const result = await db.run(`
        INSERT INTO clientes (nombre, apellido, telefono, ubicacion, precio_flete_propio, precio_flete_cliente, unidad)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [client.nombre, client.apellido, client.telefono, client.ubicacion, client.precioFletePropio, client.precioFleteCliente, client.unidad]);
    const row = await db.get('SELECT * FROM clientes WHERE id = ?', [result.lastID]);
    await logAudit({ entity: 'cliente', entityId: result.lastID, action: 'crear', details: client });
    sendData(res, { cliente: mapClient(row) }, 201);
}));

app.put('/api/clientes/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const client = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { field: 'El apellido', maxLength: 120 }),
        telefono: asText(req.body?.telefono, { field: 'El teléfono', maxLength: 40 }),
        ubicacion: asText(req.body?.ubicacion, { field: 'La ubicación', maxLength: 200 }),
        precioFletePropio: asNumber(req.body?.precioFletePropio, { required: true, min: 0, field: 'El precio de flete propio' }),
        precioFleteCliente: asNumber(req.body?.precioFleteCliente, { required: true, min: 0, field: 'El precio de flete cliente' }),
        unidad: asUnit(req.body?.unidad)
    };

    const result = await db.run(`
        UPDATE clientes
        SET nombre = ?, apellido = ?, telefono = ?, ubicacion = ?,
            precio_flete_propio = ?, precio_flete_cliente = ?, unidad = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [client.nombre, client.apellido, client.telefono, client.ubicacion, client.precioFletePropio, client.precioFleteCliente, client.unidad, id]);
    if (!result.changes) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');

    const row = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
    await logAudit({ entity: 'cliente', entityId: id, action: 'editar', justification: justificacion, details: client });
    sendData(res, { cliente: mapClient(row) });
}));

app.delete('/api/clientes/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const queued = await db.get('SELECT id FROM camiones_en_patio WHERE cliente_id = ? LIMIT 1', [String(id)]);
    if (queued) throw new HttpError(409, 'No puede eliminarse un cliente con un vehículo activo en patio.', 'CLIENT_IN_USE');

    const result = await db.run('DELETE FROM clientes WHERE id = ?', [id]);
    if (!result.changes) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');
    await logAudit({ entity: 'cliente', entityId: id, action: 'eliminar', justification: justificacion });
    sendData(res, { id });
}));

// CAMIONES EN PATIO
app.get('/api/camiones-patio', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM camiones_en_patio ORDER BY created_at ASC, id ASC');
    sendData(res, rows.map(mapTruck));
}));

app.post('/api/camiones-patio', asyncHandler(async (req, res) => {
    const clienteIdRaw = req.body?.clienteId;
    if (clienteIdRaw === null || clienteIdRaw === undefined || clienteIdRaw === '') {
        throw new HttpError(400, 'El cliente es obligatorio.', 'VALIDATION_ERROR');
    }

    const flete = asFreightType(req.body?.flete);
    const pesoBruto = asNumber(req.body?.pesoBruto, { min: 0.01, field: 'El peso bruto' });
    const pesoTara = asNumber(req.body?.pesoTara, { min: 0.01, field: 'El peso tara' });
    if (pesoBruto == null && pesoTara == null) {
        throw new HttpError(400, 'Debe registrar al menos un peso.', 'VALIDATION_ERROR');
    }

    let clienteId;
    let clienteNombreSnapshot;
    let casualSnapshot = null;
    let precioAplicado;
    let unidad;

    if (String(clienteIdRaw) === 'casual') {
        const snapshot = req.body?.casualSnapshot || {};
        clienteId = 'casual';
        clienteNombreSnapshot = asText(snapshot.nombre, { required: true, field: 'El nombre casual', maxLength: 200 });
        unidad = asUnit(snapshot.unidad);
        const ownPrice = asNumber(snapshot.precioFletePropio, { required: true, min: 0, field: 'El precio casual' });
        const clientPrice = asNumber(snapshot.precioFleteCliente, { required: true, min: 0, field: 'El precio casual' });
        precioAplicado = flete === 'Propio' ? ownPrice : clientPrice;
        casualSnapshot = {
            id: 'casual',
            nombre: clienteNombreSnapshot,
            apellido: '',
            precioFletePropio: ownPrice,
            precioFleteCliente: clientPrice,
            unidad
        };
    } else {
        clienteId = Number(clienteIdRaw);
        if (!Number.isInteger(clienteId)) throw new HttpError(400, 'Cliente inválido.', 'VALIDATION_ERROR');
        const clientRow = await db.get('SELECT * FROM clientes WHERE id = ?', [clienteId]);
        if (!clientRow) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');
        const client = mapClient(clientRow);
        clienteNombreSnapshot = `${client.nombre} ${client.apellido}`.trim();
        unidad = client.unidad;
        precioAplicado = flete === 'Propio' ? client.precioFletePropio : client.precioFleteCliente;
    }

    const truck = await withTransaction(async () => {
        // An explicit numeric ID works with both the legacy TEXT primary key
        // and the current INTEGER primary key schema.
        const id = await createQueueId();

        await db.run(`
            INSERT INTO camiones_en_patio (
                id, cliente_id, cliente_nombre_snapshot, placa, conductor, flete,
                peso_bruto, peso_tara, precio_aplicado, unidad, casual_snapshot
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            String(clienteId),
            clienteNombreSnapshot,
            asText(req.body?.placa, { field: 'La placa', maxLength: 30 }) || 'S/P',
            asText(req.body?.conductor, { field: 'El conductor', maxLength: 150 }) || 'Desconocido',
            flete,
            pesoBruto,
            pesoTara,
            precioAplicado,
            unidad,
            casualSnapshot ? JSON.stringify(casualSnapshot) : null
        ]);

        const row = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        if (!row) throw new Error('El vehículo fue insertado, pero no pudo recuperarse de SQLite.');

        const mappedTruck = mapTruck(row);
        await logAudit({ entity: 'camion_patio', entityId: id, action: 'crear', details: mappedTruck });
        return mappedTruck;
    });

    sendData(res, { camion: truck }, 201);
}));

app.delete('/api/camiones-patio', (_req, _res, next) => {
    next(new HttpError(
        400,
        'No se recibió el ID del vehículo. Reinicie el servidor y recargue la aplicación para reparar la cola antigua.',
        'MISSING_QUEUE_ID'
    ));
});

app.patch('/api/camiones-patio/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const hasBruto = Object.prototype.hasOwnProperty.call(req.body || {}, 'pesoBruto');
    const hasTara = Object.prototype.hasOwnProperty.call(req.body || {}, 'pesoTara');
    if (!hasBruto && !hasTara) throw new HttpError(400, 'No hay campos de peso para actualizar.', 'VALIDATION_ERROR');

    if (hasBruto) {
        const peso = asNumber(req.body.pesoBruto, { required: true, min: 0.01, field: 'El peso bruto' });
        await db.run('UPDATE camiones_en_patio SET peso_bruto = ? WHERE id = ?', [peso, id]);
    }
    if (hasTara) {
        const peso = asNumber(req.body.pesoTara, { required: true, min: 0.01, field: 'El peso tara' });
        await db.run('UPDATE camiones_en_patio SET peso_tara = ? WHERE id = ?', [peso, id]);
    }

    const row = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Camión no encontrado en la cola.', 'NOT_FOUND');
    await logAudit({ entity: 'camion_patio', entityId: id, action: 'actualizar_peso', details: req.body });
    sendData(res, { camion: mapTruck(row) });
}));

app.post('/api/camiones-patio/:id/finalizar', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const fecha = asText(req.body?.fecha, { required: true, field: 'La fecha', maxLength: 10 });
    const hora = asText(req.body?.hora, { required: true, field: 'La hora', maxLength: 20 });

    const transaction = await withTransaction(async () => {
        const truck = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        if (!truck) throw new HttpError(404, 'Camión no encontrado para finalizar.', 'NOT_FOUND');
        if (truck.peso_bruto == null || truck.peso_tara == null) {
            throw new HttpError(409, 'La transacción no tiene ambos pesos.', 'MISSING_WEIGHT');
        }

        const neto = Math.abs(Number(truck.peso_bruto) - Number(truck.peso_tara));
        if (neto <= 0) throw new HttpError(409, 'El peso neto debe ser mayor que cero.', 'INVALID_NET_WEIGHT');
        const unidad = truck.unidad === 'quintal' ? 'quintal' : 'tonelada';
        const divisor = unidad === 'quintal' ? LBS_PER_QUINTAL : LBS_PER_METRIC_TON;
        const total = (neto / divisor) * Number(truck.precio_aplicado || 0);

        const insertResult = await db.run(`
            INSERT INTO transacciones (
                fecha, hora, placa, conductor, cliente_nombre,
                peso_bruto, peso_tara, neto, precio_aplicado, total, unidad
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            fecha, hora, truck.placa, truck.conductor,
            truck.cliente_nombre_snapshot || 'Cliente no disponible',
            truck.peso_bruto, truck.peso_tara, neto, truck.precio_aplicado, total, unidad
        ]);
        const transactionId = insertResult.lastID;
        await db.run('DELETE FROM camiones_en_patio WHERE id = ?', [id]);
        await logAudit({ entity: 'transaccion', entityId: transactionId, action: 'finalizar', details: { queueId: id } });
        return mapTransaction(await db.get('SELECT * FROM transacciones WHERE id = ?', [transactionId]));
    });

    sendData(res, { transaccion: transaction });
}));

app.delete('/api/camiones-patio/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const result = await db.run('DELETE FROM camiones_en_patio WHERE id = ?', [id]);
    if (!result.changes) throw new HttpError(404, 'Vehículo no encontrado.', 'NOT_FOUND');
    await logAudit({ entity: 'camion_patio', entityId: id, action: 'eliminar', justification: justificacion });
    sendData(res, { id });
}));

// TRANSACCIONES
app.get('/api/transacciones', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM transacciones ORDER BY id DESC');
    sendData(res, rows.map(mapTransaction));
}));

app.delete('/api/transacciones/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const result = await db.run('DELETE FROM transacciones WHERE id = ?', [id]);
    if (!result.changes) throw new HttpError(404, 'Transacción no encontrada.', 'NOT_FOUND');
    await logAudit({ entity: 'transaccion', entityId: id, action: 'eliminar', justification: justificacion });
    sendData(res, { id });
}));

// CORAPSA
app.get('/api/corapsa', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM corapsa ORDER BY fecha DESC, id DESC');
    sendData(res, rows.map(mapCorapsa));
}));

app.post('/api/corapsa', asyncHandler(async (req, res) => {
    const fecha = asText(req.body?.fecha, { required: true, field: 'La fecha', maxLength: 10 });
    const reciboIn = asText(req.body?.reciboIn, { required: true, field: 'El recibo Corapsa', maxLength: 100 });
    const cliente = asText(req.body?.cliente, { required: true, field: 'El cliente', maxLength: 200 });
    const toneladas = asNumber(req.body?.toneladas, { required: true, min: 0.01, field: 'Las toneladas' });
    const precio = asNumber(req.body?.precio, { required: true, min: 0, field: 'El precio' });
    const total = toneladas * precio;

    const result = await db.run(`
        INSERT INTO corapsa (fecha, recibo_in, cliente, toneladas, precio, total, file_name, file_nuestro, pagado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        fecha, reciboIn, cliente, toneladas, precio, total,
        asText(req.body?.fileName, { maxLength: 255 }) || 'Sin Archivo',
        asText(req.body?.fileNuestro, { maxLength: 255 }) || 'Sin Archivo',
        req.body?.pagado ? 1 : 0
    ]);
    const reciboOut = `CRX-${String(result.lastID).padStart(6, '0')}`;
    await db.run('UPDATE corapsa SET recibo_out = ? WHERE id = ?', [reciboOut, result.lastID]);
    const row = await db.get('SELECT * FROM corapsa WHERE id = ?', [result.lastID]);
    await logAudit({ entity: 'corapsa', entityId: result.lastID, action: 'crear', details: mapCorapsa(row) });
    sendData(res, { corapsa: mapCorapsa(row) }, 201);
}));

app.put('/api/corapsa/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const fecha = asText(req.body?.fecha, { required: true, field: 'La fecha', maxLength: 10 });
    const reciboIn = asText(req.body?.reciboIn, { required: true, field: 'El recibo Corapsa', maxLength: 100 });
    const cliente = asText(req.body?.cliente, { required: true, field: 'El cliente', maxLength: 200 });
    const toneladas = asNumber(req.body?.toneladas, { required: true, min: 0.01, field: 'Las toneladas' });
    const precio = asNumber(req.body?.precio, { required: true, min: 0, field: 'El precio' });
    const total = toneladas * precio;

    const result = await db.run(`
        UPDATE corapsa
        SET fecha = ?, recibo_in = ?, cliente = ?, toneladas = ?, precio = ?, total = ?,
            file_name = ?, file_nuestro = ?, pagado = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [
        fecha, reciboIn, cliente, toneladas, precio, total,
        asText(req.body?.fileName, { maxLength: 255 }) || 'Sin Archivo',
        asText(req.body?.fileNuestro, { maxLength: 255 }) || 'Sin Archivo',
        req.body?.pagado ? 1 : 0,
        id
    ]);
    if (!result.changes) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
    const row = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
    await logAudit({ entity: 'corapsa', entityId: id, action: 'editar', justification: justificacion, details: mapCorapsa(row) });
    sendData(res, { corapsa: mapCorapsa(row) });
}));

app.patch('/api/corapsa/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const updates = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pagado')) {
        updates.push('pagado = ?');
        values.push(req.body.pagado ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'fileName')) {
        updates.push('file_name = ?');
        values.push(asText(req.body.fileName, { maxLength: 255 }) || 'Sin Archivo');
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'fileNuestro')) {
        updates.push('file_nuestro = ?');
        values.push(asText(req.body.fileNuestro, { maxLength: 255 }) || 'Sin Archivo');
    }
    if (updates.length === 0) throw new HttpError(400, 'No hay campos válidos para actualizar.', 'VALIDATION_ERROR');

    values.push(id);
    const result = await db.run(`UPDATE corapsa SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values);
    if (!result.changes) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
    const row = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
    await logAudit({
        entity: 'corapsa', entityId: id, action: 'actualizar_parcial',
        justification: asText(req.body?.justificacion, { maxLength: 500 }),
        details: req.body
    });
    sendData(res, { corapsa: mapCorapsa(row) });
}));

app.delete('/api/corapsa/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const result = await db.run('DELETE FROM corapsa WHERE id = ?', [id]);
    if (!result.changes) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
    await logAudit({ entity: 'corapsa', entityId: id, action: 'eliminar', justification: justificacion });
    sendData(res, { id });
}));

// GASTOS
app.get('/api/gastos', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM gastos ORDER BY fecha DESC, id DESC');
    sendData(res, rows.map(mapExpense));
}));

app.post('/api/gastos', asyncHandler(async (req, res) => {
    const expense = {
        fecha: asText(req.body?.fecha, { required: true, field: 'La fecha', maxLength: 10 }),
        monto: asNumber(req.body?.monto, { required: true, min: 0.01, field: 'El monto' }),
        concepto: asText(req.body?.concepto, { required: true, field: 'El concepto', maxLength: 200 }),
        justificacion: asText(req.body?.justificacion, { maxLength: 1000 }),
        fileName: asText(req.body?.fileName, { maxLength: 255 }) || 'Sin Archivo'
    };
    const result = await db.run(`
        INSERT INTO gastos (fecha, monto, concepto, justificacion, file_name)
        VALUES (?, ?, ?, ?, ?)
    `, [expense.fecha, expense.monto, expense.concepto, expense.justificacion, expense.fileName]);
    const row = await db.get('SELECT * FROM gastos WHERE id = ?', [result.lastID]);
    await logAudit({ entity: 'gasto', entityId: result.lastID, action: 'crear', details: expense });
    sendData(res, { gasto: mapExpense(row) }, 201);
}));

app.put('/api/gastos/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const expense = {
        fecha: asText(req.body?.fecha, { required: true, field: 'La fecha', maxLength: 10 }),
        monto: asNumber(req.body?.monto, { required: true, min: 0.01, field: 'El monto' }),
        concepto: asText(req.body?.concepto, { required: true, field: 'El concepto', maxLength: 200 }),
        justificacion: asText(req.body?.justificacion, { maxLength: 1000 }),
        fileName: asText(req.body?.fileName, { maxLength: 255 }) || 'Sin Archivo'
    };
    const result = await db.run(`
        UPDATE gastos SET fecha = ?, monto = ?, concepto = ?, justificacion = ?, file_name = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [expense.fecha, expense.monto, expense.concepto, expense.justificacion, expense.fileName, id]);
    if (!result.changes) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
    const row = await db.get('SELECT * FROM gastos WHERE id = ?', [id]);
    await logAudit({ entity: 'gasto', entityId: id, action: 'editar', details: expense });
    sendData(res, { gasto: mapExpense(row) });
}));

app.delete('/api/gastos/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const result = await db.run('DELETE FROM gastos WHERE id = ?', [id]);
    if (!result.changes) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
    await logAudit({ entity: 'gasto', entityId: id, action: 'eliminar', justification: justificacion });
    sendData(res, { id });
}));

// PLANILLA
app.get('/api/planilla', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM planilla ORDER BY apellido, nombre, id');
    sendData(res, rows.map(mapWorker));
}));

app.post('/api/planilla', asyncHandler(async (req, res) => {
    const worker = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { required: true, field: 'El apellido', maxLength: 120 }),
        telefono: asText(req.body?.telefono, { maxLength: 40 }),
        sueldoBase: asNumber(req.body?.sueldoBase, { required: true, min: 0.01, field: 'El sueldo base' }),
        diasTrabajados: asNumber(req.body?.diasTrabajados ?? 6, { required: true, min: 0, field: 'Los días trabajados' }),
        extras: asNumber(req.body?.extras ?? 0, { required: true, min: 0, field: 'Los extras' })
    };
    if (worker.diasTrabajados > 7) throw new HttpError(400, 'Los días trabajados no pueden exceder 7.', 'VALIDATION_ERROR');
    const result = await db.run(`
        INSERT INTO planilla (nombre, apellido, telefono, sueldo_base, dias_trabajados, extras)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [worker.nombre, worker.apellido, worker.telefono, worker.sueldoBase, worker.diasTrabajados, worker.extras]);
    const row = await db.get('SELECT * FROM planilla WHERE id = ?', [result.lastID]);
    await logAudit({ entity: 'trabajador', entityId: result.lastID, action: 'crear', details: worker });
    sendData(res, { trabajador: mapWorker(row) }, 201);
}));

app.put('/api/planilla/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const worker = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { required: true, field: 'El apellido', maxLength: 120 }),
        telefono: asText(req.body?.telefono, { maxLength: 40 }),
        sueldoBase: asNumber(req.body?.sueldoBase, { required: true, min: 0.01, field: 'El sueldo base' }),
        diasTrabajados: asNumber(req.body?.diasTrabajados ?? 6, { required: true, min: 0, field: 'Los días trabajados' }),
        extras: asNumber(req.body?.extras ?? 0, { required: true, min: 0, field: 'Los extras' })
    };
    if (worker.diasTrabajados > 7) throw new HttpError(400, 'Los días trabajados no pueden exceder 7.', 'VALIDATION_ERROR');
    const result = await db.run(`
        UPDATE planilla
        SET nombre = ?, apellido = ?, telefono = ?, sueldo_base = ?, dias_trabajados = ?, extras = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [worker.nombre, worker.apellido, worker.telefono, worker.sueldoBase, worker.diasTrabajados, worker.extras, id]);
    if (!result.changes) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');
    const row = await db.get('SELECT * FROM planilla WHERE id = ?', [id]);
    await logAudit({ entity: 'trabajador', entityId: id, action: 'editar', details: worker });
    sendData(res, { trabajador: mapWorker(row) });
}));

app.patch('/api/planilla/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const dias = asNumber(req.body?.diasTrabajados, { required: true, min: 0, field: 'Los días trabajados' });
    const extras = asNumber(req.body?.extras, { required: true, min: 0, field: 'Los extras' });
    if (dias > 7) throw new HttpError(400, 'Los días trabajados no pueden exceder 7.', 'VALIDATION_ERROR');
    const result = await db.run(`
        UPDATE planilla SET dias_trabajados = ?, extras = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `, [dias, extras, id]);
    if (!result.changes) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');
    const row = await db.get('SELECT * FROM planilla WHERE id = ?', [id]);
    sendData(res, { trabajador: mapWorker(row) });
}));

app.delete('/api/planilla/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const result = await db.run('DELETE FROM planilla WHERE id = ?', [id]);
    if (!result.changes) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');
    await logAudit({ entity: 'trabajador', entityId: id, action: 'eliminar', justification: justificacion });
    sendData(res, { id });
}));

app.use((req, _res, next) => {
    next(new HttpError(404, `Ruta no encontrada: ${req.method} ${req.path}`, 'NOT_FOUND'));
});

app.use((error, _req, res, _next) => {
    const status = Number(error.status) || 500;
    const production = process.env.NODE_ENV === 'production';
    if (status >= 500) console.error(error);

    res.status(status).json({
        ok: false,
        error: {
            code: error.code || 'INTERNAL_ERROR',
            message: status >= 500 && production
                ? 'Ocurrió un error interno en el servidor.'
                : (error.message || 'Ocurrió un error interno en el servidor.'),
            details: production ? null : (error.details || null)
        }
    });
});

async function start() {
    db = await initializeDB();
    server = app.listen(PORT, HOST, () => {
        console.log(`Servidor de Báscula Central corriendo en http://${HOST}:${PORT}`);
    });
}

async function shutdown(signal) {
    console.log(`Cerrando servidor (${signal})...`);
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.close();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(error => {
    console.error('No se pudo iniciar el servidor:', error);
    process.exitCode = 1;
});

module.exports = app;