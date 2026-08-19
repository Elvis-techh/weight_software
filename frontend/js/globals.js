// Defaults to production; run the app with BASCULA_API_URL set (see preload.js)
// to point it at a local backend instead, e.g. BASCULA_API_URL=http://localhost:3000 npm start
const API_URL = window.electronAPI?.apiUrl || 'https://api.basculacentral.com';
// Must match the API_KEY environment variable set on the backend server exactly.
// Not a cryptographic secret once this app is packaged/distributed — see MVP plan notes.
const API_KEY = '1218d8801f6281d70339d5626b60b5ca089355fee5fb3c324954849426c83ec1';

const APP_CONFIG = Object.freeze({
    lbsPerMetricTon: 2204.62262185,
    lbsPerQuintal: 100,
    // Derived from the two constants above, not the rounded business
    // convention (22.04) — must match the backend's QUINTALES_PER_TON
    // (server.js) exactly, since the backend prefers whatever quintal price
    // the frontend sends over its own recalculation. A mismatch here would
    // silently re-introduce the ~0.03% bias that was already fixed server-side.
    quintalesPerTon: 2204.62262185 / 100,
    scaleReadingMaxAgeMs: 3000,
    maxAttachmentBytes: 10 * 1024 * 1024,
    // Sanity ceiling matching the backend's MAX_WEIGHT_LBS (server.js) — not a
    // business rule, just a fat-finger guard for "Ingreso Manual", the one
    // weight path with no physical scale bounding it.
    maxWeightLbs: 200000,
    // History listados are fetched/filtered client-side with no pagination —
    // above this many rows, printing embeds the whole set into an offscreen
    // print window with no progress indicator (the same hang failure mode as
    // an unbounded fetch, just needing months of accumulated data to trigger).
    maxListadoPrintRows: 2000
});

let MOCK_CLIENTES = [];
let MOCK_CASUAL = createDefaultCasualClient();
let MOCK_COMPANIES = [];

let currentLiveWeight = 0;
let currentScaleStable = false;
let currentScaleSource = '';
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
    currentScaleSource = String(data?.source || '');
    lastScaleUpdateAt = Date.now();
}

function getLiveScaleReading() {
    return {
        weight: currentLiveWeight,
        stable: currentScaleStable,
        source: currentScaleSource,
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
    // Matches the backend's isAllowedAttachmentMime: SVG is excluded even
    // though it matches image/*, since it can carry an XSS payload.
    if (mime === 'image/svg+xml') return false;
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

// Distinguishes an OS file drag (WhatsApp Web image, PDF, etc.) from a plain
// text/element drag, which also fires dragenter/dragover/drop and must not be
// hijacked — e.g. dragging selected text between inputs.
function isFileDragEvent(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function buildApiUrl(path) {
    return `${API_URL}${path}`;
}

// Every route requires X-API-Key (see requireApiKey in server.js), but a
// plain <img src="..."> / <iframe src="..."> can't carry a custom header —
// the browser just requests the bare URL and gets a 401, which is why
// receipt thumbnails and the full-size viewer were rendering as broken
// images. Fetching the bytes ourselves (with the header attached) and
// handing the element a local blob: URL works around that. Mirrors
// apiRequest()'s timeout/offline-detection but returns raw bytes, not JSON.
async function fetchAttachmentBlob(url, { timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: { 'X-API-Key': API_KEY },
            signal: controller.signal
        });
        if (typeof setServerConnectionState === 'function') setServerConnectionState(true);
        if (!response.ok) throw new Error(`No se pudo cargar el archivo (HTTP ${response.status}).`);
        return await response.blob();
    } catch (error) {
        if (error?.name === 'AbortError') {
            if (typeof setServerConnectionState === 'function') setServerConnectionState(false);
            throw new Error('El servidor tardó demasiado en responder.');
        }
        // fetch() throws a bare TypeError for network-level failures (offline,
        // DNS, connection refused) — an HTTP error response above still
        // proves the server was reachable, so only this counts as "offline".
        if (error instanceof TypeError && typeof setServerConnectionState === 'function') {
            setServerConnectionState(false);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchAttachmentBlobUrl(url, options) {
    return URL.createObjectURL(await fetchAttachmentBlob(url, options));
}

// Lazily loads the vendored pdf.js build (frontend/js/vendor/pdfjs — copied
// from the pdfjs-dist devDependency; not fetched from a CDN, since this app
// has to work fully offline/packaged) and caches the promise so the ~1.7MB
// worker only gets fetched once no matter how many PDF thumbnails render.
let pdfjsLibPromise = null;
function loadPdfJs() {
    if (!pdfjsLibPromise) {
        pdfjsLibPromise = import('./vendor/pdfjs/pdf.min.mjs').then(pdfjsLib => {
            // Resolved relative to index.html (this app's only document), same
            // as every other "js/..." path in the codebase — NOT relative to
            // this module file, unlike the dynamic import() above.
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdfjs/pdf.worker.min.mjs';
            return pdfjsLib;
        });
    }
    return pdfjsLibPromise;
}

// Renders page 1 of a PDF to a small raster image and returns it as a
// blob: URL, so a PDF receipt can drop into the exact same <img> thumbnail/
// preview slot as a real photo instead of a generic "PDF" icon. Runs
// entirely client-side — sized for the single-page receipts/invoices this
// app deals with, not built for huge multi-hundred-page documents.
async function renderPdfPageAsImageBlobUrl(blob) {
    const pdfjsLib = await loadPdfJs();
    const data = new Uint8Array(await blob.arrayBuffer());
    // Real invoices/receipts routinely use the standard 14 PDF fonts
    // (Helvetica, Times, ...) without embedding them — without this, pdf.js
    // still renders but logs a warning and falls back to rougher glyph
    // metrics. No cmaps/ (CJK support) since receipts here are Latin-script.
    const pdf = await pdfjsLib.getDocument({ data, standardFontDataUrl: 'js/vendor/pdfjs/standard_fonts/' }).promise;
    const page = await pdf.getPage(1);
    // Render bigger than any of our thumbnail boxes so it stays crisp under
    // CSS object-cover, the same way a real photo would be.
    const targetLongSide = 320;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetLongSide / Math.max(baseViewport.width, baseViewport.height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const imageBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!imageBlob) throw new Error('No se pudo generar la imagen de vista previa.');
    return URL.createObjectURL(imageBlob);
}

// Loads every thumbnail placeholder inside `container` (rendered with
// data-attachment-thumb="<url>" data-attachment-mime="<mime>" and no src —
// see renderGastoAttachmentThumbnail / renderCorapsaAttachmentThumbnail).
// Images become a direct blob: URL; PDFs get rendered to a cover image
// first via renderPdfPageAsImageBlobUrl. Swaps in onFail(img) on any
// failure — a fetch error, a corrupt/unreadable PDF, whatever.
function cargarMiniaturasAdjuntos(container, onFail) {
    container?.querySelectorAll('img[data-attachment-thumb]').forEach(async img => {
        const url = img.dataset.attachmentThumb;
        const mime = img.dataset.attachmentMime || '';
        try {
            const blob = await fetchAttachmentBlob(url);
            const objectUrl = mime === 'application/pdf'
                ? await renderPdfPageAsImageBlobUrl(blob)
                : URL.createObjectURL(blob);
            img.src = objectUrl;
            img.dataset.objectUrl = objectUrl;
        } catch (error) {
            console.error('No se pudo cargar la miniatura del adjunto:', error);
            if (onFail) onFail(img);
        }
    });
}

// Releases blob URLs handed out by cargarMiniaturasAdjuntos before a table
// re-render discards the <img> elements that held them — otherwise every
// Gastos/Corapsa filter change leaks another batch of blobs.
function revocarMiniaturasAdjuntos(container) {
    container?.querySelectorAll('img[data-object-url]').forEach(img => {
        URL.revokeObjectURL(img.dataset.objectUrl);
    });
}
