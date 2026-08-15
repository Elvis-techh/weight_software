// Non-tabular fields use the same simple [data-field] textContent binding
// receipt.js/listado.js use. The row table is handled separately below
// since, unlike those fixed fields, the row count varies on every call.
function renderHeaderFields(data) {
  document.querySelectorAll('[data-field]').forEach((element) => {
    const key = element.dataset.field;
    const value = data[key];
    element.textContent = value == null ? '' : String(value);
  });
}

function buildCell(className, text) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text == null ? '' : String(text);
  return td;
}

function buildRow(row = {}) {
  const tr = document.createElement('tr');

  tr.appendChild(buildCell('col-fecha', row.fecha));
  tr.appendChild(buildCell('col-cliente', row.cliente));
  tr.appendChild(buildCell('col-destino', row.destino));
  tr.appendChild(buildCell('col-origen', row.origen));
  tr.appendChild(buildCell('col-recibo', row.recibo));
  tr.appendChild(buildCell('col-num col-precio', row.precioUnidad));
  tr.appendChild(buildCell('col-num col-toneladas', row.toneladas));
  tr.appendChild(buildCell('col-num col-total', row.total));
  tr.appendChild(buildCell('col-estado', row.estado));

  return tr;
}

// Your app can call window.setCorapsaListadoData({...}) before printing/previewing.
// Unlike receipt.js's setReceiptData (which merges into a persistent object),
// this fully rebuilds the table body every time, since the row count changes
// between calls (e.g. previewing two different filtered sets back to back).
function setCorapsaListadoData(data = {}) {
  renderHeaderFields(data);

  const tbody = document.getElementById('listado-body');
  tbody.replaceChildren();
  (Array.isArray(data.rows) ? data.rows : []).forEach((row) => tbody.appendChild(buildRow(row)));
}

window.setCorapsaListadoData = setCorapsaListadoData;
