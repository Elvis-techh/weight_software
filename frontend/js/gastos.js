function normalizarGasto(record = {}) {
    return {
        id: record.id,
        fecha: String(record.fecha || ''),
        monto: toFiniteNumber(record.monto),
        concepto: String(record.concepto || ''),
        justificacion: String(record.justificacion || ''),
        notas: String(record.notas || ''),
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

// One id per "new record" form session, minted when the modal opens and kept
// until the record actually saves — so a manual retry after a timeout replays
// the SAME operation instead of creating a second row. See client_op_id in
// backend/database.js: the server returns the row the first attempt already
// committed rather than inserting again.
let gastoCreateOpId = null;

function abrirGastosModal(id = null) {
    const gasto = id == null ? null : gastosData.find(item => sameRecordId(item.id, id));
    if (id != null && !gasto) return mostrarNotificacion('Gasto no encontrado.', 'error');

    gastoCreateOpId = gasto ? null : generateLocalId('op');

    document.getElementById('gastos-modal-title').textContent = gasto ? 'Editar Gasto' : 'Nuevo Gasto';
    document.getElementById('gastos-edit-id').value = gasto?.id ?? '';
    document.getElementById('gastos-fecha').value = gasto?.fecha || getLocalIsoDate();
    document.getElementById('gastos-monto').value = gasto ? formatNumberForInput(gasto.monto, 2) : '';
    document.getElementById('gastos-concepto').value = gasto?.concepto || '';
    document.getElementById('gastos-notas').value = gasto?.notas || '';
    // Blank every time the modal opens, even when editing: this is a
    // per-edit audit reason (like corapsa/clientes/overview-payment), not
    // the expense's own data, so it shouldn't be pre-filled from whatever
    // reason was given for a previous edit.
    document.getElementById('gastos-justificacion').value = '';
    document.getElementById('gastos-justificacion-container').classList.toggle('hidden', !gasto);
    document.getElementById('gastos-file').value = '';
    limpiarGastosArchivoPreview();
    setGastosDropzoneActive(false);
    updateGastoModalAttachmentState(gasto);
    document.getElementById('gastos-modal').classList.remove('hidden');
}

function cerrarGastosModal() {
    document.getElementById('gastos-modal').classList.add('hidden');
    limpiarGastosArchivoPreview();
}

let gastosFilePreviewUrl = null;
// Bumped on every clear/re-selection so a slow PDF render for a file the
// user has since replaced can't land its result after the fact — see
// actualizarGastosArchivoPreview.
let gastosPreviewToken = 0;

function limpiarGastosArchivoPreview() {
    gastosPreviewToken += 1;
    if (gastosFilePreviewUrl) {
        URL.revokeObjectURL(gastosFilePreviewUrl);
        gastosFilePreviewUrl = null;
    }
    document.getElementById('gastos-file-preview-img')?.classList.add('hidden');
    document.getElementById('gastos-file-preview-pdf')?.classList.add('hidden');
}

// Shows a thumbnail for a newly picked/dropped file before it's saved — the
// bare file input only ever shows its name, not what the image/PDF looks
// like. PDFs are rasterized client-side (see renderPdfPageAsImageBlobUrl in
// globals.js) into the same <img> a real photo would use; the picture_as_pdf
// icon is only a fallback if that rendering fails.
async function actualizarGastosArchivoPreview() {
    limpiarGastosArchivoPreview();

    const file = document.getElementById('gastos-file')?.files[0] || null;
    if (!file) return;

    const token = gastosPreviewToken;
    const showImage = url => {
        if (token !== gastosPreviewToken) { URL.revokeObjectURL(url); return; }
        gastosFilePreviewUrl = url;
        const img = document.getElementById('gastos-file-preview-img');
        if (img) {
            img.src = url;
            img.classList.remove('hidden');
        }
    };

    if (file.type.startsWith('image/')) {
        showImage(URL.createObjectURL(file));
    } else if (file.type === 'application/pdf') {
        try {
            showImage(await renderPdfPageAsImageBlobUrl(file));
        } catch (error) {
            console.error('No se pudo generar la vista previa del PDF:', error);
            if (token === gastosPreviewToken) document.getElementById('gastos-file-preview-pdf')?.classList.remove('hidden');
        }
    }
}

// Shared by both the modal dropzone and manual file picks: validates the
// file the same way a manual selection is validated on save, then wires it
// into the (hidden) file input so guardarGasto() picks it up unchanged.
function asignarArchivoGastos(file) {
    if (!file) return false;
    try {
        validateAttachmentFile(file);
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
        return false;
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.getElementById('gastos-file').files = transfer.files;
    actualizarGastosArchivoPreview();
    return true;
}

function setGastosDropzoneActive(active) {
    const dropzone = document.getElementById('gastos-dropzone');
    if (!dropzone) return;
    dropzone.classList.toggle('border-red-400', active);
    dropzone.classList.toggle('bg-red-50', active);
    dropzone.classList.toggle('border-gray-200', !active);
}

function gastosDropzoneDragOver(event) {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setGastosDropzoneActive(true);
}

function gastosDropzoneDragLeave(event) {
    event.stopPropagation();
    setGastosDropzoneActive(false);
}

function gastosDropzoneDrop(event) {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setGastosDropzoneActive(false);
    asignarArchivoGastos(event.dataTransfer.files[0] || null);
}

// Counts nested dragenter/dragleave pairs bubbling up from table rows/cells
// so the full-page overlay doesn't flicker every time the cursor crosses a
// child element's edge while dragging over the Gastos view.
let gastosPageDragCounter = 0;

function gastosPageDragEnter(event) {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    gastosPageDragCounter += 1;
    document.getElementById('gastos-page-drop-overlay')?.classList.remove('hidden');
}

function gastosPageDragOver(event) {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
}

function gastosPageDragLeave(event) {
    if (!isFileDragEvent(event)) return;
    gastosPageDragCounter = Math.max(0, gastosPageDragCounter - 1);
    if (gastosPageDragCounter === 0) {
        document.getElementById('gastos-page-drop-overlay')?.classList.add('hidden');
    }
}

function gastosPageDrop(event) {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    gastosPageDragCounter = 0;
    document.getElementById('gastos-page-drop-overlay')?.classList.add('hidden');

    const file = event.dataTransfer.files[0] || null;
    if (!file) return;

    abrirGastosModal();
    if (!asignarArchivoGastos(file)) return;
    document.getElementById('gastos-concepto')?.focus();
}

async function guardarGasto() {
    const id = document.getElementById('gastos-edit-id').value;
    const selectedFile = document.getElementById('gastos-file').files[0] || null;

    const payload = {
        fecha: document.getElementById('gastos-fecha').value,
        monto: parseFormattedNumber(document.getElementById('gastos-monto').value),
        concepto: document.getElementById('gastos-concepto').value.trim(),
        justificacion: document.getElementById('gastos-justificacion').value.trim(),
        notas: document.getElementById('gastos-notas').value.trim()
    };

    if (!payload.fecha || !payload.concepto) return mostrarNotificacion('Complete los campos obligatorios.', 'error');
    if (!Number.isFinite(payload.monto) || payload.monto <= 0) return mostrarNotificacion('El monto debe ser mayor que cero.', 'error');
    if (id && !payload.justificacion) return mostrarNotificacion('La edición requiere una justificación.', 'error');

    const saveButton = document.getElementById('gastos-save-button');
    try {
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = 'Guardando...';
        }

        const archivo = await buildAttachmentPayload(selectedFile);
        if (archivo) payload.archivo = archivo;

        if (!id) payload.clientOpId = gastoCreateOpId;
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
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar';
        }
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

// Swaps the browser's default broken-image glyph for a clearer placeholder
// when a saved receipt's image fails to load (e.g. storage hiccup) — the
// gasto record and its filename are intact, only the pictured preview isn't.
function gastosImagenNoDisponible(imgElement) {
    const wrapper = imgElement.closest('button');
    if (!wrapper) return;
    wrapper.classList.add('flex', 'flex-col', 'items-center', 'justify-center', 'border', 'border-red-200', 'bg-red-50');
    wrapper.innerHTML = `
        <span class="material-icons text-[22px] text-red-400">broken_image</span>
        <span class="text-[9px] font-bold uppercase mt-1 text-red-400">No disponible</span>`;
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
    // Both images and PDFs render into the same thumbnail slot — PDFs get
    // their first page rasterized client-side (see cargarMiniaturasAdjuntos
    // in globals.js) instead of a generic "PDF" icon.
    return `
        <button type="button" onclick="abrirVisorGasto('${escapeHtml(gasto.id)}')"
            title="Abrir ${escapeHtml(gasto.fileName)}"
            class="group relative w-24 h-16 rounded-lg border overflow-hidden bg-gray-100 hover:shadow-md transition-shadow">
            <img data-attachment-thumb="${escapeHtml(url)}" data-attachment-mime="${escapeHtml(gasto.fileMimeType)}" alt="${escapeHtml(gasto.fileName)}" onerror="gastosImagenNoDisponible(this)" class="w-full h-full object-cover">
            <span class="absolute inset-x-0 bottom-0 bg-black/65 text-white text-[9px] font-bold py-1">RECIBO</span>
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
                gasto.notas,
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

    collapseInlineSearch('gastos-search-wrap', true);
    renderGastos();
}

function renderGastos() {
    const tbody = document.getElementById('gastos-table-body');
    if (!tbody) return;

    revocarMiniaturasAdjuntos(tbody);

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
            <td class="p-4 font-mono text-gray-600" data-label="Fecha">${escapeHtml(formatDateForDisplay(gasto.fecha))}</td>
            <td class="p-4 font-bold text-gray-800" data-label="Concepto">${escapeHtml(gasto.concepto)}</td>
            <td class="p-4 text-right font-mono font-bold text-red-700" data-label="Monto (L)">L ${formatMoney(gasto.monto)}</td>
            <td class="p-4 text-xs text-gray-500" data-label="Notas">${escapeHtml(gasto.notas || '-')}</td>
            <td class="p-4 text-center" data-label="Recibo">
                <div class="flex justify-center">${renderGastoAttachmentThumbnail(gasto)}</div>
            </td>
            <td class="p-4 text-center" data-label="Acciones">
                <button type="button" onclick="abrirGastosModal('${escapeHtml(gasto.id)}')" title="Editar y reemplazar archivo" class="text-blue-500 hover:text-blue-800 mx-1"><span class="material-icons text-[18px]">edit</span></button>
                <button type="button" onclick="abrirActionModal('delete_gasto', '${escapeHtml(gasto.id)}')" class="text-red-400 hover:text-red-700 mx-1"><span class="material-icons text-[18px]">delete</span></button>
            </td>
        </tr>
    `).join('');

    cargarMiniaturasAdjuntos(tbody, gastosImagenNoDisponible);
}

async function eliminarGastoServidor(id, justificacion) {
    await apiRequest(`/api/gastos/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });
    gastosData = gastosData.filter(item => !sameRecordId(item.id, id));
    renderGastos();
}