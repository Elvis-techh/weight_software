function normalizarGasto(record = {}) {
    return {
        id: record.id,
        fecha: String(record.fecha || ''),
        monto: toFiniteNumber(record.monto),
        concepto: String(record.concepto || ''),
        justificacion: String(record.justificacion || ''),
        fileName: String(record.fileName ?? record.file_name ?? 'Sin Archivo'),
        fileMimeType: String(record.fileMimeType ?? record.file_mime_type ?? ''),
        hasFile: record.hasFile === true,
        updatedAt: String(record.updatedAt ?? record.updated_at ?? '')
    };
}

function getGastoAttachmentUrl(gasto) {
    const version = encodeURIComponent(gasto.updatedAt || Date.now());
    return buildApiUrl(`/api/gastos/${encodeURIComponent(gasto.id)}/archivo?v=${version}`);
}

function updateGastoModalAttachmentState(gasto) {
    const text = document.getElementById('gastos-current-file');
    const button = document.getElementById('gastos-current-file-preview');
    if (!text || !button) return;

    text.textContent = gasto?.hasFile ? gasto.fileName : 'Sin archivo guardado';
    button.classList.toggle('hidden', !gasto?.hasFile);
    button.onclick = gasto?.hasFile ? () => abrirVisorGasto(gasto.id) : null;
}

function abrirGastosModal(id = null) {
    const gasto = id == null ? null : gastosData.find(item => sameRecordId(item.id, id));
    if (id != null && !gasto) return mostrarNotificacion('Gasto no encontrado.', 'error');

    document.getElementById('gastos-modal-title').textContent = gasto ? 'Editar Gasto' : 'Nuevo Gasto';
    document.getElementById('gastos-edit-id').value = gasto?.id ?? '';
    document.getElementById('gastos-fecha').value = gasto?.fecha || getLocalIsoDate();
    document.getElementById('gastos-monto').value = gasto ? formatNumberForInput(gasto.monto, 2) : '';
    document.getElementById('gastos-concepto').value = gasto?.concepto || '';
    document.getElementById('gastos-justificacion').value = gasto?.justificacion || '';
    document.getElementById('gastos-file').value = '';
    updateGastoModalAttachmentState(gasto);
    document.getElementById('gastos-modal').classList.remove('hidden');
}

function cerrarGastosModal() {
    document.getElementById('gastos-modal').classList.add('hidden');
}

async function guardarGasto() {
    const id = document.getElementById('gastos-edit-id').value;
    const selectedFile = document.getElementById('gastos-file').files[0] || null;

    const payload = {
        fecha: document.getElementById('gastos-fecha').value,
        monto: parseFormattedNumber(document.getElementById('gastos-monto').value),
        concepto: document.getElementById('gastos-concepto').value.trim(),
        justificacion: document.getElementById('gastos-justificacion').value.trim()
    };

    if (!payload.fecha || !payload.concepto) return mostrarNotificacion('Complete los campos obligatorios.', 'error');
    if (!Number.isFinite(payload.monto) || payload.monto <= 0) return mostrarNotificacion('El monto debe ser mayor que cero.', 'error');

    try {
        const archivo = await buildAttachmentPayload(selectedFile);
        if (archivo) payload.archivo = archivo;

        const result = id
            ? await apiRequest(`/api/gastos/${encodeURIComponent(id)}`, { method: 'PUT', body: payload, timeoutMs: 30000 })
            : await apiRequest('/api/gastos', { method: 'POST', body: payload, timeoutMs: 30000 });
        const saved = normalizarGasto(result?.gasto || result);
        const index = gastosData.findIndex(item => sameRecordId(item.id, saved.id));
        if (index >= 0) gastosData[index] = saved;
        else gastosData.unshift(saved);

        renderGastos();
        cerrarGastosModal();
        mostrarNotificacion(id ? 'Gasto y archivo actualizados.' : 'Gasto registrado.');
    } catch (error) {
        console.error('Error al guardar gasto:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el gasto.', 'error');
    }
}

function abrirVisorGasto(id) {
    const gasto = gastosData.find(item => sameRecordId(item.id, id));
    if (!gasto) return mostrarNotificacion('Gasto no encontrado.', 'error');
    if (!gasto.hasFile) return mostrarNotificacion('No hay un archivo disponible para visualizar.', 'error');

    openAttachmentViewer({
        module: 'gasto',
        id: gasto.id,
        type: 'gasto',
        fileName: gasto.fileName,
        mimeType: gasto.fileMimeType,
        url: getGastoAttachmentUrl(gasto)
    });
}

function renderGastoAttachmentThumbnail(gasto) {
    if (!gasto.hasFile) {
        const legacyName = gasto.fileName && gasto.fileName !== 'Sin Archivo' ? gasto.fileName : '';
        return `
            <button type="button" onclick="abrirGastosModal('${escapeHtml(gasto.id)}')"
                title="${legacyName ? `El contenido de ${escapeHtml(legacyName)} no está guardado. Edite el gasto para volver a adjuntarlo.` : 'Editar gasto para adjuntar recibo'}"
                class="w-24 h-16 rounded-lg border border-dashed border-red-200 bg-red-50 text-red-600 flex flex-col items-center justify-center hover:shadow transition-shadow">
                <span class="material-icons text-[22px]">${legacyName ? 'cloud_upload' : 'add_photo_alternate'}</span>
                <span class="text-[9px] font-bold uppercase mt-1">${legacyName ? 'Re-subir' : 'Adjuntar'}</span>
            </button>`;
    }

    const url = getGastoAttachmentUrl(gasto);
    if (isImageAttachmentType(gasto.fileMimeType)) {
        return `
            <button type="button" onclick="abrirVisorGasto('${escapeHtml(gasto.id)}')"
                title="Abrir ${escapeHtml(gasto.fileName)}"
                class="group relative w-24 h-16 rounded-lg border overflow-hidden bg-gray-100 hover:shadow-md transition-shadow">
                <img src="${escapeHtml(url)}" alt="${escapeHtml(gasto.fileName)}" class="w-full h-full object-cover">
                <span class="absolute inset-x-0 bottom-0 bg-black/65 text-white text-[9px] font-bold py-1">RECIBO</span>
            </button>`;
    }

    return `
        <button type="button" onclick="abrirVisorGasto('${escapeHtml(gasto.id)}')"
            title="Abrir ${escapeHtml(gasto.fileName)}"
            class="w-24 h-16 rounded-lg border border-red-200 bg-red-50 text-red-700 flex flex-col items-center justify-center hover:shadow-md transition-shadow">
            <span class="material-icons text-[25px]">picture_as_pdf</span>
            <span class="text-[9px] font-bold uppercase mt-1">PDF</span>
        </button>`;
}

function normalizeGastoSearchValue(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('es');
}

function compareGastoIdsDescending(left, right) {
    const leftNumber = Number(left.id);
    const rightNumber = Number(right.id);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return rightNumber - leftNumber;
    }

    return String(right.id).localeCompare(String(left.id), 'es', { numeric: true });
}

function getFilteredAndSortedGastos() {
    const startDate = document.getElementById('gastos-filter-start')?.value || '';
    const endDate = document.getElementById('gastos-filter-end')?.value || '';
    const search = normalizeGastoSearchValue(document.getElementById('gastos-filter-search')?.value);
    const sort = document.getElementById('gastos-sort')?.value || 'fecha-desc';

    const invalidDateRange = Boolean(startDate && endDate && startDate > endDate);
    if (invalidDateRange) return { records: [], invalidDateRange: true };

    const records = gastosData
        .filter(gasto => {
            if (startDate && gasto.fecha < startDate) return false;
            if (endDate && gasto.fecha > endDate) return false;

            if (!search) return true;

            const searchable = normalizeGastoSearchValue([
                gasto.fecha,
                formatDateForDisplay(gasto.fecha),
                gasto.concepto,
                gasto.justificacion,
                gasto.fileName,
                gasto.monto,
                formatMoney(gasto.monto)
            ].join(' '));

            return searchable.includes(search);
        })
        .sort((left, right) => {
            switch (sort) {
                case 'fecha-asc':
                    return left.fecha.localeCompare(right.fecha) || compareGastoIdsDescending(left, right) * -1;
                case 'concepto-asc':
                    return left.concepto.localeCompare(right.concepto, 'es', { sensitivity: 'base' });
                case 'concepto-desc':
                    return right.concepto.localeCompare(left.concepto, 'es', { sensitivity: 'base' });
                case 'monto-asc':
                    return left.monto - right.monto;
                case 'monto-desc':
                    return right.monto - left.monto;
                case 'recibo-asc':
                    return left.fileName.localeCompare(right.fileName, 'es', { sensitivity: 'base' });
                case 'recibo-desc':
                    return right.fileName.localeCompare(left.fileName, 'es', { sensitivity: 'base' });
                default:
                    return right.fecha.localeCompare(left.fecha) || compareGastoIdsDescending(left, right);
            }
        });

    return { records, invalidDateRange: false };
}

function updateGastosTotals(records) {
    const countElement = document.getElementById('gastos-total-registros');
    const amountElement = document.getElementById('gastos-total-monto');
    const total = records.reduce((sum, gasto) => sum + toFiniteNumber(gasto.monto), 0);

    if (countElement) countElement.textContent = records.length.toLocaleString('en-US');
    if (amountElement) amountElement.textContent = formatMoney(total);
}

function limpiarFiltrosGastos() {
    const start = document.getElementById('gastos-filter-start');
    const end = document.getElementById('gastos-filter-end');
    const search = document.getElementById('gastos-filter-search');
    const sort = document.getElementById('gastos-sort');

    if (start) start.value = '';
    if (end) end.value = '';
    if (search) search.value = '';
    if (sort) sort.value = 'fecha-desc';

    renderGastos();
}

function renderGastos() {
    const tbody = document.getElementById('gastos-table-body');
    if (!tbody) return;

    const { records, invalidDateRange } = getFilteredAndSortedGastos();
    updateGastosTotals(records);

    if (invalidDateRange) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-red-600 font-bold">La fecha “Desde” no puede ser posterior a la fecha “Hasta”.</td></tr>';
        return;
    }

    if (records.length === 0) {
        const hasAnyRecords = gastosData.length > 0;
        tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-gray-400">${hasAnyRecords ? 'No se encontraron gastos para los filtros seleccionados.' : 'Sin gastos registrados.'}</td></tr>`;
        return;
    }

    tbody.innerHTML = records.map(gasto => `
        <tr class="hover:bg-red-50">
            <td class="p-4 font-mono text-gray-600">${escapeHtml(formatDateForDisplay(gasto.fecha))}</td>
            <td class="p-4 font-bold text-gray-800">${escapeHtml(gasto.concepto)}</td>
            <td class="p-4 text-right font-mono font-bold text-red-700">L ${formatMoney(gasto.monto)}</td>
            <td class="p-4 text-xs text-gray-500">${escapeHtml(gasto.justificacion || '-')}</td>
            <td class="p-4 text-center">
                <div class="flex justify-center">${renderGastoAttachmentThumbnail(gasto)}</div>
            </td>
            <td class="p-4 text-center">
                <button type="button" onclick="abrirGastosModal('${escapeHtml(gasto.id)}')" title="Editar y reemplazar archivo" class="text-blue-500 hover:text-blue-800 mx-1"><span class="material-icons text-[18px]">edit</span></button>
                <button type="button" onclick="abrirActionModal('delete_gasto', '${escapeHtml(gasto.id)}')" class="text-red-400 hover:text-red-700 mx-1"><span class="material-icons text-[18px]">delete</span></button>
            </td>
        </tr>
    `).join('');
}

async function eliminarGastoServidor(id, justificacion) {
    await apiRequest(`/api/gastos/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });
    gastosData = gastosData.filter(item => !sameRecordId(item.id, id));
    renderGastos();
}