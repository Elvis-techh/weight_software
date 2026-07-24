const API_URL = 'http://localhost:3000';

const APP_CONFIG = Object.freeze({
    lbsPerMetricTon: 2204.62262185,
    lbsPerQuintal: 100,
    scaleReadingMaxAgeMs: 3000
});

let MOCK_CLIENTES = [];
let MOCK_CASUAL = createDefaultCasualClient();

let currentLiveWeight = 0;
let currentScaleStable = false;
let lastScaleUpdateAt = 0;

let camionesEnPatio = [];
let transaccionesData = [];
let corapsaData = [];
let gastosData = [];
let planillaData = [];

let activeUploadId = null;
let activeUploadType = null;
let activeUploadJustification = null;
let activeReceiptViewer = { id: null, type: null };
let activeCorapsaEditJustification = '';

let activeTransaction = createEmptyTransaction();
let pendingAction = null;
let pendingActionId = null;

function createDefaultCasualClient() {
    return {
        id: 'casual',
        nombre: '',
        apellido: '',
        precioFletePropio: 0,
        precioFleteCliente: 0,
        unidad: 'tonelada'
    };
}

function createEmptyTransaction() {
    return {
        id: null,
        clienteId: null,
        clienteNombreSnapshot: '',
        placa: '',
        conductor: '',
        flete: 'Propio',
        pesoBruto: null,
        pesoTara: null,
        precioAplicado: 0,
        unidad: 'tonelada',
        casualSnapshot: null
    };
}

function getLocalIsoDate() {
    const d = new Date();
    return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
    ].join('-');
}

function getLocalTimeString() {
    return new Date().toLocaleTimeString('es-HN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function parseFormattedNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;

    const normalized = String(value ?? '')
        .replace(/,/g, '')
        .trim();

    if (normalized === '') return NaN;

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function toFiniteNumber(value, fallback = 0) {
    const number = parseFormattedNumber(value);
    return Number.isFinite(number) ? number : fallback;
}

function formatNumberForInput(value, maximumFractionDigits = 2) {
    const number = parseFormattedNumber(value);
    if (!Number.isFinite(number)) return '';

    return number.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits
    });
}

function formatMoney(value) {
    return toFiniteNumber(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatDateForDisplay(value) {
    const parts = String(value ?? '').split('-');
    return parts.length === 3 ? parts.reverse().join('/') : String(value ?? '');
}

function formatIntegerThousandsInput(event) {
    const digits = String(event.target.value ?? '').replace(/\D/g, '');
    event.target.value = digits ? Number(digits).toLocaleString('en-US') : '';
}

function formatDecimalThousandsInput(event) {
    const original = String(event.target.value ?? '')
        .replace(/,/g, '')
        .replace(/[^\d.]/g, '');

    if (!original) {
        event.target.value = '';
        return;
    }

    const hasDecimalPoint = original.includes('.');
    const [wholeRaw, ...decimalParts] = original.split('.');
    const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
    const decimals = decimalParts.join('').slice(0, 2);
    const formattedWhole = Number(whole).toLocaleString('en-US');

    event.target.value = hasDecimalPoint
        ? `${formattedWhole}.${decimals}`
        : formattedWhole;
}

function formatCurrencyInput(event) {
    formatIntegerThousandsInput(event);
}

function initPhone(event) {
    if (event.target.value === '') event.target.value = '+504 ';
}

function formatPhone(event) {
    let value = String(event.target.value ?? '').replace(/[^\d+]/g, '');

    if (value === '+' || value === '') value = '+504';

    if (value.startsWith('+504')) {
        let digits = value.slice(4).replace(/\D/g, '').slice(0, 8);
        if (digits.length > 4) digits = `${digits.slice(0, 4)}-${digits.slice(4)}`;
        value = `+504 ${digits}`;
    }

    event.target.value = value;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function sameRecordId(left, right) {
    return String(left) === String(right);
}

function setLiveScaleData(data) {
    const weight = Number(data?.weight);
    currentLiveWeight = Number.isFinite(weight) && weight >= 0 ? weight : 0;
    currentScaleStable = Boolean(data?.stable);
    lastScaleUpdateAt = Date.now();
}

function getLiveScaleReading() {
    return {
        weight: currentLiveWeight,
        stable: currentScaleStable,
        isFresh: Date.now() - lastScaleUpdateAt <= APP_CONFIG.scaleReadingMaxAgeMs
    };
}

function calculatePayment(netWeightLbs, price, unit) {
    const net = toFiniteNumber(netWeightLbs);
    const appliedPrice = toFiniteNumber(price);
    const divisor = unit === 'quintal'
        ? APP_CONFIG.lbsPerQuintal
        : APP_CONFIG.lbsPerMetricTon;

    return (net / divisor) * appliedPrice;
}