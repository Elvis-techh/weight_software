function normalizarTransaccion(record = {}) {
    return {
        id: record.id,
        fecha: String(record.fecha || ''),
        hora: String(record.hora || ''),
        placa: String(record.placa || 'S/P'),
        conductor: String(record.conductor || 'Desconocido'),
        clienteNombre: String(record.clienteNombre ?? record.cliente_nombre ?? ''),
        pesoBruto: toFiniteNumber(record.pesoBruto ?? record.peso_bruto),
        pesoTara: toFiniteNumber(record.pesoTara ?? record.peso_tara),
        neto: toFiniteNumber(record.neto),
        precioAplicado: toFiniteNumber(record.precioAplicado ?? record.precio_aplicado),
        total: toFiniteNumber(record.total),
        unidad: record.unidad === 'quintal' ? 'quintal' : 'tonelada'
    };
}

function updateReportesTab() {
    const tbody = document.getElementById('reports-table-body');
    if (!tbody) return;

    const startDate = document.getElementById('filter-start')?.value || '';
    const endDate = document.getElementById('filter-end')?.value || '';
    const customerSearch = (document.getElementById('filter-client')?.value || '')
        .trim()
        .toLocaleLowerCase('es');

    const filteredData = transaccionesData.filter(transaction => {
        if (startDate && transaction.fecha < startDate) return false;
        if (endDate && transaction.fecha > endDate) return false;
        if (customerSearch && !transaction.clienteNombre.toLocaleLowerCase('es').includes(customerSearch)) return false;
        return true;
    });

    const totalLbs = filteredData.reduce((sum, item) => sum + item.neto, 0);
    const totalDinero = filteredData.reduce((sum, item) => sum + item.total, 0);

    document.getElementById('rep-camiones').textContent = String(filteredData.length);
    document.getElementById('rep-toneladas').textContent = calculateMetricTons(totalLbs, { truncate: true })
        .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('rep-libras').textContent = `${totalLbs.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    })} LBS`;
    document.getElementById('rep-dinero').textContent = `L ${formatMoney(totalDinero)}`;

    if (filteredData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-gray-400">Sin transacciones para los filtros seleccionados.</td></tr>';
        return;
    }

    tbody.innerHTML = filteredData.map(transaction => {
        const identification = transaction.placa !== 'S/P'
            ? transaction.placa
            : transaction.conductor !== 'Desconocido'
                ? transaction.conductor
                : 'S/P';
        const unitLabel = transaction.unidad === 'quintal' ? 'QQ' : 'TON';
        const metricTons = calculateMetricTons(transaction.neto, { truncate: true });

        return `
            <tr class="hover:bg-gray-50 border-b border-gray-100">
                <td class="p-4 font-mono text-gray-500 text-xs">${escapeHtml(formatDateForDisplay(transaction.fecha))}<br>${escapeHtml(transaction.hora)}</td>
                <td class="p-4 font-bold text-gray-800 uppercase">${escapeHtml(identification)}</td>
                <td class="p-4 text-gray-600 text-sm">${escapeHtml(transaction.clienteNombre)}</td>
                <td class="p-4 text-right font-mono font-bold text-gray-800">${transaction.neto.toLocaleString('en-US')} LBS</td>
                <td class="p-4 text-right font-mono font-bold text-brand-700">${metricTons.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TON</td>
                <td class="p-4 text-right font-mono text-gray-500 text-xs">L ${formatMoney(transaction.precioAplicado)} / ${unitLabel}</td>
                <td class="p-4 text-right font-mono font-bold text-green-700">L ${formatMoney(transaction.total)}</td>
                <td class="p-4 flex justify-center gap-2">
                    <button type="button" onclick="imprimirRecibo('${escapeHtml(transaction.id)}')" class="text-gray-500 hover:text-gray-900 transition-colors" aria-label="Imprimir recibo"><span class="material-icons">print</span></button>
                    <button type="button" onclick="eliminarTransaccion('${escapeHtml(transaction.id)}')" class="text-red-400 hover:text-red-700 transition-colors" aria-label="Eliminar reporte"><span class="material-icons">delete</span></button>
                </td>
            </tr>
        `;
    }).join('');
}

function imprimirRecibo(id) {
    const transaction = transaccionesData.find(item => sameRecordId(item.id, id));
    if (!transaction) return mostrarNotificacion('Transacción no encontrada.', 'error');

    const unitLabel = transaction.unidad === 'quintal' ? 'Quintal' : 'Tonelada';
    const quantity = calculateBillableQuantity(transaction.neto, transaction.unidad);

    document.getElementById('print-content').innerHTML = `
        <p><strong>Fecha/Hora:</strong> ${escapeHtml(formatDateForDisplay(transaction.fecha))} ${escapeHtml(transaction.hora)}</p>
        <p><strong>Productor:</strong> ${escapeHtml(transaction.clienteNombre)}</p>
        <p><strong>Vehículo/Chofer:</strong> ${escapeHtml(transaction.placa)} / ${escapeHtml(transaction.conductor)}</p>
        <hr class="my-2">
        <p><strong>Peso Bruto:</strong> ${transaction.pesoBruto.toLocaleString('en-US')} LBS</p>
        <p><strong>Peso Tara:</strong> ${transaction.pesoTara.toLocaleString('en-US')} LBS</p>
        <p><strong>Peso Neto:</strong> ${transaction.neto.toLocaleString('en-US')} LBS</p>
        <p><strong>${unitLabel}s:</strong> ${quantity.toFixed(2)}</p>
        <hr class="my-2">
        <p><strong>Precio Aplicado:</strong> L ${formatMoney(transaction.precioAplicado)} / ${unitLabel}</p>
        <p class="text-xl"><strong>Total Pagado:</strong> L ${formatMoney(transaction.total)}</p>
    `;

    window.print();
}

function eliminarTransaccion(id) {
    abrirActionModal('delete_reporte', id);
}

async function eliminarTransaccionServidor(id, justificacion) {
    await apiRequest(`/api/transacciones/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });

    transaccionesData = transaccionesData.filter(item => !sameRecordId(item.id, id));
    updateReportesTab();
}