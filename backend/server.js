require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const initializeDB = require('./database');
const storage = require('./storage');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const VALID_UNITS = new Set(['tonelada', 'quintal']);
const VALID_FREIGHT_TYPES = new Set(['Propio', 'Cliente']);
const VALID_AJUSTE_CATEGORIAS = new Set(['global', 'acopio', 'directo']);
const VALID_CLIENT_CATEGORIAS = new Set(['acopio', 'directo', 'ambos']);
const LBS_PER_METRIC_TON = 2204.62262185;
const LBS_PER_QUINTAL = 100;
// Derived (not a rounded business convention) so quintal<->ton price
// conversions agree with the same lbs constants the rest of the app uses —
// the old hardcoded 22.04 was off by ~0.03% from the precise 22.0462262185,
// a permanent bias baked into every quintal price edit/adjustment.
const QUINTALES_PER_TON = LBS_PER_METRIC_TON / LBS_PER_QUINTAL;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const JSON_BODY_LIMIT = '30mb';
// Sanity ceilings, not business rules — generous enough to never reject a
// real entry, tight enough to catch a fat-fingered extra digit that no
// server-side check currently stops (e.g. a truck weight typo). Tune here if
// real operations ever legitimately need more.
const MAX_WEIGHT_LBS = 200000;
const MAX_MONEY_LEMPIRAS = 1000000;

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

// Pure attachment downloads never touch the write queue (no DB write, and
// SQLite's WAL mode already lets reads run concurrently with everything
// else), so exempting them here keeps one slow DigitalOcean Spaces transfer
// from stalling every other operator's unrelated request while it downloads.
// Upload routes still need the queue below — they follow with a DB write —
// so this only helps the read/view side of the attachment flow.
const UNSERIALIZED_ATTACHMENT_READS = [
    /^\/api\/corapsa\/[^/]+\/archivo\/[^/]+$/,
    /^\/api\/gastos\/[^/]+\/archivo$/,
    /^\/api\/corapsa-pagos\/[^/]+\/archivo$/
];

function serializeDatabaseAccess(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    if (req.method === 'GET' && UNSERIALIZED_ATTACHMENT_READS.some(pattern => pattern.test(req.path))) {
        return next();
    }

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

function isValidApiKey(provided) {
    const expected = Buffer.from(API_KEY);
    const providedBuf = Buffer.from(String(provided || ''));
    if (providedBuf.length !== expected.length) return false;
    return crypto.timingSafeEqual(providedBuf, expected);
}

function requireApiKey(req, res, next) {
    // MVP: auth is off until API_KEY is set on the server. Set it (and keep the
    // frontend's API_KEY in globals.js in sync) to turn this back on later.
    if (!API_KEY) return next();
    if (req.method === 'OPTIONS') return next();
    if (req.path === '/api/health') return next();
    if (!isValidApiKey(req.get('X-API-Key'))) {
        return next(new HttpError(401, 'API key inválida o ausente.', 'UNAUTHORIZED'));
    }
    next();
}

const corsOptions = {
    origin(origin, callback) {
        // A packaged Electron renderer loaded from file:// sends Origin: "null" (an opaque
        // origin) or omits it entirely; there is no legitimate multi-origin browser client
        // for this API. CORS is browser-enforced defense-in-depth here, not the primary
        // access control — the X-API-Key check above is.
        if (!origin || origin === 'null') return callback(null, true);
        return callback(new HttpError(403, 'Origen no permitido.', 'FORBIDDEN_ORIGIN'), false);
    }
};


function asText(value, { required = false, field = 'campo', maxLength = 250 } = {}) {
    const text = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (required && !text) throw new HttpError(400, `${field} es obligatorio.`, 'VALIDATION_ERROR');
    if (text.length > maxLength) throw new HttpError(400, `${field} excede ${maxLength} caracteres.`, 'VALIDATION_ERROR');
    return text;
}

function asNumber(value, { required = false, min = -Infinity, max = Infinity, field = 'valor' } = {}) {
    if (value === null || value === undefined || value === '') {
        if (required) throw new HttpError(400, `${field} es obligatorio.`, 'VALIDATION_ERROR');
        return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new HttpError(400, `${field} no es válido.`, 'VALIDATION_ERROR');
    if (number < min) throw new HttpError(400, `${field} debe ser mayor o igual que ${min}.`, 'VALIDATION_ERROR');
    if (number > max) throw new HttpError(400, `${field} debe ser menor o igual que ${max}.`, 'VALIDATION_ERROR');
    return number;
}

function asIsoDate(value, field = 'La fecha') {
    const text = String(value || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) throw new HttpError(400, `${field} no es válida.`, 'VALIDATION_ERROR');

    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (
        date.getUTCFullYear() !== Number(match[1]) ||
        date.getUTCMonth() !== Number(match[2]) - 1 ||
        date.getUTCDate() !== Number(match[3])
    ) throw new HttpError(400, `${field} no es válida.`, 'VALIDATION_ERROR');

    return text;
}

function getDateRangeLength(start, end) {
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    return Math.floor((endMs - startMs) / 86400000) + 1;
}

function validatePayrollRange(startValue, endValue) {
    const start = asIsoDate(startValue, 'La fecha inicial');
    const end = asIsoDate(endValue, 'La fecha final');
    if (start > end) {
        throw new HttpError(400, 'La fecha inicial no puede ser posterior a la fecha final.', 'VALIDATION_ERROR');
    }
    const days = getDateRangeLength(start, end);
    if (days > 31) {
        throw new HttpError(400, 'El período de planilla no puede superar 31 días.', 'VALIDATION_ERROR');
    }
    return { start, end, days };
}

function validateOverviewRange(startValue, endValue) {
    const start = asIsoDate(startValue, 'La fecha inicial');
    const end = asIsoDate(endValue, 'La fecha final');
    if (start > end) {
        throw new HttpError(400, 'La fecha inicial no puede ser posterior a la fecha final.', 'VALIDATION_ERROR');
    }
    const days = getDateRangeLength(start, end);
    if (days > 3660) {
        throw new HttpError(400, 'El período del Overview no puede superar 10 años.', 'VALIDATION_ERROR');
    }
    return { start, end, days };
}

function asTime(value, field) {
    const text = String(value || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
        throw new HttpError(400, `${field} no es válida.`, 'VALIDATION_ERROR');
    }
    return text;
}

function asBoolean(value) {
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    throw new HttpError(400, 'El estado de la jornada no es válido.', 'VALIDATION_ERROR');
}

function asWorkerPhone(value) {
    const phone = asText(value, { maxLength: 30 });
    if (!phone || phone === '+504') return '';
    if (phone.startsWith('+504')) {
        if (!/^\+504 \d{4}-\d{4}$/.test(phone)) {
            throw new HttpError(400, 'Para Honduras use el formato +504 1234-5678.', 'VALIDATION_ERROR');
        }
        return phone;
    }

    const digits = phone.replace(/\D/g, '');
    if (!phone.startsWith('+') || digits.length < 7 || digits.length > 15) {
        throw new HttpError(400, 'El teléfono internacional debe comenzar con + y un código de área válido.', 'VALIDATION_ERROR');
    }
    return phone;
}

function roundToNearestWhole(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new HttpError(400, 'No se pudo calcular el precio por quintal.', 'VALIDATION_ERROR');
    // A flat Number.EPSILON only nudges past float representation error for
    // numbers near 1 — the error itself scales with magnitude, so it needs to
    // here too, or this is a no-op at realistic price magnitudes (hundreds+).
    return Math.round(number + Number.EPSILON * Math.max(1, Math.abs(number)));
}

function roundToCurrency(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new HttpError(400, 'Precio inválido.', 'VALIDATION_ERROR');
    return Math.round((number + Number.EPSILON) * 100) / 100;
}

function truncateToDecimals(value, decimalPlaces = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new HttpError(400, 'No se pudo calcular la cantidad facturable.', 'VALIDATION_ERROR');
    }

    const places = Number.isInteger(decimalPlaces) && decimalPlaces >= 0
        ? decimalPlaces
        : 2;
    const factor = 10 ** places;
    return Math.floor((number + 1e-9) * factor) / factor;
}

function calculateBillableQuantity(netWeightLbs, unit) {
    const net = Number(netWeightLbs);
    if (!Number.isFinite(net) || net < 0) {
        throw new HttpError(400, 'El peso neto no es válido.', 'VALIDATION_ERROR');
    }

    if (unit === 'quintal') return net / LBS_PER_QUINTAL;

    // Business rule: truncate metric tons to two decimals before applying price.
    return truncateToDecimals(net / LBS_PER_METRIC_TON, 2);
}

// Acopio (weigh-station) and Directo (direct-to-company) prices are only
// required from the client form when the client's categoria actually uses
// them — a 'directo'-only client has no flete prices, an 'acopio'-only
// client has no Directo price (stored as NULL, see getStoredDirectoPrice).
function buildClientPricing(body, unidad, categoria) {
    const includesAcopio = categoria !== 'directo';
    const includesDirecto = categoria !== 'acopio';

    let acopioPricing;
    if (!includesAcopio) {
        acopioPricing = { precioToneladaPropio: 0, precioToneladaCliente: 0, precioFletePropio: 0, precioFleteCliente: 0 };
    } else if (unidad === 'quintal') {
        const precioToneladaPropio = asNumber(body?.precioToneladaPropio, {
            required: true,
            min: 0,
            max: MAX_MONEY_LEMPIRAS,
            field: 'El precio en tonelada de flete propio'
        });
        const precioToneladaCliente = asNumber(body?.precioToneladaCliente, {
            required: true,
            min: 0,
            max: MAX_MONEY_LEMPIRAS,
            field: 'El precio en tonelada de flete cliente'
        });

        const precioSugeridoPropio = roundToNearestWhole(precioToneladaPropio / QUINTALES_PER_TON);
        const precioSugeridoCliente = roundToNearestWhole(precioToneladaCliente / QUINTALES_PER_TON);
        const precioFletePropio = asNumber(body?.precioFletePropio ?? precioSugeridoPropio, {
            required: true,
            min: 0,
            max: MAX_MONEY_LEMPIRAS,
            field: 'El precio por quintal de flete propio'
        });
        const precioFleteCliente = asNumber(body?.precioFleteCliente ?? precioSugeridoCliente, {
            required: true,
            min: 0,
            max: MAX_MONEY_LEMPIRAS,
            field: 'El precio por quintal de flete cliente'
        });

        acopioPricing = {
            precioToneladaPropio: roundToCurrency(precioToneladaPropio),
            precioToneladaCliente: roundToCurrency(precioToneladaCliente),
            precioFletePropio: roundToNearestWhole(precioFletePropio),
            precioFleteCliente: roundToNearestWhole(precioFleteCliente)
        };
    } else {
        const precioFletePropio = asNumber(body?.precioFletePropio, {
            required: true,
            min: 0,
            max: MAX_MONEY_LEMPIRAS,
            field: 'El precio de flete propio'
        });
        const precioFleteCliente = asNumber(body?.precioFleteCliente, {
            required: true,
            min: 0,
            max: MAX_MONEY_LEMPIRAS,
            field: 'El precio de flete cliente'
        });

        acopioPricing = {
            precioToneladaPropio: roundToCurrency(precioFletePropio),
            precioToneladaCliente: roundToCurrency(precioFleteCliente),
            precioFletePropio: roundToCurrency(precioFletePropio),
            precioFleteCliente: roundToCurrency(precioFleteCliente)
        };
    }

    const precioToneladaDirecto = includesDirecto
        ? roundToCurrency(asNumber(body?.precioToneladaDirecto, {
            required: true,
            min: 0,
            max: MAX_MONEY_LEMPIRAS,
            field: 'El precio directo por tonelada'
        }))
        : null;

    return { ...acopioPricing, precioToneladaDirecto };
}

function getStoredTonPrice(row, freightType) {
    const isOwn = freightType === 'Propio';
    const storedRaw = isOwn ? row.precio_tonelada_propio : row.precio_tonelada_cliente;
    const stored = Number(storedRaw);
    if (storedRaw !== null && storedRaw !== undefined && storedRaw !== '' && Number.isFinite(stored)) {
        return stored;
    }

    const unitPrice = Number(isOwn ? row.precio_flete_propio : row.precio_flete_cliente) || 0;
    return row.unidad === 'quintal'
        ? roundToCurrency(unitPrice * QUINTALES_PER_TON)
        : roundToCurrency(unitPrice);
}

// Compra Directo (Recibos Externos) has no per-truck flete split, so it
// stores a single ton price. Falls back to the Propio ton price for clients
// where it hasn't been set yet, matching the pre-existing autofill behavior.
function getStoredDirectoPrice(row) {
    const stored = Number(row.precio_tonelada_directo);
    if (row.precio_tonelada_directo !== null && row.precio_tonelada_directo !== undefined && Number.isFinite(stored)) {
        return stored;
    }
    return getStoredTonPrice(row, 'Propio');
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

// Tags whether a client is a weigh-station (Acopio) customer, a direct-to-company
// (Directo) customer, or both — lets ajuste-global filter which clients a given
// adjustment touches.
function asClientCategoria(value) {
    const categoria = String(value || '').toLowerCase();
    if (!VALID_CLIENT_CATEGORIAS.has(categoria)) {
        throw new HttpError(400, 'La categoría del cliente no es válida.', 'VALIDATION_ERROR');
    }
    return categoria;
}

function asDestino(value) {
    const destino = String(value || '').trim().toUpperCase();
    if (!destino) throw new HttpError(400, 'El destino es obligatorio.', 'VALIDATION_ERROR');
    if (destino.length > 80) throw new HttpError(400, 'El destino excede 80 caracteres.', 'VALIDATION_ERROR');
    return destino;
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

function isAllowedAttachmentMime(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    // SVG excluded despite the image/* prefix: it can carry embedded
    // <script>/event-handler payloads that execute if the file is ever
    // opened outside the app's own <img>-tag viewer (e.g. a direct
    // navigation or new-tab open), unlike raster image formats.
    if (mime === 'image/svg+xml') return false;
    return mime === 'application/pdf' || mime.startsWith('image/');
}

function parseAttachmentPayload(value, fieldName = 'El archivo') {
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new HttpError(400, `${fieldName} no tiene un formato válido.`, 'VALIDATION_ERROR');
    }

    const fileName = asText(value.fileName ?? value.name, {
        required: true,
        field: `El nombre de ${fieldName.toLowerCase()}`,
        maxLength: 255
    });
    const dataUrl = String(value.dataUrl ?? value.data ?? '');
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
    if (!match) {
        throw new HttpError(400, `${fieldName} no contiene datos válidos.`, 'INVALID_ATTACHMENT');
    }

    const mimeType = String(match[1] || value.mimeType || value.fileMimeType || '').toLowerCase();
    if (!isAllowedAttachmentMime(mimeType)) {
        throw new HttpError(415, 'Solo se permiten imágenes y archivos PDF.', 'UNSUPPORTED_ATTACHMENT_TYPE');
    }

    let data;
    try {
        data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    } catch (_) {
        throw new HttpError(400, `${fieldName} está dañado o incompleto.`, 'INVALID_ATTACHMENT');
    }

    if (!data.length) {
        throw new HttpError(400, `${fieldName} está vacío.`, 'INVALID_ATTACHMENT');
    }
    if (data.length > MAX_ATTACHMENT_BYTES) {
        throw new HttpError(
            413,
            `${fieldName} supera el límite de 10 MB.`,
            'ATTACHMENT_TOO_LARGE',
            { maxBytes: MAX_ATTACHMENT_BYTES }
        );
    }

    return { fileName, mimeType, data };
}

function hasStoredAttachment(value) {
    if (Buffer.isBuffer(value)) return value.length > 0;
    if (value instanceof Uint8Array) return value.byteLength > 0;
    return typeof value === 'string' && value.length > 0;
}

function normalizeStoredAttachment(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string' && value) return Buffer.from(value, 'base64');
    return null;
}

function sendStoredAttachment(res, { fileName, mimeType, data }) {
    const buffer = normalizeStoredAttachment(data);
    if (!buffer?.length) throw new HttpError(404, 'El archivo adjunto no está disponible.', 'ATTACHMENT_NOT_FOUND');

    res.setHeader('Content-Type', isAllowedAttachmentMime(mimeType) ? mimeType : 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName || 'archivo')}`);
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(buffer);
}

// Uploads to Spaces when configured; otherwise falls back to storing the raw
// bytes in SQLite (so local/dev testing keeps working without Spaces creds).
async function storeAttachment(folder, attachment) {
    if (!attachment) return null;
    if (storage.isConfigured()) {
        const key = await storage.uploadObject(folder, attachment.data, attachment.fileName, attachment.mimeType);
        return { fileName: attachment.fileName, mimeType: attachment.mimeType, key, data: null };
    }
    return { fileName: attachment.fileName, mimeType: attachment.mimeType, key: null, data: attachment.data };
}

async function respondWithAttachment(res, { fileName, mimeType, data, key }) {
    if (key) {
        let buffer;
        try {
            buffer = await storage.fetchObject(key);
        } catch (error) {
            if (error?.notFound) {
                throw new HttpError(404, 'El archivo adjunto no está disponible.', 'ATTACHMENT_NOT_FOUND');
            }
            throw error;
        }
        return sendStoredAttachment(res, { fileName, mimeType, data: buffer });
    }
    return sendStoredAttachment(res, { fileName, mimeType, data });
}

function mapCompany(row) {
    return { id: row.id, nombre: row.nombre };
}

function mapClient(row) {
    const unidad = row.unidad === 'quintal' ? 'quintal' : 'tonelada';
    const precioFletePropioRaw = Number(row.precio_flete_propio || 0);
    const precioFleteClienteRaw = Number(row.precio_flete_cliente || 0);
    return {
        id: row.id,
        nombre: row.nombre,
        apellido: row.apellido || '',
        telefono: row.telefono || '',
        ubicacion: row.ubicacion || '',
        identidad: row.identidad || '',
        precioFletePropio: unidad === 'quintal'
            ? roundToNearestWhole(precioFletePropioRaw)
            : precioFletePropioRaw,
        precioFleteCliente: unidad === 'quintal'
            ? roundToNearestWhole(precioFleteClienteRaw)
            : precioFleteClienteRaw,
        precioToneladaPropio: getStoredTonPrice(row, 'Propio'),
        precioToneladaCliente: getStoredTonPrice(row, 'Cliente'),
        precioToneladaDirecto: getStoredDirectoPrice(row),
        categoria: VALID_CLIENT_CATEGORIAS.has(row.categoria) ? row.categoria : 'ambos',
        unidad
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
        casualSnapshot: safeJsonParse(row.casual_snapshot),
        fechaEntrada: row.fecha_entrada || '',
        horaEntrada: row.hora_entrada || '',
        identidadSnapshot: row.identidad_snapshot || ''
    };
}

function mapTransaction(row) {
    return {
        id: row.id,
        fecha: row.fecha,
        hora: row.hora,
        fechaEntrada: row.fecha_entrada || '',
        horaEntrada: row.hora_entrada || '',
        placa: row.placa,
        conductor: row.conductor,
        clienteNombre: row.cliente_nombre,
        identidad: row.identidad || '',
        numeroBoleta: row.numero_boleta == null ? null : Number(row.numero_boleta),
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
        telefono: row.telefono || '',
        destino: row.destino || '',
        aNombreDe: row.a_nombre_de || '',
        toneladas: Number(row.toneladas || 0),
        precio: Number(row.precio || 0),
        total: Number(row.total || 0),
        fileName: row.file_name || 'Sin Archivo',
        fileMimeType: row.file_mime_type || '',
        hasFile: Boolean(row.has_file) || Boolean(row.file_key) || hasStoredAttachment(row.file_data),
        fileNuestro: row.file_nuestro || 'Sin Archivo',
        fileNuestroMimeType: row.file_nuestro_mime_type || '',
        hasFileNuestro: Boolean(row.has_file_nuestro) || Boolean(row.file_nuestro_key) || hasStoredAttachment(row.file_nuestro_data),
        pagado: Boolean(row.pagado),
        excluido: Boolean(row.excluido),
        esProductoPropio: Boolean(row.es_producto_propio),
        updatedAt: row.updated_at || row.created_at || ''
    };
}

function mapCorapsaPayment(row) {
    return {
        id: row.id,
        fechaPago: row.fecha_pago,
        periodoInicio: row.periodo_inicio,
        periodoFin: row.periodo_fin,
        referencia: row.referencia || '',
        destino: row.destino || '',
        toneladas: Number(row.toneladas || 0),
        monto: Number(row.monto || 0),
        notas: row.notas || '',
        fileName: row.file_name || 'Sin Archivo',
        fileMimeType: row.file_mime_type || '',
        hasFile: Boolean(row.has_file) || Boolean(row.file_key) || hasStoredAttachment(row.file_data),
        updatedAt: row.updated_at || row.created_at || ''
    };
}

function mapExpense(row) {
    return {
        id: row.id,
        fecha: row.fecha,
        monto: Number(row.monto || 0),
        concepto: row.concepto,
        justificacion: row.justificacion || '',
        notas: row.notas || '',
        fileName: row.file_name || 'Sin Archivo',
        fileMimeType: row.file_mime_type || '',
        hasFile: Boolean(row.has_file) || Boolean(row.file_key) || hasStoredAttachment(row.file_data),
        updatedAt: row.updated_at || row.created_at || ''
    };
}

function mapWorker(row) {
    return {
        id: row.id,
        nombre: row.nombre,
        apellido: row.apellido,
        telefono: row.telefono || '',
        sueldoBase: Number(row.sueldo_base || 0),
        diasTrabajados: Number(row.dias_trabajados ?? 0),
        extras: Number(row.extras || 0)
    };
}

function mapAttendance(row) {
    return {
        fecha: row.fecha,
        trabajado: Boolean(row.trabajado),
        horaInicio: row.hora_inicio || '07:00',
        horaFin: row.hora_fin || '16:00'
    };
}

async function buildPayrollSummary(start, end, workerId = null) {
    const workerParams = [start, end];
    let workerFilter = '';
    if (workerId != null) {
        workerFilter = 'WHERE p.id = ?';
        workerParams.push(workerId);
    }

    const workers = await db.all(`
        SELECT p.*, COALESCE(pp.extras, 0) AS extras_periodo
        FROM planilla p
        LEFT JOIN planilla_periodos pp
            ON pp.trabajador_id = p.id
           AND pp.fecha_inicio = ?
           AND pp.fecha_fin = ?
        ${workerFilter}
        ORDER BY p.apellido, p.nombre, p.id
    `, workerParams);

    const attendanceParams = [start, end];
    let attendanceFilter = '';
    if (workerId != null) {
        attendanceFilter = 'AND trabajador_id = ?';
        attendanceParams.push(workerId);
    }

    const attendanceRows = await db.all(`
        SELECT trabajador_id, fecha, trabajado, hora_inicio, hora_fin
        FROM planilla_asistencia
        WHERE fecha BETWEEN ? AND ?
        ${attendanceFilter}
        ORDER BY fecha
    `, attendanceParams);

    const attendanceByWorker = new Map();
    for (const row of attendanceRows) {
        const key = String(row.trabajador_id);
        if (!attendanceByWorker.has(key)) attendanceByWorker.set(key, []);
        attendanceByWorker.get(key).push(mapAttendance(row));
    }

    const mapped = workers.map(row => {
        const asistencia = attendanceByWorker.get(String(row.id)) || [];
        const diasTrabajados = asistencia.filter(item => item.trabajado).length;
        const extras = Number(row.extras_periodo || 0);
        const sueldoBase = Number(row.sueldo_base || 0);
        const totalPeriodo = roundToCurrency((sueldoBase / 6) * diasTrabajados + extras);
        return {
            ...mapWorker(row),
            diasTrabajados,
            extras,
            totalPeriodo,
            asistencia
        };
    });

    return {
        inicio: start,
        fin: end,
        trabajadores: mapped,
        totalGeneral: roundToCurrency(mapped.reduce((sum, worker) => sum + worker.totalPeriodo, 0))
    };
}

// Merges Compra Directo (Recibos Externos) and Venta (estados de cuenta) totals by
// destino company. Compra Acopio isn't included here because in-house scale
// transactions aren't attributed to a specific destination company.
function buildDestinoBreakdown(directRows, ventaRows) {
    const byDestino = new Map();
    const ensureEntry = destinoValue => {
        const key = destinoValue || 'SIN DESTINO';
        if (!byDestino.has(key)) {
            byDestino.set(key, {
                destino: key,
                compraDirecto: { registros: 0, toneladas: 0, monto: 0 },
                venta: { registros: 0, toneladas: 0, monto: 0 }
            });
        }
        return byDestino.get(key);
    };

    for (const row of directRows) {
        ensureEntry(row.destino).compraDirecto = {
            registros: Number(row.registros || 0),
            toneladas: roundToCurrency(row.toneladas || 0),
            monto: roundToCurrency(row.monto || 0)
        };
    }
    for (const row of ventaRows) {
        ensureEntry(row.destino).venta = {
            registros: Number(row.registros || 0),
            toneladas: roundToCurrency(row.toneladas || 0),
            monto: roundToCurrency(row.monto || 0)
        };
    }

    return Array.from(byDestino.values())
        .map(entry => ({
            ...entry,
            diferenciaToneladasDirecto: roundToCurrency(entry.venta.toneladas - entry.compraDirecto.toneladas),
            margenDirecto: roundToCurrency(entry.venta.monto - entry.compraDirecto.monto)
        }))
        .sort((a, b) => a.destino.localeCompare(b.destino));
}

async function buildOverviewSummary(start, end) {
    const inHouse = await db.get(`
        SELECT COUNT(*) AS registros,
               COALESCE(SUM(neto), 0) AS libras,
               COALESCE(SUM(total), 0) AS monto
        FROM transacciones
        WHERE fecha BETWEEN ? AND ?
    `, [start, end]);

    // Excludes es_producto_propio receipts: those are paperwork for fruit
    // already weighed/paid at our own Acopio scale (transacciones), so
    // counting them here too would double-count Compra Total de Palma.
    const direct = await db.get(`
        SELECT COUNT(*) AS registros,
               COALESCE(SUM(toneladas), 0) AS toneladas,
               COALESCE(SUM(total), 0) AS monto
        FROM corapsa
        WHERE fecha BETWEEN ? AND ? AND es_producto_propio = 0
    `, [start, end]);

    const expenses = await db.get(`
        SELECT COUNT(*) AS registros,
               COALESCE(SUM(monto), 0) AS monto
        FROM gastos
        WHERE fecha BETWEEN ? AND ?
    `, [start, end]);

    const payrollRows = await db.all(`
        SELECT p.id, p.sueldo_base,
               COALESCE(SUM(CASE WHEN a.trabajado = 1 THEN 1 ELSE 0 END), 0) AS dias
        FROM planilla p
        LEFT JOIN planilla_asistencia a
          ON a.trabajador_id = p.id
         AND a.fecha BETWEEN ? AND ?
        GROUP BY p.id, p.sueldo_base
    `, [start, end]);

    // Overlap (not full containment) so a period spanning a report-range
    // boundary still counts in every range it touches, instead of vanishing
    // from both when neither range fully contains it.
    const payrollExtras = await db.get(`
        SELECT COALESCE(SUM(extras), 0) AS monto
        FROM planilla_periodos
        WHERE fecha_fin >= ? AND fecha_inicio <= ?
    `, [start, end]);

    const statementRows = await db.all(`
        SELECT id, fecha_pago, periodo_inicio, periodo_fin, referencia, destino,
               toneladas, monto, notas, file_name, file_mime_type,
               (file_key IS NOT NULL OR LENGTH(file_data) > 0) AS has_file, created_at, updated_at
        FROM corapsa_pagos
        WHERE periodo_fin >= ? AND periodo_inicio <= ?
        ORDER BY periodo_inicio DESC, periodo_fin DESC, id DESC
    `, [start, end]);

    const directByDestino = await db.all(`
        SELECT destino, COUNT(*) AS registros,
               COALESCE(SUM(toneladas), 0) AS toneladas,
               COALESCE(SUM(total), 0) AS monto
        FROM corapsa
        WHERE fecha BETWEEN ? AND ? AND es_producto_propio = 0
        GROUP BY destino
    `, [start, end]);

    const ventaByDestino = await db.all(`
        SELECT destino, COUNT(*) AS registros,
               COALESCE(SUM(toneladas), 0) AS toneladas,
               COALESCE(SUM(monto), 0) AS monto
        FROM corapsa_pagos
        WHERE periodo_fin >= ? AND periodo_inicio <= ?
        GROUP BY destino
    `, [start, end]);

    const inHouseLbs = Number(inHouse?.libras || 0);
    const inHouseTons = truncateToDecimals(inHouseLbs / LBS_PER_METRIC_TON, 2);
    const inHouseMoney = roundToCurrency(inHouse?.monto || 0);
    const directTons = roundToCurrency(direct?.toneladas || 0);
    const directMoney = roundToCurrency(direct?.monto || 0);
    const trackedTons = roundToCurrency(inHouseTons + directTons);
    const supplierCost = roundToCurrency(inHouseMoney + directMoney);

    const payrollBase = payrollRows.reduce((sum, row) => {
        return sum + ((Number(row.sueldo_base || 0) / 6) * Number(row.dias || 0));
    }, 0);
    const payrollMoney = roundToCurrency(payrollBase + Number(payrollExtras?.monto || 0));
    const expenseMoney = roundToCurrency(expenses?.monto || 0);

    const statements = statementRows.map(mapCorapsaPayment);
    const corapsaTons = roundToCurrency(statements.reduce((sum, row) => sum + row.toneladas, 0));
    const corapsaRevenue = roundToCurrency(statements.reduce((sum, row) => sum + row.monto, 0));

    const tonDifference = roundToCurrency(corapsaTons - trackedTons);
    const grossMargin = roundToCurrency(corapsaRevenue - supplierCost);
    const operatingCosts = roundToCurrency(expenseMoney + payrollMoney);
    const netProfit = roundToCurrency(grossMargin - operatingCosts);

    return {
        inicio: start,
        fin: end,
        comprasInternas: {
            registros: Number(inHouse?.registros || 0),
            libras: inHouseLbs,
            toneladas: inHouseTons,
            monto: inHouseMoney
        },
        comprasDirectas: {
            registros: Number(direct?.registros || 0),
            toneladas: directTons,
            monto: directMoney
        },
        productoRastreado: {
            toneladas: trackedTons,
            montoPagadoProveedores: supplierCost
        },
        corapsaPagado: {
            registros: statements.length,
            toneladas: corapsaTons,
            monto: corapsaRevenue
        },
        conciliacion: {
            diferenciaToneladas: tonDifference,
            margenBruto: grossMargin
        },
        gastos: {
            registros: Number(expenses?.registros || 0),
            monto: expenseMoney
        },
        planilla: {
            monto: payrollMoney,
            basePorAsistencia: roundToCurrency(payrollBase),
            extras: roundToCurrency(payrollExtras?.monto || 0)
        },
        resultado: {
            costosOperativos: operatingCosts,
            utilidadNeta: netProfit
        },
        pagosCorapsa: statements,
        porDestino: buildDestinoBreakdown(directByDestino, ventaByDestino)
    };
}

function validateCorapsaPaymentBody(body, { editing = false } = {}) {
    const periodoInicio = asIsoDate(body?.periodoInicio, 'La fecha inicial del período');
    const periodoFin = asIsoDate(body?.periodoFin, 'La fecha final del período');
    if (periodoInicio > periodoFin) {
        throw new HttpError(400, 'La fecha inicial del período no puede ser posterior a la fecha final.', 'VALIDATION_ERROR');
    }

    return {
        fechaPago: asIsoDate(body?.fechaPago, 'La fecha de pago'),
        periodoInicio,
        periodoFin,
        referencia: asText(body?.referencia, { maxLength: 150 }),
        destino: asDestino(body?.destino),
        toneladas: asNumber(body?.toneladas, { required: true, min: 0.01, field: 'Las toneladas pagadas' }),
        monto: asNumber(body?.monto, { required: true, min: 0.01, max: MAX_MONEY_LEMPIRAS, field: 'El monto pagado por Corapsa' }),
        notas: asText(body?.notas, { maxLength: 1000 }),
        justificacion: editing ? requireJustification(body) : ''
    };
}

// Cap on rows returned by GET /api/auditoria, so a wide date range can't
// pull the whole log into the renderer at once.
const AUDIT_PAGE_LIMIT = 1000;

// Fields that move on every write (or that are themselves the audit metadata)
// and would otherwise show up as noise in every single change list.
const AUDIT_IGNORED_FIELDS = new Set(['updatedAt', 'createdAt', 'justificacion']);

function auditValuesEqual(a, b) {
    // Numbers round-trip through Number()/REAL storage, so an untouched weight
    // can come back as 12000.0000000001 and read as an edit without a tolerance.
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.0001;
    return (a ?? '') === (b ?? '');
}

// Compares two mapper-shaped snapshots and returns only the fields that
// actually moved, as [{ campo, antes, despues }]. Used both when writing an
// audit row (to record which fields were touched) and when reading it back.
function diffSnapshots(before, after) {
    if (!before || !after) return [];
    const changes = [];
    for (const campo of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (AUDIT_IGNORED_FIELDS.has(campo)) continue;
        if (auditValuesEqual(before[campo], after[campo])) continue;
        changes.push({ campo, antes: before[campo] ?? null, despues: after[campo] ?? null });
    }
    return changes;
}

// Local wall-clock 'YYYY-MM-DD HH:MM:SS'. See auditoria.registrado_en in
// database.js for why CURRENT_TIMESTAMP alone is not enough.
function localTimestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// "before"/"after" are snapshots taken from the same mapper the API serves
// (mapTransaction, mapCorapsa, ...), which already omit BLOB columns. Pass
// both on an edit; pass "before" alone on a delete so the removed row stays
// recoverable. "details" is kept for the rows written before snapshots existed.
async function logAudit({ entity, entityId, action, justification = '', details = null, before = null, after = null }) {
    const campos = diffSnapshots(before, after).map(change => change.campo);
    const despuesJson = after ? JSON.stringify(after) : null;
    const detallesJson = details ? JSON.stringify(details) : null;
    await db.run(
        `INSERT INTO auditoria (entidad, entidad_id, accion, justificacion, detalles, datos_antes, datos_despues, campos_cambiados, registrado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entity,
            entityId == null ? null : String(entityId),
            action,
            justification,
            // Most edit call sites pass the same object as both "details" and
            // "after"; storing it twice would double every audit row for
            // nothing. Kept only when it carries something extra, like the
            // request-level context on actualizar_parcial.
            detallesJson === despuesJson ? null : detallesJson,
            before ? JSON.stringify(before) : null,
            despuesJson,
            campos.join(','),
            localTimestamp()
        ]
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

// Pure JSON API with no browser-rendered HTML of its own, so helmet's default
// header set (no CSP needed) is enough defense-in-depth against the usual
// response-header-based attacks with zero configuration cost.
const apiLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    // Generous enough for real terminal usage (polling + normal CRUD) but caps
    // what a leaked API_KEY (see requireApiKey above — trivial to extract from
    // a packaged Electron installer) could scrape or abuse from one source.
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    // Keys on the API key when present so every terminal sharing one office IP
    // isn't throttled as a single client; falls back to IP for unauthenticated
    // requests (relevant once API_KEY is actually set).
    keyGenerator: (req) => req.get('X-API-Key') || req.ip,
    handler: (_req, res) => {
        res.status(429).json({
            ok: false,
            error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes. Intente de nuevo en unos minutos.', details: null }
        });
    }
});

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors(corsOptions));
app.use('/api', apiLimiter);
// Auth runs before the body parser so an unauthenticated request (or, once
// API_KEY is set, any request with a bad key) is rejected off req.method/path
// alone and never gets its body buffered into memory. With API_KEY unset
// (current MVP default) this middleware still passes everything through —
// reordering doesn't add auth that isn't configured — but it closes the gap
// for any deployment that does set API_KEY, and avoids paying the parse cost
// on requests that were always going to be rejected.
app.use(requireApiKey);
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(serializeDatabaseAccess);

app.get('/api/health', (_req, res) => {
    sendData(res, { status: 'ok' });
});

// COMPANIES (destino options for Recibos Externos)
app.get('/api/companies', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM companies ORDER BY nombre ASC');
    sendData(res, rows.map(mapCompany));
}));

app.post('/api/companies', asyncHandler(async (req, res) => {
    const nombre = asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 80 }).toUpperCase();

    const company = await withTransaction(async () => {
        const existing = await db.get('SELECT id FROM companies WHERE UPPER(nombre) = ?', [nombre]);
        if (existing) throw new HttpError(409, 'Esa empresa ya existe.', 'COMPANY_EXISTS');

        const result = await db.run('INSERT INTO companies (nombre) VALUES (?)', [nombre]);
        const row = await db.get('SELECT * FROM companies WHERE id = ?', [result.lastID]);
        await logAudit({ entity: 'company', entityId: result.lastID, action: 'crear', details: { nombre } });
        return mapCompany(row);
    });

    sendData(res, { company }, 201);
}));

app.put('/api/companies/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const nombre = asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 80 }).toUpperCase();

    const company = await withTransaction(async () => {
        const existing = await db.get('SELECT id FROM companies WHERE UPPER(nombre) = ? AND id != ?', [nombre, id]);
        if (existing) throw new HttpError(409, 'Esa empresa ya existe.', 'COMPANY_EXISTS');

        // Snapshot inside the transaction, before the UPDATE, so a concurrent
        // write can't slip between the read and the change being audited.
        const previo = await db.get('SELECT * FROM companies WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Empresa no encontrada.', 'NOT_FOUND');
        const antes = mapCompany(previo);

        const result = await db.run('UPDATE companies SET nombre = ? WHERE id = ?', [nombre, id]);
        if (!result.changes) throw new HttpError(404, 'Empresa no encontrada.', 'NOT_FOUND');

        const row = await db.get('SELECT * FROM companies WHERE id = ?', [id]);
        const despues = mapCompany(row);
        await logAudit({ entity: 'company', entityId: id, action: 'editar', justification: justificacion, details: despues, before: antes, after: despues });
        return despues;
    });

    sendData(res, { company });
}));

app.delete('/api/companies/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);

    await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM companies WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Empresa no encontrada.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM companies WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Empresa no encontrada.', 'NOT_FOUND');
        await logAudit({ entity: 'company', entityId: id, action: 'eliminar', justification: justificacion, before: mapCompany(previo) });
    });

    sendData(res, { id });
}));

// CLIENTES
app.get('/api/clientes', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM clientes ORDER BY id DESC');
    sendData(res, rows.map(mapClient));
}));

app.post('/api/clientes/ajuste-global', asyncHandler(async (req, res) => {
    const montoTonelada = asNumber(req.body?.montoTonelada ?? req.body?.monto, {
        required: true,
        min: -MAX_MONEY_LEMPIRAS,
        max: MAX_MONEY_LEMPIRAS,
        field: 'El monto por tonelada'
    });
    const razon = requireJustification(req.body);
    if (montoTonelada === 0) {
        throw new HttpError(400, 'El monto del ajuste no puede ser cero.', 'VALIDATION_ERROR');
    }

    const categoria = String(req.body?.categoria || 'global').toLowerCase();
    if (!VALID_AJUSTE_CATEGORIAS.has(categoria)) {
        throw new HttpError(400, 'La categoría del ajuste no es válida.', 'VALIDATION_ERROR');
    }
    const applyAcopio = categoria === 'global' || categoria === 'acopio';
    const applyDirecto = categoria === 'global' || categoria === 'directo';

    const clientes = await withTransaction(async () => {
        const rows = await db.all('SELECT * FROM clientes ORDER BY id DESC');
        const updates = rows.map(row => {
            const rowCategoria = VALID_CLIENT_CATEGORIAS.has(row.categoria) ? row.categoria : 'ambos';
            // A client only receives the slice of the adjustment that matches their
            // own categoria — e.g. an Acopio-only client is untouched by a Directo
            // adjustment, even when the adjustment itself is scoped to 'global'.
            const doAcopio = applyAcopio && rowCategoria !== 'directo';
            const doDirecto = applyDirecto && rowCategoria !== 'acopio';
            if (!doAcopio && !doDirecto) return null;

            const update = { id: row.id, doAcopio, doDirecto };

            if (doAcopio) {
                const precioToneladaPropio = roundToCurrency(getStoredTonPrice(row, 'Propio') + montoTonelada);
                const precioToneladaCliente = roundToCurrency(getStoredTonPrice(row, 'Cliente') + montoTonelada);

                if (precioToneladaPropio < 0 || precioToneladaCliente < 0) {
                    throw new HttpError(
                        409,
                        `El ajuste de Acopio dejaría un precio negativo para ${row.nombre}.`,
                        'NEGATIVE_PRICE'
                    );
                }

                const unidad = row.unidad === 'quintal' ? 'quintal' : 'tonelada';
                update.precioToneladaPropio = precioToneladaPropio;
                update.precioToneladaCliente = precioToneladaCliente;
                update.precioFletePropio = unidad === 'quintal'
                    ? roundToNearestWhole(precioToneladaPropio / QUINTALES_PER_TON)
                    : precioToneladaPropio;
                update.precioFleteCliente = unidad === 'quintal'
                    ? roundToNearestWhole(precioToneladaCliente / QUINTALES_PER_TON)
                    : precioToneladaCliente;
            }

            if (doDirecto) {
                const precioToneladaDirecto = roundToCurrency(getStoredDirectoPrice(row) + montoTonelada);

                if (precioToneladaDirecto < 0) {
                    throw new HttpError(
                        409,
                        `El ajuste Directo dejaría un precio negativo para ${row.nombre}.`,
                        'NEGATIVE_PRICE'
                    );
                }

                update.precioToneladaDirecto = precioToneladaDirecto;
            }

            return update;
        }).filter(Boolean);

        if (!updates.length) {
            throw new HttpError(409, 'No hay clientes registrados en la categoría seleccionada.', 'NO_MATCHING_CLIENTS');
        }

        for (const update of updates) {
            const sets = [];
            const params = [];

            if (update.doAcopio) {
                sets.push('precio_flete_propio = ?', 'precio_flete_cliente = ?', 'precio_tonelada_propio = ?', 'precio_tonelada_cliente = ?');
                params.push(update.precioFletePropio, update.precioFleteCliente, update.precioToneladaPropio, update.precioToneladaCliente);
            }
            if (update.doDirecto) {
                sets.push('precio_tonelada_directo = ?');
                params.push(update.precioToneladaDirecto);
            }
            sets.push('updated_at = CURRENT_TIMESTAMP');
            params.push(update.id);

            await db.run(`UPDATE clientes SET ${sets.join(', ')} WHERE id = ?`, params);
        }

        await logAudit({
            entity: 'clientes',
            action: 'ajuste_global',
            justification: razon,
            details: { montoTonelada, categoria, clientesAfectados: updates.length, formulaQuintal: 'roundToNearestWhole(precioTonelada / 22.04)' }
        });

        return (await db.all('SELECT * FROM clientes ORDER BY id DESC')).map(mapClient);
    });

    sendData(res, { clientes });
}));

app.post('/api/clientes', asyncHandler(async (req, res) => {
    const unidad = asUnit(req.body?.unidad);
    const categoria = asClientCategoria(req.body?.categoria);
    const pricing = buildClientPricing(req.body, unidad, categoria);
    const justificacion = asText(req.body?.justificacion, { maxLength: 500 });
    const client = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { field: 'El apellido', maxLength: 120 }),
        telefono: asText(req.body?.telefono, { field: 'El teléfono', maxLength: 40 }),
        ubicacion: asText(req.body?.ubicacion, { field: 'La ubicación', maxLength: 200 }),
        identidad: asText(req.body?.identidad, { field: 'La identidad', maxLength: 40 }),
        unidad,
        categoria,
        ...pricing
    };

    const cliente = await withTransaction(async () => {
        const result = await db.run(`
            INSERT INTO clientes (
                nombre, apellido, telefono, ubicacion, identidad,
                precio_flete_propio, precio_flete_cliente,
                precio_tonelada_propio, precio_tonelada_cliente, precio_tonelada_directo,
                unidad, categoria, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            client.nombre,
            client.apellido,
            client.telefono,
            client.ubicacion,
            client.identidad,
            client.precioFletePropio,
            client.precioFleteCliente,
            client.precioToneladaPropio,
            client.precioToneladaCliente,
            client.precioToneladaDirecto,
            client.unidad,
            client.categoria
        ]);
        const row = await db.get('SELECT * FROM clientes WHERE id = ?', [result.lastID]);
        await logAudit({ entity: 'cliente', entityId: result.lastID, action: 'crear', justification: justificacion, details: client });
        return mapClient(row);
    });
    sendData(res, { cliente }, 201);
}));

app.put('/api/clientes/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const unidad = asUnit(req.body?.unidad);
    const categoria = asClientCategoria(req.body?.categoria);
    const pricing = buildClientPricing(req.body, unidad, categoria);
    const client = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { field: 'El apellido', maxLength: 120 }),
        telefono: asText(req.body?.telefono, { field: 'El teléfono', maxLength: 40 }),
        ubicacion: asText(req.body?.ubicacion, { field: 'La ubicación', maxLength: 200 }),
        identidad: asText(req.body?.identidad, { field: 'La identidad', maxLength: 40 }),
        unidad,
        categoria,
        ...pricing
    };

    const cliente = await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');
        const antes = mapClient(previo);

        const result = await db.run(`
            UPDATE clientes
            SET nombre = ?, apellido = ?, telefono = ?, ubicacion = ?, identidad = ?,
                precio_flete_propio = ?, precio_flete_cliente = ?,
                precio_tonelada_propio = ?, precio_tonelada_cliente = ?, precio_tonelada_directo = ?,
                unidad = ?, categoria = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            client.nombre,
            client.apellido,
            client.telefono,
            client.ubicacion,
            client.identidad,
            client.precioFletePropio,
            client.precioFleteCliente,
            client.precioToneladaPropio,
            client.precioToneladaCliente,
            client.precioToneladaDirecto,
            client.unidad,
            client.categoria,
            id
        ]);
        if (!result.changes) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');

        // Keeps any truck already in the yard queue for this client in sync with
        // the price just saved — otherwise it stays snapshotted at the old price
        // (wrong or not) until finalized, even though Clientes now shows the new one.
        await db.run(
            `UPDATE camiones_en_patio
             SET precio_aplicado = CASE WHEN flete = 'Propio' THEN ? ELSE ? END
             WHERE cliente_id = ?`,
            [client.precioFletePropio, client.precioFleteCliente, String(id)]
        );

        const row = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
        const despues = mapClient(row);
        await logAudit({ entity: 'cliente', entityId: id, action: 'editar', justification: justificacion, details: despues, before: antes, after: despues });
        return despues;
    });
    sendData(res, { cliente });
}));

app.delete('/api/clientes/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);

    await withTransaction(async () => {
        const queued = await db.get('SELECT id FROM camiones_en_patio WHERE cliente_id = ? LIMIT 1', [String(id)]);
        if (queued) throw new HttpError(409, 'No puede eliminarse un cliente con un vehículo activo en patio.', 'CLIENT_IN_USE');

        const previo = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM clientes WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');
        await logAudit({ entity: 'cliente', entityId: id, action: 'eliminar', justification: justificacion, before: mapClient(previo) });
    });
    sendData(res, { id });
}));

// Lets the Pesaje tab correct a client's applied price without navigating to Gestión > Clientes.
// Always updates the client's stored price (source of truth for future trucks); if a truck for
// this same client/flete is currently open in the yard queue, its snapshot is synced too so the
// weighing screen's totals reflect the new price immediately.
app.patch('/api/clientes/:id/precio', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const flete = asFreightType(req.body?.flete);
    const justificacion = requireJustification(req.body);
    const nuevoPrecio = asNumber(req.body?.precio, { required: true, min: 0, max: MAX_MONEY_LEMPIRAS, field: 'El precio' });
    const truckIdRaw = req.body?.truckId;
    const truckId = truckIdRaw === null || truckIdRaw === undefined || truckIdRaw === ''
        ? null
        : String(truckIdRaw).trim();

    const result = await withTransaction(async () => {
        const clientRow = await db.get('SELECT * FROM clientes WHERE id = ?', [id]);
        if (!clientRow) throw new HttpError(404, 'Cliente no encontrado.', 'NOT_FOUND');

        const unidad = clientRow.unidad === 'quintal' ? 'quintal' : 'tonelada';
        const precioAnteriorTonelada = getStoredTonPrice(clientRow, flete);
        const precioUnidad = unidad === 'quintal' ? roundToNearestWhole(nuevoPrecio) : roundToCurrency(nuevoPrecio);
        // Editing in Pesaje always edits the price actually charged (precioUnidad). When the
        // client bills by quintal, the base ton price is derived FROM it (the reverse of the
        // Clientes form, where ton price is entered and quintal is suggested from it) so the two
        // stay consistent.
        const precioTonelada = unidad === 'quintal'
            ? roundToCurrency(precioUnidad * QUINTALES_PER_TON)
            : precioUnidad;

        if (flete === 'Cliente') {
            await db.run(
                `UPDATE clientes SET precio_flete_cliente = ?, precio_tonelada_cliente = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [precioUnidad, precioTonelada, id]
            );
        } else {
            await db.run(
                `UPDATE clientes SET precio_flete_propio = ?, precio_tonelada_propio = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [precioUnidad, precioTonelada, id]
            );
        }

        const antes = mapClient(clientRow);
        const cliente = mapClient(await db.get('SELECT * FROM clientes WHERE id = ?', [id]));

        let camion = null;
        if (truckId) {
            const truckRow = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [truckId]);
            if (truckRow && String(truckRow.cliente_id) === String(id) && truckRow.flete === flete) {
                await db.run('UPDATE camiones_en_patio SET precio_aplicado = ? WHERE id = ?', [precioUnidad, truckId]);
                camion = mapTruck(await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [truckId]));
            }
        }

        await logAudit({
            entity: 'cliente',
            entityId: id,
            action: 'editar_precio_pesaje',
            justification: justificacion,
            details: { flete, unidad, precioAnteriorTonelada, precioNuevo: precioUnidad, precioTonelada, truckId },
            before: antes,
            after: cliente
        });

        return { cliente, camion };
    });

    sendData(res, result);
}));

// CAMIONES EN PATIO
app.get('/api/camiones-patio', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM camiones_en_patio ORDER BY created_at ASC, id ASC');
    sendData(res, rows.map(mapTruck));
}));

app.post('/api/camiones-patio', asyncHandler(async (req, res) => {
    const clientOpId = asText(req.body?.clientOpId, { field: 'El identificador de operación', maxLength: 100 }) || null;
    if (clientOpId) {
        const already = await db.get('SELECT * FROM camiones_en_patio WHERE client_op_id = ?', [clientOpId]);
        if (already) return sendData(res, { camion: mapTruck(already) }, 200);
    }

    const clienteIdRaw = req.body?.clienteId;
    if (clienteIdRaw === null || clienteIdRaw === undefined || clienteIdRaw === '') {
        throw new HttpError(400, 'El cliente es obligatorio.', 'VALIDATION_ERROR');
    }

    const flete = asFreightType(req.body?.flete);
    const pesoBruto = asNumber(req.body?.pesoBruto, { min: 0.01, max: MAX_WEIGHT_LBS, field: 'El peso bruto' });
    const pesoTara = asNumber(req.body?.pesoTara, { min: 0.01, max: MAX_WEIGHT_LBS, field: 'El peso tara' });
    if (pesoBruto == null && pesoTara == null) {
        throw new HttpError(400, 'Debe registrar al menos un peso.', 'VALIDATION_ERROR');
    }

    // Captured client-side (same getLocalIsoDate()/getLocalTimeString() pair
    // used at finalize) so entrada and salida timestamps are both local time,
    // rather than mixing in SQLite's UTC-based CURRENT_TIMESTAMP.
    const fechaEntrada = asIsoDate(req.body?.fecha, 'La fecha');
    const horaEntrada = asText(req.body?.hora, { required: true, field: 'La hora', maxLength: 20 });

    let clienteId;
    let clienteNombreSnapshot;
    let identidadSnapshot;
    let casualSnapshot = null;
    let precioAplicado;
    let unidad;

    if (String(clienteIdRaw) === 'casual') {
        const snapshot = req.body?.casualSnapshot || {};
        clienteId = 'casual';
        clienteNombreSnapshot = asText(snapshot.nombre, { required: true, field: 'El nombre casual', maxLength: 200 });
        identidadSnapshot = asText(snapshot.identidad, { field: 'La identidad casual', maxLength: 40 });
        unidad = asUnit(snapshot.unidad);
        const ownPrice = asNumber(snapshot.precioFletePropio, { required: true, min: 0, max: MAX_MONEY_LEMPIRAS, field: 'El precio casual' });
        const clientPrice = asNumber(snapshot.precioFleteCliente, { required: true, min: 0, max: MAX_MONEY_LEMPIRAS, field: 'El precio casual' });
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
        identidadSnapshot = client.identidad;
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
                peso_bruto, peso_tara, precio_aplicado, unidad, casual_snapshot,
                fecha_entrada, hora_entrada, identidad_snapshot, client_op_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
            casualSnapshot ? JSON.stringify(casualSnapshot) : null,
            fechaEntrada,
            horaEntrada,
            identidadSnapshot,
            clientOpId
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

    const pesoBruto = hasBruto ? asNumber(req.body.pesoBruto, { required: true, min: 0.01, max: MAX_WEIGHT_LBS, field: 'El peso bruto' }) : null;
    const pesoTara = hasTara ? asNumber(req.body.pesoTara, { required: true, min: 0.01, max: MAX_WEIGHT_LBS, field: 'El peso tara' }) : null;
    // Only required when overwriting an already-set peso_bruto (checked below, inside the transaction).
    const justificacion = asText(req.body?.justificacion ?? req.body?.razon, { maxLength: 500 });

    const truck = await withTransaction(async () => {
        const current = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        if (!current) throw new HttpError(404, 'Camión no encontrado en la cola.', 'NOT_FOUND');

        const overwritingBruto = hasBruto && current.peso_bruto != null;
        if (overwritingBruto && !justificacion) {
            throw new HttpError(
                409,
                'El peso bruto ya está registrado. Incluya una justificación para sobrescribirlo.',
                'GROSS_WEIGHT_LOCKED'
            );
        }

        const antes = mapTruck(await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]));

        if (hasBruto) await db.run('UPDATE camiones_en_patio SET peso_bruto = ? WHERE id = ?', [pesoBruto, id]);
        if (hasTara) await db.run('UPDATE camiones_en_patio SET peso_tara = ? WHERE id = ?', [pesoTara, id]);

        const row = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        const mappedTruck = mapTruck(row);
        await logAudit({
            entity: 'camion_patio',
            entityId: id,
            action: overwritingBruto ? 'sobrescribir_peso_bruto' : 'actualizar_peso',
            justification: overwritingBruto ? justificacion : '',
            details: { pesoBruto, pesoTara },
            before: antes,
            after: mappedTruck
        });
        return mappedTruck;
    });

    sendData(res, { camion: truck });
}));

app.post('/api/camiones-patio/:id/finalizar', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const fecha = asIsoDate(req.body?.fecha, 'La fecha');
    const hora = asText(req.body?.hora, { required: true, field: 'La hora', maxLength: 20 });
    const clientOpId = asText(req.body?.clientOpId, { field: 'El identificador de operación', maxLength: 100 }) || null;

    const transaction = await withTransaction(async () => {
        // Replay of an op whose earlier attempt already landed (the client
        // timed out waiting for the response, or the connection dropped right
        // after the server committed): return the transaction it already
        // created instead of re-running the finalize, which would either
        // double-insert or 404 on the patio row this same op already deleted.
        if (clientOpId) {
            const already = await db.get('SELECT * FROM transacciones WHERE client_op_id = ?', [clientOpId]);
            if (already) return mapTransaction(already);
        }

        const truck = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        if (!truck) throw new HttpError(404, 'Camión no encontrado para finalizar.', 'NOT_FOUND');
        if (truck.peso_bruto == null || truck.peso_tara == null) {
            throw new HttpError(409, 'La transacción no tiene ambos pesos.', 'MISSING_WEIGHT');
        }

        const pesoBrutoFinal = Number(truck.peso_bruto);
        const pesoTaraFinal = Number(truck.peso_tara);
        if (pesoBrutoFinal < pesoTaraFinal) {
            throw new HttpError(409, 'El peso bruto no puede ser menor que el peso tara. Verifique si los pesos fueron capturados invertidos.', 'INVALID_WEIGHT_ORDER');
        }
        const neto = pesoBrutoFinal - pesoTaraFinal;
        if (neto <= 0) throw new HttpError(409, 'El peso neto debe ser mayor que cero.', 'INVALID_NET_WEIGHT');
        const unidad = truck.unidad === 'quintal' ? 'quintal' : 'tonelada';
        const cantidadFacturable = calculateBillableQuantity(neto, unidad);
        const total = roundToCurrency(cantidadFacturable * Number(truck.precio_aplicado || 0));

        const nextBoletaRow = await db.get('SELECT COALESCE(MAX(numero_boleta), 0) + 1 AS next FROM transacciones');
        const numeroBoleta = Number(nextBoletaRow.next);

        const insertResult = await db.run(`
            INSERT INTO transacciones (
                fecha, hora, fecha_entrada, hora_entrada, placa, conductor, cliente_nombre, identidad,
                numero_boleta, peso_bruto, peso_tara, neto, precio_aplicado, total, unidad, client_op_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
            fecha, hora, truck.fecha_entrada || fecha, truck.hora_entrada || hora,
            truck.placa, truck.conductor,
            truck.cliente_nombre_snapshot || 'Cliente no disponible',
            truck.identidad_snapshot || '',
            numeroBoleta,
            truck.peso_bruto, truck.peso_tara, neto, truck.precio_aplicado, total, unidad, clientOpId
        ]);
        const transactionId = insertResult.lastID;
        await db.run('DELETE FROM camiones_en_patio WHERE id = ?', [id]);
        // Passing the finished transaction as "after" is what lets Historial de
        // Cambios show the values the boleta was created with, instead of just
        // the queue id it came from.
        const creada = mapTransaction(await db.get('SELECT * FROM transacciones WHERE id = ?', [transactionId]));
        await logAudit({
            entity: 'transaccion',
            entityId: transactionId,
            action: 'finalizar',
            details: { queueId: id },
            after: creada
        });
        return mapTransaction(await db.get('SELECT * FROM transacciones WHERE id = ?', [transactionId]));
    });

    sendData(res, { transaccion: transaction });
}));

app.delete('/api/camiones-patio/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM camiones_en_patio WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Vehículo no encontrado.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM camiones_en_patio WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Vehículo no encontrado.', 'NOT_FOUND');
        await logAudit({ entity: 'camion_patio', entityId: id, action: 'eliminar', justification: justificacion, before: mapTruck(previo) });
    });
    sendData(res, { id });
}));

// TRANSACCIONES
app.get('/api/transacciones', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM transacciones ORDER BY id DESC');
    sendData(res, rows.map(mapTransaction));
}));

app.put('/api/transacciones/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);

    const fecha = asIsoDate(req.body?.fecha, 'La fecha');
    const hora = asText(req.body?.hora, { required: true, field: 'La hora', maxLength: 20 });
    const placa = asText(req.body?.placa, { field: 'La placa', maxLength: 30 }) || 'S/P';
    const conductor = asText(req.body?.conductor, { field: 'El conductor', maxLength: 150 }) || 'Desconocido';
    const clienteNombre = asText(req.body?.clienteNombre, { required: true, field: 'El nombre del cliente', maxLength: 200 });
    const unidad = asUnit(req.body?.unidad);
    const pesoBruto = asNumber(req.body?.pesoBruto, { required: true, min: 0.01, max: MAX_WEIGHT_LBS, field: 'El peso bruto' });
    const pesoTara = asNumber(req.body?.pesoTara, { required: true, min: 0.01, max: MAX_WEIGHT_LBS, field: 'El peso tara' });
    const precioAplicado = asNumber(req.body?.precioAplicado, { required: true, min: 0, max: MAX_MONEY_LEMPIRAS, field: 'El precio aplicado' });
    const numeroBoletaRaw = asNumber(req.body?.numeroBoleta, { required: true, min: 1, field: 'El número de boleta' });
    if (!Number.isInteger(numeroBoletaRaw)) throw new HttpError(400, 'El número de boleta no es válido.', 'VALIDATION_ERROR');

    if (pesoBruto < pesoTara) {
        throw new HttpError(409, 'El peso bruto no puede ser menor que el peso tara. Verifique si los pesos fueron capturados invertidos.', 'INVALID_WEIGHT_ORDER');
    }
    const neto = pesoBruto - pesoTara;
    if (neto <= 0) throw new HttpError(409, 'El peso neto debe ser mayor que cero.', 'INVALID_NET_WEIGHT');
    const total = roundToCurrency(calculateBillableQuantity(neto, unidad) * precioAplicado);

    const transaction = await withTransaction(async () => {
        const duplicate = await db.get(
            'SELECT id FROM transacciones WHERE numero_boleta = ? AND id != ?',
            [numeroBoletaRaw, id]
        );
        if (duplicate) throw new HttpError(409, 'Ya existe otra transacción con ese número de boleta.', 'DUPLICATE_BOLETA');

        const previo = await db.get('SELECT * FROM transacciones WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Transacción no encontrada.', 'NOT_FOUND');
        const antes = mapTransaction(previo);

        const result = await db.run(`
            UPDATE transacciones
            SET fecha = ?, hora = ?, placa = ?, conductor = ?, cliente_nombre = ?,
                peso_bruto = ?, peso_tara = ?, neto = ?, precio_aplicado = ?, total = ?, unidad = ?,
                numero_boleta = ?
            WHERE id = ?
        `, [fecha, hora, placa, conductor, clienteNombre, pesoBruto, pesoTara, neto, precioAplicado, total, unidad, numeroBoletaRaw, id]);
        if (!result.changes) throw new HttpError(404, 'Transacción no encontrada.', 'NOT_FOUND');

        const row = await db.get('SELECT * FROM transacciones WHERE id = ?', [id]);
        const despues = mapTransaction(row);
        await logAudit({ entity: 'transaccion', entityId: id, action: 'editar', justification: justificacion, details: despues, before: antes, after: despues });
        return despues;
    });

    sendData(res, { transaccion: transaction });
}));

app.delete('/api/transacciones/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM transacciones WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Transacción no encontrada.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM transacciones WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Transacción no encontrada.', 'NOT_FOUND');
        await logAudit({ entity: 'transaccion', entityId: id, action: 'eliminar', justification: justificacion, before: mapTransaction(previo) });
    });
    sendData(res, { id });
}));

// CORAPSA
app.get('/api/corapsa/:id/archivo/:type', asyncHandler(async (req, res) => {
    const type = req.params.type === 'nuestro' ? 'nuestro' : 'cliente';
    const row = await db.get(`
        SELECT file_name, file_mime_type, file_data, file_key,
               file_nuestro, file_nuestro_mime_type, file_nuestro_data, file_nuestro_key
        FROM corapsa WHERE id = ?
    `, [req.params.id]);
    if (!row) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');

    await respondWithAttachment(res, type === 'nuestro'
        ? { fileName: row.file_nuestro, mimeType: row.file_nuestro_mime_type, data: row.file_nuestro_data, key: row.file_nuestro_key }
        : { fileName: row.file_name, mimeType: row.file_mime_type, data: row.file_data, key: row.file_key });
}));

app.get('/api/corapsa', asyncHandler(async (_req, res) => {
    const rows = await db.all(`
        SELECT id, fecha, recibo_in, recibo_out, cliente, telefono, destino, a_nombre_de, toneladas, precio, total,
               file_name, file_mime_type, (file_key IS NOT NULL OR LENGTH(file_data) > 0) AS has_file,
               file_nuestro, file_nuestro_mime_type, (file_nuestro_key IS NOT NULL OR LENGTH(file_nuestro_data) > 0) AS has_file_nuestro,
               pagado, excluido, es_producto_propio, created_at, updated_at
        FROM corapsa
        ORDER BY fecha DESC, id DESC
    `);
    sendData(res, rows.map(mapCorapsa));
}));

app.post('/api/corapsa', asyncHandler(async (req, res) => {
    const fecha = asIsoDate(req.body?.fecha, 'La fecha');
    const reciboIn = asText(req.body?.reciboIn, { required: true, field: 'El recibo Corapsa', maxLength: 100 });
    const cliente = asText(req.body?.cliente, { required: true, field: 'El cliente', maxLength: 200 });
    const telefono = asText(req.body?.telefono, { field: 'El teléfono', maxLength: 40 });
    const destino = asDestino(req.body?.destino);
    const aNombreDe = asText(req.body?.aNombreDe, { field: 'El campo "A nombre de"', maxLength: 200 });
    const toneladas = asNumber(req.body?.toneladas, { required: true, min: 0.01, field: 'Las toneladas' });
    const precio = asNumber(req.body?.precio, { required: true, min: 0, max: MAX_MONEY_LEMPIRAS, field: 'El precio' });
    const total = roundToCurrency(toneladas * precio);
    const esProductoPropio = asBoolean(req.body?.esProductoPropio ?? false);
    const archivoCliente = await storeAttachment(
        'corapsa-cliente',
        parseAttachmentPayload(req.body?.archivoCliente, 'El archivo del cliente')
    );
    const archivoNuestro = await storeAttachment(
        'corapsa-nuestro',
        parseAttachmentPayload(req.body?.archivoNuestro, 'El archivo nuestro')
    );

    const corapsa = await withTransaction(async () => {
        const result = await db.run(`
            INSERT INTO corapsa (
                fecha, recibo_in, cliente, telefono, destino, a_nombre_de, toneladas, precio, total,
                file_name, file_mime_type, file_data, file_key,
                file_nuestro, file_nuestro_mime_type, file_nuestro_data, file_nuestro_key, pagado, es_producto_propio,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            fecha, reciboIn, cliente, telefono, destino, aNombreDe, toneladas, precio, total,
            archivoCliente?.fileName || 'Sin Archivo', archivoCliente?.mimeType || '', archivoCliente?.data || null, archivoCliente?.key || null,
            archivoNuestro?.fileName || 'Sin Archivo', archivoNuestro?.mimeType || '', archivoNuestro?.data || null, archivoNuestro?.key || null,
            asBoolean(req.body?.pagado ?? false) ? 1 : 0,
            esProductoPropio ? 1 : 0
        ]);

        const reciboOut = `CRX-${String(result.lastID).padStart(6, '0')}`;
        await db.run('UPDATE corapsa SET recibo_out = ? WHERE id = ?', [reciboOut, result.lastID]);
        const row = await db.get('SELECT * FROM corapsa WHERE id = ?', [result.lastID]);
        await logAudit({ entity: 'corapsa', entityId: result.lastID, action: 'crear', details: mapCorapsa(row) });
        return mapCorapsa(row);
    });
    sendData(res, { corapsa }, 201);
}));

app.put('/api/corapsa/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const current = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
    if (!current) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');

    const fecha = asIsoDate(req.body?.fecha, 'La fecha');
    const reciboIn = asText(req.body?.reciboIn, { required: true, field: 'El recibo Corapsa', maxLength: 100 });
    const cliente = asText(req.body?.cliente, { required: true, field: 'El cliente', maxLength: 200 });
    const telefono = asText(req.body?.telefono, { field: 'El teléfono', maxLength: 40 });
    const destino = asDestino(req.body?.destino);
    const aNombreDe = asText(req.body?.aNombreDe, { field: 'El campo "A nombre de"', maxLength: 200 });
    const toneladas = asNumber(req.body?.toneladas, { required: true, min: 0.01, field: 'Las toneladas' });
    const precio = asNumber(req.body?.precio, { required: true, min: 0, max: MAX_MONEY_LEMPIRAS, field: 'El precio' });
    const total = roundToCurrency(toneladas * precio);

    const hasClienteUpload = Object.prototype.hasOwnProperty.call(req.body || {}, 'archivoCliente');
    const hasNuestroUpload = Object.prototype.hasOwnProperty.call(req.body || {}, 'archivoNuestro');
    const archivoCliente = hasClienteUpload
        ? await storeAttachment('corapsa-cliente', parseAttachmentPayload(req.body.archivoCliente, 'El archivo del cliente'))
        : null;
    const archivoNuestro = hasNuestroUpload
        ? await storeAttachment('corapsa-nuestro', parseAttachmentPayload(req.body.archivoNuestro, 'El archivo nuestro'))
        : null;

    const corapsa = await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
        const antes = mapCorapsa(previo);

        await db.run(`
            UPDATE corapsa
            SET fecha = ?, recibo_in = ?, cliente = ?, telefono = ?, destino = ?, a_nombre_de = ?, toneladas = ?, precio = ?, total = ?,
                file_name = ?, file_mime_type = ?, file_data = ?, file_key = ?,
                file_nuestro = ?, file_nuestro_mime_type = ?, file_nuestro_data = ?, file_nuestro_key = ?,
                pagado = ?, es_producto_propio = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            fecha, reciboIn, cliente, telefono, destino, aNombreDe, toneladas, precio, total,
            hasClienteUpload ? archivoCliente.fileName : current.file_name,
            hasClienteUpload ? archivoCliente.mimeType : current.file_mime_type,
            hasClienteUpload ? archivoCliente.data : current.file_data,
            hasClienteUpload ? archivoCliente.key : current.file_key,
            hasNuestroUpload ? archivoNuestro.fileName : current.file_nuestro,
            hasNuestroUpload ? archivoNuestro.mimeType : current.file_nuestro_mime_type,
            hasNuestroUpload ? archivoNuestro.data : current.file_nuestro_data,
            hasNuestroUpload ? archivoNuestro.key : current.file_nuestro_key,
            Object.prototype.hasOwnProperty.call(req.body || {}, 'pagado') ? (asBoolean(req.body.pagado) ? 1 : 0) : current.pagado,
            Object.prototype.hasOwnProperty.call(req.body || {}, 'esProductoPropio') ? (asBoolean(req.body.esProductoPropio) ? 1 : 0) : current.es_producto_propio,
            id
        ]);

        const row = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
        const despues = mapCorapsa(row);
        await logAudit({ entity: 'corapsa', entityId: id, action: 'editar', justification: justificacion, details: despues, before: antes, after: despues });
        return despues;
    });

    if (hasClienteUpload && current.file_key) await storage.deleteObject(current.file_key);
    if (hasNuestroUpload && current.file_nuestro_key) await storage.deleteObject(current.file_nuestro_key);

    sendData(res, { corapsa });
}));

app.patch('/api/corapsa/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const current = await db.get('SELECT file_key, file_nuestro_key FROM corapsa WHERE id = ?', [id]);
    if (!current) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');

    // Setting and clearing the same attachment in one request would otherwise
    // silently drop the upload (both fragments assign the same SQL column;
    // the later one wins) while leaving the just-uploaded Spaces object
    // orphaned, since nothing in the DB ends up referencing its key.
    const setsCliente = Object.prototype.hasOwnProperty.call(req.body || {}, 'archivoCliente');
    const clearsCliente = req.body?.eliminarArchivoCliente === true || req.body?.fileName === 'Sin Archivo';
    if (setsCliente && clearsCliente) {
        throw new HttpError(400, 'No se puede adjuntar y eliminar el archivo del cliente en la misma solicitud.', 'VALIDATION_ERROR');
    }
    const setsNuestro = Object.prototype.hasOwnProperty.call(req.body || {}, 'archivoNuestro');
    const clearsNuestro = req.body?.eliminarArchivoNuestro === true || req.body?.fileNuestro === 'Sin Archivo';
    if (setsNuestro && clearsNuestro) {
        throw new HttpError(400, 'No se puede adjuntar y eliminar el archivo nuestro en la misma solicitud.', 'VALIDATION_ERROR');
    }

    const updates = [];
    const values = [];
    let oldClienteKeyToRemove = null;
    let oldNuestroKeyToRemove = null;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pagado')) {
        updates.push('pagado = ?');
        values.push(asBoolean(req.body.pagado) ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'excluido')) {
        updates.push('excluido = ?');
        values.push(asBoolean(req.body.excluido) ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'archivoCliente')) {
        const attachment = await storeAttachment('corapsa-cliente', parseAttachmentPayload(req.body.archivoCliente, 'El archivo del cliente'));
        updates.push('file_name = ?', 'file_mime_type = ?', 'file_data = ?', 'file_key = ?');
        values.push(attachment.fileName, attachment.mimeType, attachment.data, attachment.key);
        oldClienteKeyToRemove = current.file_key;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'archivoNuestro')) {
        const attachment = await storeAttachment('corapsa-nuestro', parseAttachmentPayload(req.body.archivoNuestro, 'El archivo nuestro'));
        updates.push('file_nuestro = ?', 'file_nuestro_mime_type = ?', 'file_nuestro_data = ?', 'file_nuestro_key = ?');
        values.push(attachment.fileName, attachment.mimeType, attachment.data, attachment.key);
        oldNuestroKeyToRemove = current.file_nuestro_key;
    }
    if (req.body?.eliminarArchivoCliente === true || req.body?.fileName === 'Sin Archivo') {
        updates.push("file_name = 'Sin Archivo'", "file_mime_type = ''", 'file_data = NULL', 'file_key = NULL');
        oldClienteKeyToRemove = current.file_key;
    }
    if (req.body?.eliminarArchivoNuestro === true || req.body?.fileNuestro === 'Sin Archivo') {
        updates.push("file_nuestro = 'Sin Archivo'", "file_nuestro_mime_type = ''", 'file_nuestro_data = NULL', 'file_nuestro_key = NULL');
        oldNuestroKeyToRemove = current.file_nuestro_key;
    }
    if (updates.length === 0) throw new HttpError(400, 'No hay campos válidos para actualizar.', 'VALIDATION_ERROR');

    values.push(id);
    const corapsa = await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
        const antes = mapCorapsa(previo);

        const result = await db.run(`UPDATE corapsa SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, values);
        if (!result.changes) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
        const row = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
        await logAudit({
            entity: 'corapsa', entityId: id, action: 'actualizar_parcial',
            justification: asText(req.body?.justificacion, { maxLength: 500 }),
            details: {
                pagado: req.body?.pagado,
                excluido: req.body?.excluido,
                archivoCliente: Boolean(req.body?.archivoCliente),
                archivoNuestro: Boolean(req.body?.archivoNuestro),
                eliminarArchivoCliente: Boolean(req.body?.eliminarArchivoCliente),
                eliminarArchivoNuestro: Boolean(req.body?.eliminarArchivoNuestro)
            },
            before: antes,
            after: mapCorapsa(row)
        });
        return mapCorapsa(row);
    });

    if (oldClienteKeyToRemove) await storage.deleteObject(oldClienteKeyToRemove);
    if (oldNuestroKeyToRemove) await storage.deleteObject(oldNuestroKeyToRemove);

    sendData(res, { corapsa });
}));

app.delete('/api/corapsa/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const current = await db.get('SELECT file_key, file_nuestro_key FROM corapsa WHERE id = ?', [id]);
    await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM corapsa WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM corapsa WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Recibo no encontrado.', 'NOT_FOUND');
        await logAudit({ entity: 'corapsa', entityId: id, action: 'eliminar', justification: justificacion, before: mapCorapsa(previo) });
    });
    if (current?.file_key) await storage.deleteObject(current.file_key);
    if (current?.file_nuestro_key) await storage.deleteObject(current.file_nuestro_key);
    sendData(res, { id });
}));

// GASTOS
app.get('/api/gastos/:id/archivo', asyncHandler(async (req, res) => {
    const row = await db.get('SELECT file_name, file_mime_type, file_data, file_key FROM gastos WHERE id = ?', [req.params.id]);
    if (!row) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
    await respondWithAttachment(res, { fileName: row.file_name, mimeType: row.file_mime_type, data: row.file_data, key: row.file_key });
}));

app.get('/api/gastos', asyncHandler(async (_req, res) => {
    const rows = await db.all(`
        SELECT id, fecha, monto, concepto, justificacion, notas,
               file_name, file_mime_type, (file_key IS NOT NULL OR LENGTH(file_data) > 0) AS has_file,
               created_at, updated_at
        FROM gastos
        ORDER BY fecha DESC, id DESC
    `);
    sendData(res, rows.map(mapExpense));
}));

app.post('/api/gastos', asyncHandler(async (req, res) => {
    const expense = {
        fecha: asIsoDate(req.body?.fecha, 'La fecha'),
        monto: asNumber(req.body?.monto, { required: true, min: 0.01, max: MAX_MONEY_LEMPIRAS, field: 'El monto' }),
        concepto: asText(req.body?.concepto, { required: true, field: 'El concepto', maxLength: 200 }),
        justificacion: asText(req.body?.justificacion, { maxLength: 1000 }),
        notas: asText(req.body?.notas, { maxLength: 1000 })
    };
    const attachment = await storeAttachment('gastos', parseAttachmentPayload(req.body?.archivo, 'El recibo del gasto'));
    const gasto = await withTransaction(async () => {
        const result = await db.run(`
            INSERT INTO gastos (fecha, monto, concepto, justificacion, notas, file_name, file_mime_type, file_data, file_key, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            expense.fecha, expense.monto, expense.concepto, expense.justificacion, expense.notas,
            attachment?.fileName || 'Sin Archivo', attachment?.mimeType || '', attachment?.data || null, attachment?.key || null
        ]);
        const row = await db.get('SELECT * FROM gastos WHERE id = ?', [result.lastID]);
        await logAudit({ entity: 'gasto', entityId: result.lastID, action: 'crear', details: mapExpense(row) });
        return mapExpense(row);
    });
    sendData(res, { gasto }, 201);
}));

app.put('/api/gastos/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const current = await db.get('SELECT * FROM gastos WHERE id = ?', [id]);
    if (!current) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');

    const expense = {
        fecha: asIsoDate(req.body?.fecha, 'La fecha'),
        monto: asNumber(req.body?.monto, { required: true, min: 0.01, max: MAX_MONEY_LEMPIRAS, field: 'El monto' }),
        concepto: asText(req.body?.concepto, { required: true, field: 'El concepto', maxLength: 200 }),
        justificacion: asText(req.body?.justificacion, { required: true, field: 'La justificación', maxLength: 1000 }),
        notas: asText(req.body?.notas, { maxLength: 1000 })
    };
    const hasUpload = Object.prototype.hasOwnProperty.call(req.body || {}, 'archivo');
    const attachment = hasUpload ? await storeAttachment('gastos', parseAttachmentPayload(req.body.archivo, 'El recibo del gasto')) : null;

    const gasto = await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM gastos WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
        const antes = mapExpense(previo);

        await db.run(`
            UPDATE gastos
            SET fecha = ?, monto = ?, concepto = ?, justificacion = ?, notas = ?,
                file_name = ?, file_mime_type = ?, file_data = ?, file_key = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            expense.fecha, expense.monto, expense.concepto, expense.justificacion, expense.notas,
            hasUpload ? attachment.fileName : current.file_name,
            hasUpload ? attachment.mimeType : current.file_mime_type,
            hasUpload ? attachment.data : current.file_data,
            hasUpload ? attachment.key : current.file_key,
            id
        ]);
        const row = await db.get('SELECT * FROM gastos WHERE id = ?', [id]);
        const despues = mapExpense(row);
        await logAudit({ entity: 'gasto', entityId: id, action: 'editar', justification: expense.justificacion, details: despues, before: antes, after: despues });
        return despues;
    });

    if (hasUpload && current.file_key) await storage.deleteObject(current.file_key);

    sendData(res, { gasto });
}));

app.patch('/api/gastos/:id/archivo', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = asText(req.body?.justificacion, { maxLength: 500 });
    const current = await db.get('SELECT file_key FROM gastos WHERE id = ?', [id]);
    if (!current) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');

    const eliminar = req.body?.eliminarArchivo === true;
    const attachment = eliminar
        ? null
        : await storeAttachment('gastos', parseAttachmentPayload(req.body?.archivo, 'El recibo del gasto'));
    if (!eliminar && !attachment) throw new HttpError(400, 'Seleccione un archivo.', 'VALIDATION_ERROR');

    const gasto = await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM gastos WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
        const antes = mapExpense(previo);

        const result = eliminar
            ? await db.run(`
                UPDATE gastos
                SET file_name = 'Sin Archivo', file_mime_type = '', file_data = NULL, file_key = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [id])
            : await db.run(`
                UPDATE gastos
                SET file_name = ?, file_mime_type = ?, file_data = ?, file_key = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [attachment.fileName, attachment.mimeType, attachment.data, attachment.key, id]);

        if (!result.changes) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
        const row = await db.get('SELECT * FROM gastos WHERE id = ?', [id]);
        const despues = mapExpense(row);
        await logAudit({ entity: 'gasto', entityId: id, action: 'actualizar_archivo', justification: justificacion, details: despues, before: antes, after: despues });
        return despues;
    });

    if (current.file_key) await storage.deleteObject(current.file_key);

    sendData(res, { gasto });
}));

app.delete('/api/gastos/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const current = await db.get('SELECT file_key FROM gastos WHERE id = ?', [id]);
    await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM gastos WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM gastos WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Gasto no encontrado.', 'NOT_FOUND');
        await logAudit({ entity: 'gasto', entityId: id, action: 'eliminar', justification: justificacion, before: mapExpense(previo) });
    });
    if (current?.file_key) await storage.deleteObject(current.file_key);
    sendData(res, { id });
}));

// OVERVIEW / CONCILIACIÓN CORAPSA
app.get('/api/overview', asyncHandler(async (req, res) => {
    const range = validateOverviewRange(req.query?.inicio, req.query?.fin);
    sendData(res, await buildOverviewSummary(range.start, range.end));
}));

app.get('/api/corapsa-pagos/:id/archivo', asyncHandler(async (req, res) => {
    const row = await db.get(
        'SELECT file_name, file_mime_type, file_data, file_key FROM corapsa_pagos WHERE id = ?',
        [req.params.id]
    );
    if (!row) throw new HttpError(404, 'Pago de Corapsa no encontrado.', 'NOT_FOUND');
    await respondWithAttachment(res, { fileName: row.file_name, mimeType: row.file_mime_type, data: row.file_data, key: row.file_key });
}));

app.post('/api/corapsa-pagos', asyncHandler(async (req, res) => {
    const payment = validateCorapsaPaymentBody(req.body);
    const attachment = await storeAttachment('corapsa-pagos', parseAttachmentPayload(req.body?.archivo, 'El estado de cuenta de Corapsa'));

    const pago = await withTransaction(async () => {
        const result = await db.run(`
            INSERT INTO corapsa_pagos (
                fecha_pago, periodo_inicio, periodo_fin, referencia, destino, toneladas,
                monto, notas, file_name, file_mime_type, file_data, file_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [
            payment.fechaPago, payment.periodoInicio, payment.periodoFin,
            payment.referencia, payment.destino, payment.toneladas, payment.monto, payment.notas,
            attachment?.fileName || 'Sin Archivo', attachment?.mimeType || '', attachment?.data || null, attachment?.key || null
        ]);

        const row = await db.get('SELECT * FROM corapsa_pagos WHERE id = ?', [result.lastID]);
        await logAudit({ entity: 'pago_corapsa', entityId: result.lastID, action: 'crear', details: mapCorapsaPayment(row) });
        return mapCorapsaPayment(row);
    });
    sendData(res, { pago }, 201);
}));

app.put('/api/corapsa-pagos/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const current = await db.get('SELECT * FROM corapsa_pagos WHERE id = ?', [id]);
    if (!current) throw new HttpError(404, 'Pago de Corapsa no encontrado.', 'NOT_FOUND');

    const payment = validateCorapsaPaymentBody(req.body, { editing: true });
    const hasUpload = Object.prototype.hasOwnProperty.call(req.body || {}, 'archivo');
    const attachment = hasUpload
        ? await storeAttachment('corapsa-pagos', parseAttachmentPayload(req.body.archivo, 'El estado de cuenta de Corapsa'))
        : null;

    const pago = await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM corapsa_pagos WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Pago de Corapsa no encontrado.', 'NOT_FOUND');
        const antes = mapCorapsaPayment(previo);

        await db.run(`
            UPDATE corapsa_pagos
            SET fecha_pago = ?, periodo_inicio = ?, periodo_fin = ?, referencia = ?, destino = ?,
                toneladas = ?, monto = ?, notas = ?, file_name = ?, file_mime_type = ?,
                file_data = ?, file_key = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [
            payment.fechaPago, payment.periodoInicio, payment.periodoFin,
            payment.referencia, payment.destino, payment.toneladas, payment.monto, payment.notas,
            hasUpload ? attachment.fileName : current.file_name,
            hasUpload ? attachment.mimeType : current.file_mime_type,
            hasUpload ? attachment.data : current.file_data,
            hasUpload ? attachment.key : current.file_key,
            id
        ]);

        const row = await db.get('SELECT * FROM corapsa_pagos WHERE id = ?', [id]);
        const despues = mapCorapsaPayment(row);
        await logAudit({
            entity: 'pago_corapsa', entityId: id, action: 'editar',
            justification: payment.justificacion, details: despues, before: antes, after: despues
        });
        return despues;
    });

    if (hasUpload && current.file_key) await storage.deleteObject(current.file_key);

    sendData(res, { pago });
}));

app.delete('/api/corapsa-pagos/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const justificacion = requireJustification(req.body);
    const current = await db.get('SELECT file_key FROM corapsa_pagos WHERE id = ?', [id]);
    await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM corapsa_pagos WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Pago de Corapsa no encontrado.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM corapsa_pagos WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Pago de Corapsa no encontrado.', 'NOT_FOUND');
        await logAudit({ entity: 'pago_corapsa', entityId: id, action: 'eliminar', justification: justificacion, before: mapCorapsaPayment(previo) });
    });
    if (current?.file_key) await storage.deleteObject(current.file_key);
    sendData(res, { id });
}));

// PLANILLA
app.get('/api/planilla/resumen', asyncHandler(async (req, res) => {
    const range = validatePayrollRange(req.query?.inicio, req.query?.fin);
    sendData(res, await buildPayrollSummary(range.start, range.end));
}));

app.get('/api/planilla', asyncHandler(async (_req, res) => {
    const rows = await db.all('SELECT * FROM planilla ORDER BY apellido, nombre, id');
    sendData(res, rows.map(mapWorker));
}));

app.post('/api/planilla', asyncHandler(async (req, res) => {
    const worker = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { required: true, field: 'El apellido', maxLength: 120 }),
        telefono: asWorkerPhone(req.body?.telefono),
        sueldoBase: asNumber(req.body?.sueldoBase, { required: true, min: 0.01, max: MAX_MONEY_LEMPIRAS, field: 'El sueldo base' })
    };

    const trabajador = await withTransaction(async () => {
        const result = await db.run(`
            INSERT INTO planilla
                (nombre, apellido, telefono, sueldo_base, dias_trabajados, extras, asistencia_migrada, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `, [worker.nombre, worker.apellido, worker.telefono, worker.sueldoBase]);
        const row = await db.get('SELECT * FROM planilla WHERE id = ?', [result.lastID]);
        await logAudit({ entity: 'trabajador', entityId: result.lastID, action: 'crear', details: worker });
        return mapWorker(row);
    });
    sendData(res, { trabajador }, 201);
}));

app.put('/api/planilla/:id/asistencia/:fecha', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const fecha = asIsoDate(req.params.fecha, 'La fecha de la jornada');
    const trabajado = asBoolean(req.body?.trabajado);
    const horaInicio = asTime(req.body?.horaInicio || '07:00', 'La hora de entrada');
    const horaFin = asTime(req.body?.horaFin || '16:00', 'La hora de salida');

    if (trabajado && horaFin <= horaInicio) {
        throw new HttpError(400, 'La hora de salida debe ser posterior a la hora de entrada.', 'VALIDATION_ERROR');
    }

    const worker = await db.get('SELECT id FROM planilla WHERE id = ?', [id]);
    if (!worker) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');

    const asistencia = await withTransaction(async () => {
        // Upsert, so there may be nothing here yet: a first mark of the day is
        // a creation, and leaving "antes" null keeps it out of the change list.
        const previo = await db.get(`
            SELECT trabajador_id, fecha, trabajado, hora_inicio, hora_fin
            FROM planilla_asistencia
            WHERE trabajador_id = ? AND fecha = ?
        `, [id, fecha]);
        const antes = previo ? mapAttendance(previo) : null;

        await db.run(`
            INSERT INTO planilla_asistencia
                (trabajador_id, fecha, trabajado, hora_inicio, hora_fin)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(trabajador_id, fecha)
            DO UPDATE SET
                trabajado = excluded.trabajado,
                hora_inicio = excluded.hora_inicio,
                hora_fin = excluded.hora_fin,
                updated_at = CURRENT_TIMESTAMP
        `, [id, fecha, trabajado ? 1 : 0, horaInicio, horaFin]);

        const row = await db.get(`
            SELECT trabajador_id, fecha, trabajado, hora_inicio, hora_fin
            FROM planilla_asistencia
            WHERE trabajador_id = ? AND fecha = ?
        `, [id, fecha]);
        const despues = mapAttendance(row);

        await logAudit({
            entity: 'asistencia',
            entityId: `${id}:${fecha}`,
            action: trabajado ? 'registrar_jornada' : 'marcar_no_trabajado',
            details: despues,
            // Null on the first mark of the day — an insert, not a correction.
            before: antes,
            after: despues
        });
        return despues;
    });
    sendData(res, { asistencia });
}));

app.put('/api/planilla/:id/periodo', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const range = validatePayrollRange(req.body?.inicio, req.body?.fin);
    const extras = asNumber(req.body?.extras ?? 0, {
        required: true,
        min: 0,
        max: MAX_MONEY_LEMPIRAS,
        field: 'Los extras'
    });

    const worker = await db.get('SELECT id FROM planilla WHERE id = ?', [id]);
    if (!worker) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');

    await withTransaction(async () => {
        // Upsert: null on the first extras entry for this period, which is a
        // creation rather than a correction of an earlier amount.
        const previo = await db.get(
            'SELECT extras FROM planilla_periodos WHERE trabajador_id = ? AND fecha_inicio = ? AND fecha_fin = ?',
            [id, range.start, range.end]
        );

        await db.run(`
            INSERT INTO planilla_periodos
                (trabajador_id, fecha_inicio, fecha_fin, extras)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(trabajador_id, fecha_inicio, fecha_fin)
            DO UPDATE SET extras = excluded.extras, updated_at = CURRENT_TIMESTAMP
        `, [id, range.start, range.end, extras]);

        await logAudit({
            entity: 'planilla_periodo',
            entityId: `${id}:${range.start}:${range.end}`,
            action: 'actualizar_extras',
            details: { extras },
            before: previo ? { extras: Number(previo.extras || 0) } : null,
            after: { extras }
        });
    });

    // Read-only response building — kept outside the transaction, no need to hold the write lock for this.
    const summary = await buildPayrollSummary(range.start, range.end, id);
    sendData(res, { trabajador: summary.trabajadores[0] });
}));

app.put('/api/planilla/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const worker = {
        nombre: asText(req.body?.nombre, { required: true, field: 'El nombre', maxLength: 120 }),
        apellido: asText(req.body?.apellido, { required: true, field: 'El apellido', maxLength: 120 }),
        telefono: asWorkerPhone(req.body?.telefono),
        sueldoBase: asNumber(req.body?.sueldoBase, { required: true, min: 0.01, max: MAX_MONEY_LEMPIRAS, field: 'El sueldo base' })
    };

    const trabajador = await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM planilla WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');
        const antes = mapWorker(previo);

        const result = await db.run(`
            UPDATE planilla
            SET nombre = ?, apellido = ?, telefono = ?, sueldo_base = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [worker.nombre, worker.apellido, worker.telefono, worker.sueldoBase, id]);
        if (!result.changes) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');
        const row = await db.get('SELECT * FROM planilla WHERE id = ?', [id]);
        const despues = mapWorker(row);
        await logAudit({ entity: 'trabajador', entityId: id, action: 'editar', details: despues, before: antes, after: despues });
        return despues;
    });
    sendData(res, { trabajador });
}));

// Kept for compatibility with earlier frontend versions. New versions persist
// attendance by date and extras by selected payroll period instead.
app.patch('/api/planilla/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    const dias = asNumber(req.body?.diasTrabajados, { required: true, min: 0, field: 'Los días trabajados' });
    const extras = asNumber(req.body?.extras, { required: true, min: 0, max: MAX_MONEY_LEMPIRAS, field: 'Los extras' });
    if (dias > 31) throw new HttpError(400, 'Los días trabajados no pueden exceder 31.', 'VALIDATION_ERROR');
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
    await withTransaction(async () => {
        const previo = await db.get('SELECT * FROM planilla WHERE id = ?', [id]);
        if (!previo) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');
        const result = await db.run('DELETE FROM planilla WHERE id = ?', [id]);
        if (!result.changes) throw new HttpError(404, 'Trabajador no encontrado.', 'NOT_FOUND');
        await logAudit({ entity: 'trabajador', entityId: id, action: 'eliminar', justification: justificacion, before: mapWorker(previo) });
    });
    sendData(res, { id });
}));

// AUDITORIA
function mapAudit(row) {
    const antes = safeJsonParse(row.datos_antes);
    const despues = safeJsonParse(row.datos_despues);
    return {
        id: row.id,
        entidad: row.entidad,
        entidadId: row.entidad_id,
        accion: row.accion,
        justificacion: row.justificacion || '',
        // Local wall-clock time; see auditoria.registrado_en in database.js.
        fecha: row.registrado_en || row.created_at || '',
        // Derived on read rather than read from campos_cambiados, so improving
        // diffSnapshots also improves how already-stored rows are presented.
        cambios: diffSnapshots(antes, despues),
        antes,
        despues,
        // Rows written before snapshots existed have only this.
        detalles: safeJsonParse(row.detalles)
    };
}

app.get('/api/auditoria', asyncHandler(async (req, res) => {
    const range = validateOverviewRange(req.query?.inicio, req.query?.fin);
    const entidad = asText(req.query?.entidad, { maxLength: 50 });
    const accion = asText(req.query?.accion, { maxLength: 50 });
    const campo = asText(req.query?.campo, { maxLength: 60 });

    // registrado_en is 'YYYY-MM-DD HH:MM:SS', so a plain string comparison
    // against the end date plus a time of 23:59:59 covers the whole final day.
    const params = [`${range.start} 00:00:00`, `${range.end} 23:59:59`];
    let filtro = 'WHERE registrado_en BETWEEN ? AND ?';
    if (entidad) {
        filtro += ' AND entidad = ?';
        params.push(entidad);
    }
    if (accion) {
        filtro += ' AND accion = ?';
        params.push(accion);
    }
    if (campo) {
        // campos_cambiados is a comma-separated list; the commas around the
        // needle keep "precio" from matching "precioAplicado".
        filtro += " AND (',' || campos_cambiados || ',') LIKE ?";
        params.push(`%,${campo},%`);
    }

    const rows = await db.all(
        `SELECT * FROM auditoria ${filtro} ORDER BY id DESC LIMIT ${AUDIT_PAGE_LIMIT + 1}`,
        params
    );

    // One row over the limit is fetched purely to tell the UI the list was cut.
    const truncated = rows.length > AUDIT_PAGE_LIMIT;
    sendData(res, {
        movimientos: rows.slice(0, AUDIT_PAGE_LIMIT).map(mapAudit),
        truncado: truncated,
        limite: AUDIT_PAGE_LIMIT
    });
}));

app.use((req, _res, next) => {
    next(new HttpError(404, `Ruta no encontrada: ${req.method} ${req.path}`, 'NOT_FOUND'));
});

app.use((error, _req, res, _next) => {
    const status = Number(error?.status) || 500;
    // Fail closed: nothing in this deployment (droplet start script, systemd
    // unit, etc.) ever sets NODE_ENV, so gating on === 'production' left this
    // hiding branch permanently dead and leaked raw error messages/details to
    // callers. Hide by default and only skip hiding when a developer opts in
    // with NODE_ENV=development. The full error is still logged below either
    // way, so local debugging from the server console is unaffected.
    const production = process.env.NODE_ENV !== 'development';
    if (status >= 500) console.error(error);

    // express.json() throws a plain SyntaxError (no .code) for a malformed
    // body — without this it fell through to INTERNAL_ERROR despite being a
    // 400 the caller can actually fix.
    const isBodyParseError = error?.type === 'entity.parse.failed';
    const code = error?.code || (isBodyParseError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');

    res.status(status).json({
        ok: false,
        error: {
            code,
            message: status >= 500 && production
                ? 'Ocurrió un error interno en el servidor.'
                : (error?.message || 'Ocurrió un error interno en el servidor.'),
            details: production ? null : (error?.details || null)
        }
    });
});

async function start() {
    if (!API_KEY) {
        console.warn(
            'ADVERTENCIA: API_KEY no está definida — el servidor arrancará sin autenticación. ' +
            'Defina API_KEY antes de iniciar el servidor para reactivarla ' +
            '(ej. API_KEY=xxxx node server.js). Genere una con: ' +
            'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
        );
    }
    db = await initializeDB();
    server = app.listen(PORT, HOST, () => {
        console.log(`Servidor de Báscula Central corriendo en http://${HOST}:${PORT}`);
    });
}

async function shutdown(signal, exitCode = 0) {
    console.log(`Cerrando servidor (${signal})...`);
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.close();
    process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Without these, an unanticipated error (a bug in a dependency, a timer
// callback) takes down the whole Node process with nothing to notice or
// restart it — see main.js for the same reasoning on the Electron side.
// uncaughtException leaves the process in a state Node no longer guarantees
// is safe to keep running in, so this logs, attempts a clean shutdown, and
// exits non-zero — relying on the process supervisor (see deploy/) to bring
// it back up rather than limping on indefinitely.
process.on('uncaughtException', (error) => {
    console.error('Excepción no capturada:', error?.stack || error);
    shutdown('uncaughtException', 1).catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
    console.error('Rechazo de promesa no manejado:', reason?.stack || reason);
});

start().catch(error => {
    console.error('No se pudo iniciar el servidor:', error);
    process.exitCode = 1;
});

module.exports = app;