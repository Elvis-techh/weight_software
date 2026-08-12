// Non-tabular fields use the same simple [data-field] textContent binding
// receipt.js uses. The row table is handled separately below since, unlike
// the receipt's fixed fields, the row count varies on every call.
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

  const fechaCell = buildCell('col-fecha', `${row.fecha || ''}\n${row.hora || ''}`.trim());
  tr.appendChild(fechaCell);

  const identCell = document.createElement('td');
  identCell.className = 'col-ident';
  identCell.appendChild(document.createTextNode(row.identificacion == null ? '' : String(row.identificacion)));
  if (row.pendingSync) {
    const marker = document.createElement('span');
    marker.className = 'pending-marker';
    marker.textContent = ' *';
    identCell.appendChild(marker);
  }
  tr.appendChild(identCell);

  tr.appendChild(buildCell('col-cliente', row.cliente));
  tr.appendChild(buildCell('col-num', row.neto));
  tr.appendChild(buildCell('col-num', row.toneladas));
  tr.appendChild(buildCell('col-num', row.precioUnidad));
  tr.appendChild(buildCell('col-num', row.total));

  return tr;
}

// Your app can call window.setListadoData({...}) before printing/previewing.
// Unlike receipt.js's setReceiptData (which merges into a persistent object),
// this fully rebuilds the table body every time, since the row count changes
// between calls (e.g. previewing two different filtered sets back to back).
function setListadoData(data = {}) {
  renderHeaderFields(data);

  const tbody = document.getElementById('listado-body');
  tbody.replaceChildren();
  (data.rows || []).forEach((row) => tbody.appendChild(buildRow(row)));

  const footnote = document.getElementById('footnote');
  footnote.hidden = !data.tienePendientes;
}

window.setListadoData = setListadoData;
