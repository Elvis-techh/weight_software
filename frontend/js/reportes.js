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

// Holds whatever updateReportesTab() last filtered, so "Imprimir Listado"
// can reuse it directly instead of re-reading the filter inputs and
// re-filtering transaccionesData itself.
let ultimoFiltroReportes = { filteredData: [], startDate: '', endDate: '', customerSearchRaw: '' };

// Shared by the on-screen table row and the listado print payload, so the
// identification fallback, unit label, and metric-ton conversion only live
// in one place.
function formatearFilaReporte(transaction) {
    const identification = transaction.placa !== 'S/P'
        ? transaction.placa
        : transaction.conductor !== 'Desconocido'
            ? transaction.conductor
            : 'S/P';
    const unitLabel = transaction.unidad === 'quintal' ? 'QQ' : 'TON';
    const metricTons = calculateMetricTons(transaction.neto, { truncate: true });

    return {
        identification,
        unitLabel,
        metricTons,
        fechaDisplay: formatDateForDisplay(transaction.fecha),
        netoLabel: `${transaction.neto.toLocaleString('en-US')} LBS`,
        toneladasLabel: `${metricTons.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TON`,
        precioLabel: `L ${formatMoney(transaction.precioAplicado)} / ${unitLabel}`,
        totalLabel: `L ${formatMoney(transaction.total)}`
    };
}

function updateReportesTab() {
    const tbody = document.getElementById('reports-table-body');
    if (!tbody) return;

    const startDate = document.getElementById('filter-start')?.value || '';
    const endDate = document.getElementById('filter-end')?.value || '';
    const customerSearchRaw = document.getElementById('filter-client')?.value || '';
    const customerSearch = customerSearchRaw.trim().toLocaleLowerCase('es');

    const filteredData = transaccionesData.filter(transaction => {
        if (startDate && transaction.fecha < startDate) return false;
        if (endDate && transaction.fecha > endDate) return false;
        if (customerSearch && !transaction.clienteNombre.toLocaleLowerCase('es').includes(customerSearch)) return false;
        return true;
    });

    ultimoFiltroReportes = { filteredData, startDate, endDate, customerSearchRaw };
    const listadoButton = document.getElementById('btn-imprimir-listado');
    if (listadoButton) listadoButton.disabled = filteredData.length === 0;

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
        const fila = formatearFilaReporte(transaction);

        return `
            <tr class="hover:bg-gray-50 border-b border-gray-100">
                <td class="p-4 font-mono text-gray-500 text-xs">${escapeHtml(fila.fechaDisplay)}<br>${escapeHtml(transaction.hora)}</td>
                <td class="p-4 font-bold text-gray-800 uppercase">${escapeHtml(fila.identification)}</td>
                <td class="p-4 text-gray-600 text-sm">${escapeHtml(transaction.clienteNombre)}</td>
                <td class="p-4 text-right font-mono font-bold text-gray-800">${escapeHtml(fila.netoLabel)}</td>
                <td class="p-4 text-right font-mono font-bold text-brand-700">${escapeHtml(fila.toneladasLabel)}</td>
                <td class="p-4 text-right font-mono text-gray-500 text-xs">${escapeHtml(fila.precioLabel)}</td>
                <td class="p-4 text-right font-mono font-bold text-green-700">${escapeHtml(fila.totalLabel)}</td>
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

// Performs the real print IPC call for a receipt; only invoked once the
// operator confirms "Imprimir" in the preview modal (see printPreview.js).
async function ejecutarImpresionRecibo(payload) {
    const result = await window.electronAPI.printReceipt(payload);
    // No printer was available, so main.js saved the receipt as a PDF instead
    // of printing it — let the operator know where to find it.
    if (result?.mode === 'pdf') {
        mostrarNotificacion(`No se encontró una impresora. Boleta guardada como PDF en: ${result.path}`, 'error');
    }
}

function imprimirRecibo(id) {
    const transaction = transaccionesData.find(item => sameRecordId(item.id, id));
    if (!transaction) return mostrarNotificacion('Transacción no encontrada.', 'error');

    if (typeof window.electronAPI?.printReceipt !== 'function') {
        return mostrarNotificacion(
            'La impresión de boletas solo está disponible dentro de la aplicación de escritorio.',
            'error'
        );
    }

    // Finalized offline: the boleta number is this station's best local
    // prediction, not yet confirmed by the server (see offlineQueue.js). Say
    // so before it goes to paper, since it's the one thing that could change.
    if (transaction.pendingSync) {
        mostrarNotificacion(
            `Boleta #${transaction.numeroBoleta} provisional: se generó sin conexión y aún no fue confirmada por el servidor.`,
            'error'
        );
    }

    const esQuintal = transaction.unidad === 'quintal';
    // The printed quantity/price columns must match how this client is actually
    // billed — quintales for unidad === 'quintal', metric tons otherwise — since
    // Total LPS = cantidad × precio has to reconcile with what the client paid.
    const cantidad = calculateBillableQuantity(transaction.neto, transaction.unidad);
    // Rate is derived from the actual total (rather than reusing precioAplicado
    // directly) so it stays correct even if a record's stored price and total
    // ever drift apart.
    const precioPorUnidad = cantidad > 0 ? transaction.total / cantidad : 0;

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
        tm: `${cantidad.toFixed(2)} ${esQuintal ? 'QQ' : 'TM'}`,
        precioTM: `${formatMoney(precioPorUnidad)} Lps`,
        unidadCantidad: esQuintal ? 'QQ' : 'TM',
        unidadPrecio: esQuintal ? 'Precio / QQ' : 'Precio / TM',
        totalLps: `${formatMoney(transaction.total)} Lps`
    };

    mostrarVistaPrevia({
        template: 'receipt',
        payload,
        title: `Vista previa - Boleta No. ${payload.numero || ''}`,
        printAction: () => ejecutarImpresionRecibo(payload)
    });
}

// Builds the pre-formatted payload for the listado print/preview from
// whatever updateReportesTab() last filtered (see ultimoFiltroReportes) —
// never re-reads the filter inputs or re-filters transaccionesData itself.
function construirPayloadListado() {
    const { filteredData, startDate, endDate, customerSearchRaw } = ultimoFiltroReportes;

    const totalNeto = filteredData.reduce((sum, item) => sum + item.neto, 0);
    const totalToneladas = calculateMetricTons(totalNeto, { truncate: true });
    const totalDinero = filteredData.reduce((sum, item) => sum + item.total, 0);
    const tienePendientes = filteredData.some(item => item.pendingSync);

    const rows = filteredData.map(transaction => {
        const fila = formatearFilaReporte(transaction);
        return {
            fecha: fila.fechaDisplay,
            hora: transaction.hora,
            cliente: transaction.clienteNombre,
            neto: fila.netoLabel,
            toneladas: fila.toneladasLabel,
            precioUnidad: fila.precioLabel,
            total: fila.totalLabel,
            pendingSync: Boolean(transaction.pendingSync)
        };
    });

    return {
        generatedAt: new Date().toLocaleString('es-HN'),
        filtroCliente: customerSearchRaw.trim() || 'Todos',
        filtroDesde: startDate ? formatDateForDisplay(startDate) : 'Sin límite',
        filtroHasta: endDate ? formatDateForDisplay(endDate) : 'Sin límite',
        totalRegistros: String(rows.length),
        rows,
        totalNeto: `${totalNeto.toLocaleString('en-US')} LBS`,
        totalToneladas: `${totalToneladas.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TON`,
        totalDinero: `L ${formatMoney(totalDinero)}`,
        tienePendientes
    };
}

// Performs the real print IPC call for the listado; only invoked once the
// operator confirms "Imprimir" in the preview modal (see printPreview.js).
async function ejecutarImpresionListado(payload) {
    const result = await window.electronAPI.printListado(payload);
    if (result?.mode === 'pdf') {
        mostrarNotificacion(`No se encontró una impresora. Listado guardado como PDF en: ${result.path}`, 'error');
    }
}

// Performs the "Guardar" IPC call — lets the operator pick where the PDF goes,
// via the native Save dialog. Returns { cancelled: true } (instead of just
// resolving) when the operator closes that dialog without picking a
// location, so the preview modal (see printPreview.js) knows to stay open
// instead of treating a cancel as a completed save.
async function ejecutarGuardadoListado(payload) {
    const result = await window.electronAPI.saveListadoAsPdf(payload);
    if (result?.mode === 'cancelled') return { cancelled: true };
    mostrarNotificacion(`Listado guardado en: ${result.path}`);
    return result;
}

function imprimirListadoReportes() {
    if (typeof window.electronAPI?.printListado !== 'function') {
        return mostrarNotificacion(
            'La impresión de listados solo está disponible dentro de la aplicación de escritorio.',
            'error'
        );
    }

    if (ultimoFiltroReportes.filteredData.length === 0) {
        return mostrarNotificacion('No hay transacciones para el filtro actual.', 'error');
    }

    const payload = construirPayloadListado();

    mostrarVistaPrevia({
        template: 'listado',
        payload,
        title: `Vista previa - Listado (${payload.totalRegistros} registros)`,
        printAction: () => ejecutarImpresionListado(payload),
        saveAction: () => ejecutarGuardadoListado(payload)
    });
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