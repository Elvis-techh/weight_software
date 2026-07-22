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
let activeTransaction = { id: null, clienteId: null, placa: "", conductor: "", flete: "Propio", pesoBruto: null, pesoTara: null, precioAplicado: 0 };
let pendingAction = null;
let pendingActionId = null;

function getLocalIsoDate() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
    let val = e.target.value.replace(/\D/g, '');
    if (val) e.target.value = Number(val).toLocaleString('en-US');
}