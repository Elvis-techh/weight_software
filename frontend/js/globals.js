const API_URL = 'http://localhost:3000';

const APP_CONFIG = Object.freeze({
    lbsPerMetricTon: 2204.62262185,
    lbsPerQuintal: 100,
    quintalesPerTon: 22.04,
    scaleReadingMaxAgeMs: 3000,
    maxAttachmentBytes: 10 * 1024 * 1024
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
let overviewData = null;
let corapsaPagosData = [];

let activeUploadId = null;
let activeUploadType = null;
let activeUploadJustification = null;
let activeReceiptViewer = { module: null, id: null, type: null };
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

function formatLocalIsoDate(date) {
    const d = date instanceof Date ? date : new Date();
    return [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
    ].join('-');
}

function getLocalIsoDate() {
    return formatLocalIsoDate(new Date());
}

function parseLocalIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;

    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (
        date.getFullYear() !== Number(match[1]) ||
        date.getMonth() !== Number(match[2]) - 1 ||
        date.getDate() !== Number(match[3])
    ) return null;

    date.setHours(12, 0, 0, 0);
    return date;
}

function addLocalDays(dateOrIso, days) {
    const date = dateOrIso instanceof Date
        ? new Date(dateOrIso)
        : parseLocalIsoDate(dateOrIso);
    if (!date) return null;
    date.setDate(date.getDate() + Number(days || 0));
    return date;
}

function getCurrentWeekRange(referenceDate = new Date()) {
    const reference = new Date(referenceDate);
    reference.setHours(12, 0, 0, 0);
    const mondayOffset = reference.getDay() === 0 ? -6 : 1 - reference.getDay();
    const monday = addLocalDays(reference, mondayOffset);
    const sunday = addLocalDays(monday, 6);
    return {
        start: formatLocalIsoDate(monday),
        end: formatLocalIsoDate(sunday)
    };
}

function getCurrentMonthRange(referenceDate = new Date()) {
    const reference = new Date(referenceDate);
    const first = new Date(reference.getFullYear(), reference.getMonth(), 1, 12, 0, 0, 0);
    const last = new Date(reference.getFullYear(), reference.getMonth() + 1, 0, 12, 0, 0, 0);
    return {
        start: formatLocalIsoDate(first),
        end: formatLocalIsoDate(last)
    };
}

function enumerateLocalDates(startIso, endIso, maximumDays = 31) {
    const start = parseLocalIsoDate(startIso);
    const end = parseLocalIsoDate(endIso);
    if (!start || !end || start > end) return [];

    const dates = [];
    let cursor = new Date(start);
    while (cursor <= end && dates.length < maximumDays) {
        dates.push(formatLocalIsoDate(cursor));
        cursor = addLocalDays(cursor, 1);
    }
    return dates;
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

function isValidInternationalPhone(value) {
    const phone = String(value || '').trim();
    if (!phone || phone === '+504') return true;
    if (phone.startsWith('+504')) return /^\+504 \d{4}-\d{4}$/.test(phone);

    // Other country codes remain editable. Require a leading plus sign and
    // between 7 and 15 total digits, following the E.164 length limit.
    const digits = phone.replace(/\D/g, '');
    return /^\+/.test(phone) && digits.length >= 7 && digits.length <= 15;
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

function truncateToDecimals(value, decimalPlaces = 2) {
    const number = toFiniteNumber(value);
    const places = Number.isInteger(decimalPlaces) && decimalPlaces >= 0
        ? decimalPlaces
        : 2;
    const factor = 10 ** places;

    // Weights and prices are non-negative in this workflow. The tiny tolerance
    // prevents a value such as 2.26 being represented internally as 2.2599999.
    return Math.floor((number + 1e-9) * factor) / factor;
}

function calculateMetricTons(netWeightLbs, { truncate = false } = {}) {
    const metricTons = toFiniteNumber(netWeightLbs) / APP_CONFIG.lbsPerMetricTon;
    return truncate ? truncateToDecimals(metricTons, 2) : metricTons;
}

function calculateBillableQuantity(netWeightLbs, unit) {
    const net = toFiniteNumber(netWeightLbs);

    if (unit === 'quintal') {
        return net / APP_CONFIG.lbsPerQuintal;
    }

    // Business rule: truncate metric tons to two decimal places BEFORE
    // multiplying by the price. Example: 2.2679 becomes 2.26, not 2.27.
    return calculateMetricTons(net, { truncate: true });
}

function calculatePayment(netWeightLbs, price, unit) {
    const appliedPrice = toFiniteNumber(price);
    return calculateBillableQuantity(netWeightLbs, unit) * appliedPrice;
}

function isPreviewableAttachmentType(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    return mime === 'application/pdf' || mime.startsWith('image/');
}

function isImageAttachmentType(mimeType) {
    return String(mimeType || '').toLowerCase().startsWith('image/');
}

function validateAttachmentFile(file) {
    if (!(file instanceof File)) throw new Error('Seleccione un archivo válido.');
    if (!isPreviewableAttachmentType(file.type)) {
        throw new Error('Solo se permiten imágenes y archivos PDF.');
    }
    if (file.size <= 0) throw new Error('El archivo seleccionado está vacío.');
    if (file.size > APP_CONFIG.maxAttachmentBytes) {
        throw new Error('El archivo supera el límite de 10 MB.');
    }
}

function readFileAsDataUrl(file) {
    validateAttachmentFile(file);

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('No se pudo leer el archivo seleccionado.'));
        reader.readAsDataURL(file);
    });
}

async function buildAttachmentPayload(file) {
    if (!file) return null;
    const dataUrl = await readFileAsDataUrl(file);
    return {
        fileName: file.name,
        mimeType: file.type,
        dataUrl
    };
}

function buildApiUrl(path) {
    return `${API_URL}${path}`;
}
