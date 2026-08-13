function createEmptyOverviewData() {
    return {
        inicio: '',
        fin: '',
        comprasInternas: { registros: 0, libras: 0, toneladas: 0, monto: 0 },
        comprasDirectas: { registros: 0, toneladas: 0, monto: 0 },
        productoRastreado: { toneladas: 0, montoPagadoProveedores: 0 },
        corapsaPagado: { registros: 0, toneladas: 0, monto: 0 },
        conciliacion: { diferenciaToneladas: 0, margenBruto: 0 },
        gastos: { registros: 0, monto: 0 },
        planilla: { monto: 0, basePorAsistencia: 0, extras: 0 },
        resultado: { costosOperativos: 0, utilidadNeta: 0 },
        pagosCorapsa: [],
        porDestino: []
    };
}

function normalizarPagoCorapsa(record = {}) {
    return {
        id: record.id,
        fechaPago: String(record.fechaPago ?? record.fecha_pago ?? ''),
        periodoInicio: String(record.periodoInicio ?? record.periodo_inicio ?? ''),
        periodoFin: String(record.periodoFin ?? record.periodo_fin ?? ''),
        referencia: String(record.referencia || ''),
        destino: String(record.destino || ''),
        toneladas: toFiniteNumber(record.toneladas),
        monto: toFiniteNumber(record.monto),
        notas: String(record.notas || ''),
        fileName: String(record.fileName ?? record.file_name ?? 'Sin Archivo'),
        fileMimeType: String(record.fileMimeType ?? record.file_mime_type ?? ''),
        hasFile: Boolean(record.hasFile ?? record.has_file),
        updatedAt: String(record.updatedAt ?? record.updated_at ?? '')
    };
}

function getOverviewSelectedRange() {
    const start = document.getElementById('overview-filter-start')?.value || '';
    const end = document.getElementById('overview-filter-end')?.value || '';
    if (!start || !end) return null;
    if (start > end) return { start, end, invalid: true };
    return { start, end, invalid: false };
}

async function fetchOverview() {
    const range = getOverviewSelectedRange();
    if (!range || range.invalid) {
        overviewData = createEmptyOverviewData();
        corapsaPagosData = [];
        renderOverview();
        if (range?.invalid) mostrarNotificacion('La fecha inicial no puede ser posterior a la fecha final.', 'error');
        return;
    }

    try {
        const result = await apiRequest(
            `/api/overview?inicio=${encodeURIComponent(range.start)}&fin=${encodeURIComponent(range.end)}`
        );
        overviewData = { ...createEmptyOverviewData(), ...(result || {}) };
        corapsaPagosData = Array.isArray(result?.pagosCorapsa)
            ? result.pagosCorapsa.map(normalizarPagoCorapsa)
            : [];
        renderOverview();
    } catch (error) {
        console.error('No se pudo cargar el Overview:', error);
        mostrarNotificacion(error.message || 'No se pudo cargar el Overview.', 'error');
    }
}

function setOverviewText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function formatOverviewTons(value) {
    return `${toFiniteNumber(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TON`;
}

function formatOverviewMoney(value) {
    return `L ${formatMoney(value)}`;
}

function formatSignedOverviewTons(value) {
    const number = toFiniteNumber(value);
    const sign = number > 0 ? '+' : '';
    return `${sign}${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TON`;
}

function applyOverviewResultTone(id, value, { inverse = false } = {}) {
    const element = document.getElementById(id);
    if (!element) return;
    const positive = inverse ? value <= 0 : value >= 0;
    element.classList.toggle('text-emerald-700', positive);
    element.classList.toggle('text-red-700', !positive);
}

function getCorapsaPaymentAttachmentUrl(record) {
    const version = encodeURIComponent(record.updatedAt || '0');
    return buildApiUrl(`/api/corapsa-pagos/${encodeURIComponent(record.id)}/archivo?v=${version}`);
}

function renderCorapsaPaymentAttachment(record) {
    if (!record.hasFile) {
        return `<button type="button" onclick="abrirPagoCorapsaModal('${escapeHtml(record.id)}')"
            class="w-20 h-12 rounded-lg border border-dashed border-indigo-200 bg-indigo-50 text-indigo-700 flex flex-col items-center justify-center hover:shadow"
            title="Editar para adjuntar estado de cuenta">
            <span class="material-icons text-[19px]">upload_file</span><span class="text-[8px] font-bold uppercase">Adjuntar</span>
        </button>`;
    }

    if (isImageAttachmentType(record.fileMimeType)) {
        return `<button type="button" onclick="abrirVisorPagoCorapsa('${escapeHtml(record.id)}')"
            class="relative w-20 h-12 rounded-lg overflow-hidden border bg-gray-100 hover:shadow" title="Abrir ${escapeHtml(record.fileName)}">
            <img src="${escapeHtml(getCorapsaPaymentAttachmentUrl(record))}" alt="${escapeHtml(record.fileName)}" class="w-full h-full object-cover">
            <span class="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[8px] font-bold">ESTADO</span>
        </button>`;
    }

    return `<button type="button" onclick="abrirVisorPagoCorapsa('${escapeHtml(record.id)}')"
        class="w-20 h-12 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 flex flex-col items-center justify-center hover:shadow" title="Abrir ${escapeHtml(record.fileName)}">
        <span class="material-icons text-[20px]">picture_as_pdf</span><span class="text-[8px] font-bold uppercase">PDF</span>
    </button>`;
}

function renderOverviewPaymentsTable() {
    const tbody = document.getElementById('overview-payments-body');
    if (!tbody) return;

    if (corapsaPagosData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="p-8 text-center text-gray-400">No hay ventas/pagos cuyo período esté completamente dentro de las fechas seleccionadas.</td></tr>';
        return;
    }

    tbody.innerHTML = corapsaPagosData.map(record => `
        <tr class="border-b hover:bg-indigo-50/50">
            <td class="p-3 font-mono text-xs text-gray-600">${escapeHtml(formatDateForDisplay(record.periodoInicio))}<br><span class="text-gray-400">a</span> ${escapeHtml(formatDateForDisplay(record.periodoFin))}</td>
            <td class="p-3 font-mono text-xs">${escapeHtml(formatDateForDisplay(record.fechaPago))}</td>
            <td class="p-3"><span class="inline-flex items-center bg-indigo-100 text-indigo-900 border border-indigo-200 px-2 py-1 rounded font-bold text-xs uppercase">${escapeHtml(record.destino || '-')}</span></td>
            <td class="p-3 font-bold text-gray-800">${escapeHtml(record.referencia || 'Sin referencia')}</td>
            <td class="p-3 text-right font-mono font-bold text-indigo-800">${record.toneladas.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td class="p-3 text-right font-mono font-black text-emerald-700">L ${formatMoney(record.monto)}</td>
            <td class="p-3 text-xs text-gray-500 max-w-[220px]">${escapeHtml(record.notas || '-')}</td>
            <td class="p-3"><div class="flex justify-center">${renderCorapsaPaymentAttachment(record)}</div></td>
            <td class="p-3 text-center whitespace-nowrap">
                <button type="button" onclick="abrirPagoCorapsaModal('${escapeHtml(record.id)}')" class="text-blue-500 hover:text-blue-800 mx-1" title="Editar"><span class="material-icons text-[18px]">edit</span></button>
                <button type="button" onclick="abrirActionModal('delete_corapsa_pago', '${escapeHtml(record.id)}')" class="text-red-400 hover:text-red-700 mx-1" title="Eliminar"><span class="material-icons text-[18px]">delete</span></button>
            </td>
        </tr>
    `).join('');
}

function renderOverviewByDestino() {
    const tbody = document.getElementById('overview-destino-body');
    if (!tbody) return;

    const rows = Array.isArray(overviewData?.porDestino) ? overviewData.porDestino : [];
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-gray-400">Sin recibos ni ventas registradas en el período seleccionado.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(row => {
        const diferencia = toFiniteNumber(row.diferenciaToneladasDirecto);
        const margen = toFiniteNumber(row.margenDirecto);
        return `
            <tr class="border-b hover:bg-slate-50">
                <td class="p-3"><span class="inline-flex items-center bg-slate-100 text-slate-800 border border-slate-200 px-2 py-1 rounded font-bold text-xs uppercase">${escapeHtml(row.destino)}</span></td>
                <td class="p-3 text-right font-mono">${toFiniteNumber(row.compraDirecto?.toneladas).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="p-3 text-right font-mono">L ${formatMoney(row.compraDirecto?.monto)}</td>
                <td class="p-3 text-right font-mono">${toFiniteNumber(row.venta?.toneladas).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="p-3 text-right font-mono">L ${formatMoney(row.venta?.monto)}</td>
                <td class="p-3 text-right font-mono font-bold ${diferencia >= 0 ? 'text-emerald-700' : 'text-red-700'}">${diferencia > 0 ? '+' : ''}${diferencia.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="p-3 text-right font-mono font-bold ${margen >= 0 ? 'text-emerald-700' : 'text-red-700'}">L ${formatMoney(margen)}</td>
            </tr>`;
    }).join('');
}

function renderOverview() {
    const data = overviewData || createEmptyOverviewData();
    setOverviewText('overview-inhouse-tons', formatOverviewTons(data.comprasInternas?.toneladas));
    setOverviewText('overview-inhouse-money', formatOverviewMoney(data.comprasInternas?.monto));
    setOverviewText('overview-direct-tons', formatOverviewTons(data.comprasDirectas?.toneladas));
    setOverviewText('overview-direct-money', formatOverviewMoney(data.comprasDirectas?.monto));
    setOverviewText('overview-tracked-tons', formatOverviewTons(data.productoRastreado?.toneladas));
    setOverviewText('overview-supplier-cost', formatOverviewMoney(data.productoRastreado?.montoPagadoProveedores));
    setOverviewText('overview-corapsa-tons', formatOverviewTons(data.corapsaPagado?.toneladas));
    setOverviewText('overview-corapsa-money', formatOverviewMoney(data.corapsaPagado?.monto));
    setOverviewText('overview-ton-difference', formatSignedOverviewTons(data.conciliacion?.diferenciaToneladas));
    setOverviewText('overview-gross-margin', formatOverviewMoney(data.conciliacion?.margenBruto));
    setOverviewText('overview-expenses', formatOverviewMoney(data.gastos?.monto));
    setOverviewText('overview-payroll', formatOverviewMoney(data.planilla?.monto));
    setOverviewText('overview-operating-costs', formatOverviewMoney(data.resultado?.costosOperativos));
    setOverviewText('overview-net-profit', formatOverviewMoney(data.resultado?.utilidadNeta));

    const tonDifference = toFiniteNumber(data.conciliacion?.diferenciaToneladas);
    const netProfit = toFiniteNumber(data.resultado?.utilidadNeta);
    applyOverviewResultTone('overview-ton-difference', tonDifference, { inverse: true });
    applyOverviewResultTone('overview-net-profit', netProfit);
    applyOverviewResultTone('overview-gross-margin', toFiniteNumber(data.conciliacion?.margenBruto));

    const status = document.getElementById('overview-reconciliation-status');
    if (status) {
        const absoluteDifference = Math.abs(tonDifference);
        const matched = absoluteDifference <= 0.01;
        status.className = `rounded-xl border px-4 py-3 flex items-start gap-3 ${matched ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-900'}`;
        status.innerHTML = `<span class="material-icons">${matched ? 'verified' : 'warning_amber'}</span><div><p class="font-black">${matched ? 'Básculas conciliadas' : 'Existe una diferencia de básculas'}</p><p class="text-xs mt-1">Venta Total de Palma: ${formatOverviewTons(data.corapsaPagado?.toneladas)}. Compra Total de Palma: ${formatOverviewTons(data.productoRastreado?.toneladas)}. Diferencia: ${formatSignedOverviewTons(tonDifference)}.</p></div>`;
    }

    setOverviewText('overview-formula-suppliers', `${formatOverviewMoney(data.comprasInternas?.monto)} + ${formatOverviewMoney(data.comprasDirectas?.monto)} = ${formatOverviewMoney(data.productoRastreado?.montoPagadoProveedores)}`);
    setOverviewText('overview-formula-margin', `${formatOverviewMoney(data.corapsaPagado?.monto)} − ${formatOverviewMoney(data.productoRastreado?.montoPagadoProveedores)} = ${formatOverviewMoney(data.conciliacion?.margenBruto)}`);
    setOverviewText('overview-formula-profit', `${formatOverviewMoney(data.conciliacion?.margenBruto)} − ${formatOverviewMoney(data.gastos?.monto)} − ${formatOverviewMoney(data.planilla?.monto)} = ${formatOverviewMoney(data.resultado?.utilidadNeta)}`);

    renderOverviewPaymentsTable();
    renderOverviewByDestino();
}

function irMesActualOverview() {
    const range = getCurrentMonthRange();
    document.getElementById('overview-filter-start').value = range.start;
    document.getElementById('overview-filter-end').value = range.end;
    fetchOverview();
}

function updateOverviewCurrentFile(record) {
    const text = document.getElementById('overview-payment-current-file');
    const preview = document.getElementById('overview-payment-current-preview');
    if (text) text.textContent = record?.hasFile ? record.fileName : 'Sin archivo guardado';
    if (preview) {
        preview.classList.toggle('hidden', !record?.hasFile);
        preview.onclick = record?.hasFile ? () => abrirVisorPagoCorapsa(record.id) : null;
    }
}

function abrirPagoCorapsaModal(id = null) {
    const record = id == null ? null : corapsaPagosData.find(item => sameRecordId(item.id, id));
    if (id != null && !record) return mostrarNotificacion('Pago no encontrado.', 'error');

    document.getElementById('overview-payment-modal-title').textContent = record ? 'Editar Venta / Pago Recibido' : 'Registrar Venta / Pago Recibido';
    document.getElementById('overview-payment-id').value = record?.id ?? '';
    const selectedRange = getOverviewSelectedRange();
    const currentMonth = getCurrentMonthRange();
    document.getElementById('overview-payment-period-start').value = record?.periodoInicio || selectedRange?.start || currentMonth.start;
    document.getElementById('overview-payment-period-end').value = record?.periodoFin || selectedRange?.end || currentMonth.end;
    document.getElementById('overview-payment-date').value = record?.fechaPago || getLocalIsoDate();
    ensureDestinoOption('overview-payment-destino', record?.destino || '');
    document.getElementById('overview-payment-destino').value = record?.destino || '';
    document.getElementById('overview-payment-reference').value = record?.referencia || '';
    document.getElementById('overview-payment-tons').value = record ? formatNumberForInput(record.toneladas, 2) : '';
    document.getElementById('overview-payment-amount').value = record ? formatNumberForInput(record.monto, 2) : '';
    document.getElementById('overview-payment-notes').value = record?.notas || '';
    document.getElementById('overview-payment-file').value = '';
    document.getElementById('overview-payment-justification').value = '';
    document.getElementById('overview-payment-justification-container').classList.toggle('hidden', !record);
    updateOverviewCurrentFile(record);
    document.getElementById('overview-payment-modal').classList.remove('hidden');
}

function cerrarPagoCorapsaModal() {
    document.getElementById('overview-payment-modal').classList.add('hidden');
}

async function guardarPagoCorapsa() {
    const id = document.getElementById('overview-payment-id').value.trim();
    const file = document.getElementById('overview-payment-file').files?.[0] || null;
    const payload = {
        periodoInicio: document.getElementById('overview-payment-period-start').value,
        periodoFin: document.getElementById('overview-payment-period-end').value,
        fechaPago: document.getElementById('overview-payment-date').value,
        destino: document.getElementById('overview-payment-destino').value.trim(),
        referencia: document.getElementById('overview-payment-reference').value.trim(),
        toneladas: parseFormattedNumber(document.getElementById('overview-payment-tons').value),
        monto: parseFormattedNumber(document.getElementById('overview-payment-amount').value),
        notas: document.getElementById('overview-payment-notes').value.trim(),
        justificacion: document.getElementById('overview-payment-justification').value.trim()
    };

    if (!payload.periodoInicio || !payload.periodoFin || !payload.fechaPago) return mostrarNotificacion('Complete las fechas del pago.', 'error');
    if (!payload.destino) return mostrarNotificacion('Seleccione el destino.', 'error');
    if (payload.periodoInicio > payload.periodoFin) return mostrarNotificacion('El inicio del período no puede ser posterior al final.', 'error');
    if (!Number.isFinite(payload.toneladas) || payload.toneladas <= 0) return mostrarNotificacion('Ingrese toneladas válidas.', 'error');
    if (!Number.isFinite(payload.monto) || payload.monto <= 0) return mostrarNotificacion('Ingrese un monto válido.', 'error');
    if (id && !payload.justificacion) return mostrarNotificacion('La justificación es obligatoria al editar.', 'error');

    const button = document.getElementById('overview-payment-save-button');
    button.disabled = true;
    button.textContent = 'Guardando...';
    try {
        if (file) payload.archivo = await buildAttachmentPayload(file);
        await apiRequest(id ? `/api/corapsa-pagos/${encodeURIComponent(id)}` : '/api/corapsa-pagos', {
            method: id ? 'PUT' : 'POST',
            body: payload,
            timeoutMs: 30000
        });
        cerrarPagoCorapsaModal();
        await fetchOverview();
        mostrarNotificacion(id ? 'Venta / pago actualizado.' : 'Venta / pago registrado.');
    } catch (error) {
        console.error('No se pudo guardar el pago de Corapsa:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el pago.', 'error');
    } finally {
        button.disabled = false;
        button.textContent = 'Guardar';
    }
}

function abrirVisorPagoCorapsa(id) {
    const record = corapsaPagosData.find(item => sameRecordId(item.id, id));
    if (!record?.hasFile) return mostrarNotificacion('No hay un estado de cuenta disponible.', 'error');
    openAttachmentViewer({
        module: 'overview', id: record.id, type: 'estado',
        fileName: record.fileName, mimeType: record.fileMimeType,
        url: getCorapsaPaymentAttachmentUrl(record)
    });
}

async function eliminarPagoCorapsaServidor(id, justificacion) {
    await apiRequest(`/api/corapsa-pagos/${encodeURIComponent(id)}`, {
        method: 'DELETE', body: { justificacion }
    });
    await fetchOverview();
}
