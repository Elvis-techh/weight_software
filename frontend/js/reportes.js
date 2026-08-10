function normalizarTransaccion(record = {}) {
    const numeroBoleta = record.numeroBoleta ?? record.numero_boleta;
    return {
        id: record.id,
        fecha: String(record.fecha || ''),
        hora: String(record.hora || ''),
        fechaEntrada: String(record.fechaEntrada ?? record.fecha_entrada ?? ''),
        horaEntrada: String(record.horaEntrada ?? record.hora_entrada ?? ''),
        placa: String(record.placa || 'S/P'),
        conductor: String(record.conductor || 'Desconocido'),
        clienteNombre: String(record.clienteNombre ?? record.cliente_nombre ?? ''),
        identidad: String(record.identidad || ''),
        numeroBoleta: numeroBoleta == null ? null : Number(numeroBoleta),
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

function formatFechaHoraForReceipt(fecha, hora) {
    const datePart = fecha ? formatDateForDisplay(fecha) : '';
    const timePart = String(hora || '').trim();
    return [datePart, timePart].filter(Boolean).join(' ');
}

async function imprimirRecibo(id) {
    const transaction = transaccionesData.find(item => sameRecordId(item.id, id));
    if (!transaction) return mostrarNotificacion('Transacción no encontrada.', 'error');

    if (typeof window.electronAPI?.printReceipt !== 'function') {
        return mostrarNotificacion(
            'La impresión de boletas solo está disponible dentro de la aplicación de escritorio.',
            'error'
        );
    }

    const tm = calculateMetricTons(transaction.neto, { truncate: true });
    // The printed ticket always bills per metric ton (its "Precio / TM" column isn't
    // unit-aware), so the rate is derived from the actual total instead of reusing
    // precioAplicado directly, which is only a per-TM figure when unidad === 'tonelada'.
    const precioPorTM = tm > 0 ? transaction.total / tm : 0;

    const payload = {
        numero: transaction.numeroBoleta ?? '',
        fechaDocumento: formatDateForDisplay(transaction.fecha),
        nombre: transaction.conductor,
        identidad: transaction.identidad,
        placa: transaction.placa,
        fechaEntrada: formatFechaHoraForReceipt(transaction.fechaEntrada, transaction.horaEntrada),
        fechaSalida: formatFechaHoraForReceipt(transaction.fecha, transaction.hora),
        cliente: transaction.clienteNombre,
        bruto: `${transaction.pesoBruto.toLocaleString('en-US')} lb`,
        tara: `${transaction.pesoTara.toLocaleString('en-US')} lb`,
        neto: `${transaction.neto.toLocaleString('en-US')} lb`,
        tm: `${tm.toFixed(2)} TM`,
        precioTM: `${formatMoney(precioPorTM)} Lps`,
        totalLps: `${formatMoney(transaction.total)} Lps`
    };

    try {
        const result = await window.electronAPI.printReceipt(payload);
        // No printer was available, so main.js saved the receipt as a PDF instead
        // of printing it — let the operator know where to find it.
        if (result?.mode === 'pdf') {
            mostrarNotificacion(`No se encontró una impresora. Boleta guardada como PDF en: ${result.path}`, 'error');
        }
    } catch (error) {
        console.error('Error al imprimir la boleta:', error);
        mostrarNotificacion(error.message || 'No se pudo imprimir la boleta.', 'error');
    }
}

function abrirReporteModal(id) {
    const transaction = transaccionesData.find(item => sameRecordId(item.id, id));
    if (!transaction) return mostrarNotificacion('Transacción no encontrada.', 'error');

    document.getElementById('reporte-edit-id').value = transaction.id;
    document.getElementById('reporte-fecha').value = transaction.fecha;
    document.getElementById('reporte-hora').value = transaction.hora;
    document.getElementById('reporte-placa').value = transaction.placa === 'S/P' ? '' : transaction.placa;
    document.getElementById('reporte-conductor').value = transaction.conductor === 'Desconocido' ? '' : transaction.conductor;
    document.getElementById('reporte-numero-boleta').value = transaction.numeroBoleta ?? '';
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
        numeroBoleta: parseFormattedNumber(document.getElementById('reporte-numero-boleta').value),
        clienteNombre: document.getElementById('reporte-cliente').value.trim(),
        unidad: document.getElementById('reporte-unidad').value,
        pesoBruto: parseFormattedNumber(document.getElementById('reporte-peso-bruto').value),
        pesoTara: parseFormattedNumber(document.getElementById('reporte-peso-tara').value),
        precioAplicado: parseFormattedNumber(document.getElementById('reporte-precio').value),
        justificacion: document.getElementById('reporte-justificacion').value.trim()
    };

    if (!payload.fecha || !payload.hora) return mostrarNotificacion('Complete la fecha y la hora.', 'error');
    if (!payload.clienteNombre) return mostrarNotificacion('El nombre del cliente es obligatorio.', 'error');
    if (!Number.isInteger(payload.numeroBoleta) || payload.numeroBoleta <= 0) return mostrarNotificacion('Ingrese un número de boleta válido.', 'error');
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