// Acopio Rivera's own RTN and the transaction type/product are constant for
// every receipt this app prints, so they live here instead of being sent
// per-transaction by the app. window.setReceiptData() fills in everything else.
const receiptData = {
  rtn: '01071974024269',
  numero: '',
  fechaDocumento: '',

  nombre: '',
  identidad: '',
  placa: '',
  fechaEntrada: '',
  fechaSalida: '',
  cliente: '',
  producto: 'FRUTA FRESCA DE PALMA AFRICANA',

  transaccion: 'COMPRA',
  origen: '',
  destino: '',
  finca: '',

  bruto: '',
  tara: '',
  neto: '',
  tm: '',
  precioTM: '',
  unidadCantidad: 'TM',
  unidadPrecio: 'Precio / TM',
  totalLps: ''
};

function renderReceipt(data) {
  document.querySelectorAll('[data-field]').forEach((element) => {
    const key = element.dataset.field;
    const value = data[key];
    element.textContent = value == null ? '' : String(value);
  });
}

// Your app can call window.setReceiptData({...}) before printing.
function setReceiptData(newData = {}) {
  Object.assign(receiptData, newData);
  renderReceipt(receiptData);
}

renderReceipt(receiptData);
window.setReceiptData = setReceiptData;
