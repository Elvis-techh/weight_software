const API_URL = 'http://159.89.84.60:3000';

let MOCK_CLIENTES = [];
let MOCK_CASUAL = { id: 'casual', nombre: "", apellido: "", precioFletePropio: 0, precioFleteCliente: 0 };

let currentLiveWeight = 0;
let camionesEnPatio = [];
let transaccionesData = [];
let corapsaData = [];
let gastosData = [];
let planillaData = [];
let activeUploadId = null;
let activeUploadType = null;
let activeUploadJustification = null;
let activeReceiptViewer = { id: null, type: null };
let activeTransaction = { id: null, clienteId: null, placa: "", conductor: "", flete: "Propio", pesoBruto: null, pesoTara: null, precioAplicado: 0 };
let pendingAction = null;
let pendingActionId = null;

function getLocalIsoDate() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseFormattedNumber(value) {
    if (typeof value === 'number') return value;
    const parsed = Number.parseFloat(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : NaN;
}

function formatNumberForInput(value, maximumFractionDigits = 2) {
    const number = parseFormattedNumber(value);
    if (!Number.isFinite(number)) return '';
    return number.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits
    });
}

function formatIntegerThousandsInput(e) {
    const digits = e.target.value.replace(/\D/g, '');
    e.target.value = digits ? Number(digits).toLocaleString('en-US') : '';
}

function formatDecimalThousandsInput(e) {
    const original = String(e.target.value ?? '').replace(/,/g, '').replace(/[^\d.]/g, '');
    if (!original) {
        e.target.value = '';
        return;
    }

    const hasDecimalPoint = original.includes('.');
    const [wholeRaw, ...decimalParts] = original.split('.');
    const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
    const decimals = decimalParts.join('').slice(0, 2);
    const formattedWhole = Number(whole).toLocaleString('en-US');

    e.target.value = hasDecimalPoint
        ? `${formattedWhole}.${decimals}`
        : formattedWhole;
}

// Input Formatters
function initPhone(e) { if (e.target.value === '') e.target.value = '+504 '; }
function formatPhone(e) {
    let val = e.target.value.replace(/[^\d+]/g, '');
    if (val === '+' || val === '') val = '+504 ';
    if (val.startsWith('+504')) {
        let digits = val.slice(4).replace(/\D/g, '');
        if (digits.length > 4) digits = digits.slice(0, 4) + '-' + digits.slice(4, 8);
        val = '+504 ' + digits;
    }
    e.target.value = val;
}
function formatCurrencyInput(e) {
    formatIntegerThousandsInput(e);
}