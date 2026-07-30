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
                    <button type="button" onclick="abrirReporteModal('${escapeHtml(transaction.id)}')" class="text-blue-500 hover:text-blue-800 transition-colors" aria-label="Editar reporte"><span class="material-icons">edit</span></button>
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

function abrirReporteModal(id) {
    const transaction = transaccionesData.find(item => sameRecordId(item.id, id));
    if (!transaction) return mostrarNotificacion('Transacción no encontrada.', 'error');

    document.getElementById('reporte-edit-id').value = transaction.id;
    document.getElementById('reporte-fecha').value = transaction.fecha;
    document.getElementById('reporte-hora').value = transaction.hora;
    document.getElementById('reporte-placa').value = transaction.placa === 'S/P' ? '' : transaction.placa;
    document.getElementById('reporte-conductor').value = transaction.conductor === 'Desconocido' ? '' : transaction.conductor;
    document.getElementById('reporte-cliente').value = transaction.clienteNombre;
    document.getElementById('reporte-unidad').value = transaction.unidad;
    document.getElementById('reporte-peso-bruto').value = formatNumberForInput(transaction.pesoBruto, 0);
    document.getElementById('reporte-peso-tara').value = formatNumberForInput(transaction.pesoTara, 0);
    document.getElementById('reporte-precio').value = formatNumberForInput(transaction.precioAplicado, 2);
    document.getElementById('reporte-justificacion').value = '';

    calcularPreviewReporte();
    document.getElementById('reporte-modal').classList.remove('hidden');
}

function cerrarReporteModal() {
    document.getElementById('reporte-modal').classList.add('hidden');
}

function calcularPreviewReporte() {
    const pesoBruto = parseFormattedNumber(document.getElementById('reporte-peso-bruto').value);
    const pesoTara = parseFormattedNumber(document.getElementById('reporte-peso-tara').value);
    const precio = parseFormattedNumber(document.getElementById('reporte-precio').value);
    const unidad = document.getElementById('reporte-unidad').value;

    const neto = Number.isFinite(pesoBruto) && Number.isFinite(pesoTara)
        ? Math.abs(pesoBruto - pesoTara)
        : 0;
    const total = calculatePayment(neto, precio, unidad);

    document.getElementById('reporte-neto-preview').textContent = `${neto.toLocaleString('en-US')} LBS`;
    document.getElementById('reporte-total-preview').textContent = `L ${formatMoney(total)}`;

    return { neto, total };
}

async function guardarReporteEdit() {
    const id = document.getElementById('reporte-edit-id').value;
    const payload = {
        fecha: document.getElementById('reporte-fecha').value,
        hora: document.getElementById('reporte-hora').value.trim(),
        placa: document.getElementById('reporte-placa').value.trim().toUpperCase(),
        conductor: document.getElementById('reporte-conductor').value.trim(),
        clienteNombre: document.getElementById('reporte-cliente').value.trim(),
        unidad: document.getElementById('reporte-unidad').value,
        pesoBruto: parseFormattedNumber(document.getElementById('reporte-peso-bruto').value),
        pesoTara: parseFormattedNumber(document.getElementById('reporte-peso-tara').value),
        precioAplicado: parseFormattedNumber(document.getElementById('reporte-precio').value),
        justificacion: document.getElementById('reporte-justificacion').value.trim()
    };

    if (!payload.fecha || !payload.hora) return mostrarNotificacion('Complete la fecha y la hora.', 'error');
    if (!payload.clienteNombre) return mostrarNotificacion('El nombre del cliente es obligatorio.', 'error');
    if (!Number.isFinite(payload.pesoBruto) || payload.pesoBruto <= 0) return mostrarNotificacion('Ingrese un peso bruto válido.', 'error');
    if (!Number.isFinite(payload.pesoTara) || payload.pesoTara <= 0) return mostrarNotificacion('Ingrese un peso tara válido.', 'error');
    if (Math.abs(payload.pesoBruto - payload.pesoTara) <= 0) return mostrarNotificacion('El peso neto debe ser mayor que cero.', 'error');
    if (!Number.isFinite(payload.precioAplicado) || payload.precioAplicado < 0) return mostrarNotificacion('Ingrese un precio válido.', 'error');
    if (!payload.justificacion) return mostrarNotificacion('Debe ingresar una justificación para editar la transacción.', 'error');

    const saveButton = document.getElementById('reporte-save-button');
    try {
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = 'Guardando...';
        }

        const result = await apiRequest(`/api/transacciones/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: payload
        });

        const saved = normalizarTransaccion(result?.transaccion || result);
        const index = transaccionesData.findIndex(item => sameRecordId(item.id, saved.id));
        if (index >= 0) transaccionesData[index] = saved;

        updateReportesTab();
        cerrarReporteModal();
        mostrarNotificacion('Transacción actualizada exitosamente.');
    } catch (error) {
        console.error('Error al editar la transacción:', error);
        mostrarNotificacion(error.message || 'No se pudo actualizar la transacción.', 'error');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar Cambios';
        }
    }
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