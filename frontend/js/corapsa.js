function normalizarCorapsa(record = {}) {
    const normalized = {
        id: record.id,
        fecha: String(record.fecha || ''),
        reciboIn: String(record.reciboIn ?? record.recibo_in ?? ''),
        reciboOut: String(record.reciboOut ?? record.recibo_out ?? ''),
        cliente: String(record.cliente || ''),
        toneladas: toFiniteNumber(record.toneladas),
        precio: toFiniteNumber(record.precio),
        total: toFiniteNumber(record.total),
        fileName: String(record.fileName ?? record.file_name ?? 'Sin Archivo'),
        fileNuestro: String(record.fileNuestro ?? record.file_nuestro ?? 'Sin Archivo'),
        pagado: record.pagado === true || Number(record.pagado) === 1
    };

    ['filePreviewUrl', 'fileMimeType', 'fileNuestroPreviewUrl', 'fileNuestroMimeType'].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(record, key)) normalized[key] = record[key];
    });

    return normalized;
}

function getCorapsaAttachmentKeys(type) {
    return type === 'nuestro'
        ? { name: 'fileNuestro', url: 'fileNuestroPreviewUrl', mime: 'fileNuestroMimeType' }
        : { name: 'fileName', url: 'filePreviewUrl', mime: 'fileMimeType' };
}

function getCorapsaReferenceParts(ref) {
    const [idRaw, typeRaw] = String(ref).split('|');
    return { id: idRaw, type: typeRaw === 'nuestro' ? 'nuestro' : 'cliente' };
}

function revokePreviewUrl(url) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
        try { URL.revokeObjectURL(url); } catch (_) { /* no-op */ }
    }
}

function assignCorapsaAttachment(record, type, file) {
    const keys = getCorapsaAttachmentKeys(type);
    revokePreviewUrl(record[keys.url]);
    record[keys.name] = file.name;
    record[keys.url] = URL.createObjectURL(file);
    record[keys.mime] = file.type || '';
}

function clearCorapsaAttachment(record, type) {
    const keys = getCorapsaAttachmentKeys(type);
    revokePreviewUrl(record[keys.url]);
    record[keys.name] = 'Sin Archivo';
    record[keys.url] = null;
    record[keys.mime] = '';
}

function abrirCorapsaModal(id = null, justificacion = '') {
    const modal = document.getElementById('corapsa-modal');
    const record = id == null ? null : corapsaData.find(item => sameRecordId(item.id, id));

    if (id != null && !record) return mostrarNotificacion('Recibo externo no encontrado.', 'error');

    activeCorapsaEditJustification = justificacion;
    document.getElementById('corapsa-modal-title').textContent = record ? 'Editar Recibo Externo' : 'Registrar Recibo Externo';
    document.getElementById('corapsa-edit-id').value = record?.id ?? '';
    document.getElementById('corapsa-fecha').value = record?.fecha || getLocalIsoDate();
    document.getElementById('corapsa-recibo-in').value = record?.reciboIn || '';
    document.getElementById('corapsa-cliente').value = record?.cliente || '';
    document.getElementById('corapsa-toneladas').value = record?.toneladas || '';
    document.getElementById('corapsa-precio').value = record ? formatNumberForInput(record.precio, 2) : '';
    document.getElementById('corapsa-recibo-out').value = record?.reciboOut || 'Se generará automáticamente';
    document.getElementById('corapsa-total-display').textContent = formatMoney(record?.total || 0);
    document.getElementById('corapsa-file').value = '';
    modal.classList.remove('hidden');
}

function cerrarCorapsaModal() {
    document.getElementById('corapsa-modal').classList.add('hidden');
    activeCorapsaEditJustification = '';
}

function handleCorapsaClientInput() {
    const inputValue = document.getElementById('corapsa-cliente').value.trim();
    const match = MOCK_CLIENTES.find(cliente =>
        `${cliente.nombre} ${cliente.apellido || ''}`.trim().toLocaleLowerCase('es') === inputValue.toLocaleLowerCase('es')
    );

    if (match) {
        document.getElementById('corapsa-precio').value = formatNumberForInput(match.precioFletePropio, 2);
        calcularTotalCorapsa();
    }
}

function calcularTotalCorapsa() {
    const toneladas = toFiniteNumber(document.getElementById('corapsa-toneladas').value);
    const precio = toFiniteNumber(document.getElementById('corapsa-precio').value);
    const total = toneladas * precio;
    document.getElementById('corapsa-total-display').textContent = formatMoney(total);
    return total;
}

async function guardarCorapsa() {
    const id = document.getElementById('corapsa-edit-id').value;
    const selectedFile = document.getElementById('corapsa-file').files[0] || null;
    const existing = id ? corapsaData.find(item => sameRecordId(item.id, id)) : null;

    const payload = {
        fecha: document.getElementById('corapsa-fecha').value,
        reciboIn: document.getElementById('corapsa-recibo-in').value.trim(),
        cliente: document.getElementById('corapsa-cliente').value.trim(),
        toneladas: parseFormattedNumber(document.getElementById('corapsa-toneladas').value),
        precio: parseFormattedNumber(document.getElementById('corapsa-precio').value),
        fileName: selectedFile?.name || existing?.fileName || 'Sin Archivo',
        fileNuestro: existing?.fileNuestro || 'Sin Archivo',
        pagado: existing?.pagado || false,
        justificacion: activeCorapsaEditJustification
    };

    if (!payload.fecha || !payload.reciboIn || !payload.cliente) {
        return mostrarNotificacion('Complete todos los campos obligatorios.', 'error');
    }
    if (!Number.isFinite(payload.toneladas) || payload.toneladas <= 0) {
        return mostrarNotificacion('Las toneladas deben ser mayores que cero.', 'error');
    }
    if (!Number.isFinite(payload.precio) || payload.precio < 0) {
        return mostrarNotificacion('El precio no es válido.', 'error');
    }
    if (id && !payload.justificacion) {
        return mostrarNotificacion('La edición requiere una justificación.', 'error');
    }

    try {
        const result = id
            ? await apiRequest(`/api/corapsa/${encodeURIComponent(id)}`, { method: 'PUT', body: payload })
            : await apiRequest('/api/corapsa', { method: 'POST', body: payload });
        const saved = normalizarCorapsa(result?.corapsa || result);

        if (existing) {
            const previews = {
                filePreviewUrl: existing.filePreviewUrl,
                fileMimeType: existing.fileMimeType,
                fileNuestroPreviewUrl: existing.fileNuestroPreviewUrl,
                fileNuestroMimeType: existing.fileNuestroMimeType
            };
            Object.assign(existing, saved, previews);
            if (selectedFile) assignCorapsaAttachment(existing, 'cliente', selectedFile);
        } else {
            if (selectedFile) assignCorapsaAttachment(saved, 'cliente', selectedFile);
            corapsaData.unshift(saved);
        }

        renderCorapsaTab();
        cerrarCorapsaModal();
        mostrarNotificacion(id ? 'Recibo actualizado.' : 'Recibo externo registrado.');
    } catch (error) {
        console.error('Error al guardar Corapsa:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el recibo.', 'error');
    }
}

async function togglePagoCorapsa(id) {
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (!record) return;

    const previous = record.pagado;
    record.pagado = !record.pagado;
    renderCorapsaTab();

    try {
        const result = await apiRequest(`/api/corapsa/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { pagado: record.pagado }
        });
        Object.assign(record, normalizarCorapsa(result?.corapsa || result));
    } catch (error) {
        record.pagado = previous;
        renderCorapsaTab();
        mostrarNotificacion(error.message || 'No se pudo actualizar el estado.', 'error');
    }
}

function imprimirCorapsa(id) {
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (!record) return mostrarNotificacion('Recibo no encontrado.', 'error');
    mostrarNotificacion(`Recibo ${record.reciboOut || record.reciboIn} listo para impresión.`);
}

function abrirVisorRecibo(id, type = 'cliente') {
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (!record) return mostrarNotificacion('Recibo no encontrado.', 'error');

    const keys = getCorapsaAttachmentKeys(type);
    const fileName = record[keys.name];
    if (!fileName || fileName === 'Sin Archivo') return mostrarNotificacion('No hay archivo adjunto.', 'error');

    activeReceiptViewer = { id: record.id, type };
    document.getElementById('visor-file-name').textContent = fileName;

    const container = document.getElementById('receipt-preview-container');
    container.replaceChildren();
    const previewUrl = record[keys.url];
    const mimeType = record[keys.mime] || '';

    if (previewUrl) {
        const preview = mimeType.startsWith('image/') ? document.createElement('img') : document.createElement('iframe');
        preview.src = previewUrl;
        preview.title = fileName;
        preview.alt = fileName;
        preview.className = mimeType.startsWith('image/')
            ? 'max-w-full max-h-full object-contain rounded shadow'
            : 'w-full h-full min-h-[500px] bg-white rounded border';
        container.appendChild(preview);
    } else {
        const message = document.createElement('div');
        message.className = 'max-w-lg text-center text-gray-500 bg-white border-2 border-dashed rounded-xl p-8';
        message.textContent = 'El nombre del archivo está guardado, pero el contenido binario todavía no se almacena en el servidor.';
        container.appendChild(message);
    }

    document.getElementById('view-receipt-modal').classList.remove('hidden');
}

function cerrarVisorRecibo() {
    document.getElementById('view-receipt-modal').classList.add('hidden');
    activeReceiptViewer = { id: null, type: null };
}

function solicitarEliminarArchivoActual() {
    if (activeReceiptViewer.id == null) return mostrarNotificacion('No hay archivo seleccionado.', 'error');
    abrirActionModal('delete_corapsa_file', `${activeReceiptViewer.id}|${activeReceiptViewer.type}`);
}

function solicitarReemplazarArchivoActual() {
    if (activeReceiptViewer.id == null) return mostrarNotificacion('No hay archivo seleccionado.', 'error');
    abrirActionModal('replace_corapsa_file', `${activeReceiptViewer.id}|${activeReceiptViewer.type}`);
}

async function eliminarArchivoCorapsa(ref, justificacion) {
    const { id, type } = getCorapsaReferenceParts(ref);
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (!record) throw new Error('Recibo no encontrado.');

    const keys = getCorapsaAttachmentKeys(type);
    const body = type === 'nuestro'
        ? { fileNuestro: 'Sin Archivo', justificacion }
        : { fileName: 'Sin Archivo', justificacion };

    const result = await apiRequest(`/api/corapsa/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    clearCorapsaAttachment(record, type);
    Object.assign(record, normalizarCorapsa(result?.corapsa || result), {
        [keys.url]: null,
        [keys.mime]: ''
    });
    cerrarVisorRecibo();
    renderCorapsaTab();
}

function prepararReemplazoArchivoCorapsa(ref, justificacion) {
    const { id, type } = getCorapsaReferenceParts(ref);
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (!record) return mostrarNotificacion('Recibo no encontrado.', 'error');

    activeUploadId = record.id;
    activeUploadType = type;
    activeUploadJustification = justificacion;
    cerrarVisorRecibo();
    document.getElementById(type === 'cliente' ? 'hidden-file-cliente' : 'hidden-file-nuestro').click();
}

function renderCorapsaTab() {
    const tbody = document.getElementById('corapsa-table-body');
    if (!tbody) return;

    const startDate = document.getElementById('corapsa-filter-start')?.value || '';
    const endDate = document.getElementById('corapsa-filter-end')?.value || '';
    const search = (document.getElementById('corapsa-filter-client')?.value || '').trim().toLocaleLowerCase('es');

    const filtered = corapsaData.filter(record => {
        if (startDate && record.fecha < startDate) return false;
        if (endDate && record.fecha > endDate) return false;
        const searchable = `${record.cliente} ${record.reciboIn} ${record.reciboOut}`.toLocaleLowerCase('es');
        return !search || searchable.includes(search);
    });

    const sumTons = filtered.reduce((sum, item) => sum + item.toneladas, 0);
    const sumTotal = filtered.reduce((sum, item) => sum + item.total, 0);
    document.getElementById('corapsa-total-toneladas').textContent = sumTons.toFixed(2);
    document.getElementById('corapsa-total-dinero').textContent = formatMoney(sumTotal);

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="p-8 text-center text-gray-400">Sin recibos registrados.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(record => {
        const fileC = record.fileName !== 'Sin Archivo' ? record.fileName : 'Sin archivo';
        const fileN = record.fileNuestro !== 'Sin Archivo' ? record.fileNuestro : 'Sin archivo';
        const badgeClass = record.pagado ? 'bg-green-100 text-green-700 border-green-200' : 'bg-red-100 text-red-700 border-red-200';
        const badgeText = record.pagado ? 'PAGADO' : 'NO PAGADO';
        const id = escapeHtml(record.id);

        return `
            <tr class="hover:bg-blue-50">
                <td class="p-3 text-sm font-mono text-gray-600 font-bold">${escapeHtml(formatDateForDisplay(record.fecha))}</td>
                <td class="p-3 font-bold text-gray-800">${escapeHtml(record.cliente)}</td>
                <td class="p-3"><span class="inline-flex items-center gap-1 bg-yellow-100 text-yellow-900 border border-yellow-200 px-2 py-1 rounded font-mono font-bold text-xs"><span class="material-icons text-[14px]">receipt_long</span>${escapeHtml(record.reciboIn)}</span></td>
                <td class="p-3 text-right text-xs text-gray-500">L ${formatMoney(record.precio)}</td>
                <td class="p-3 text-right font-mono font-bold text-gray-600">${record.toneladas.toFixed(2)}</td>
                <td class="p-3 text-right font-mono font-bold text-blue-700 text-lg">L ${formatMoney(record.total)}</td>
                <td class="p-3 text-center">
                    <div class="flex flex-col gap-1 items-center">
                        <button type="button" onclick="${fileC === 'Sin archivo' ? `triggerQuickUpload('${id}', 'cliente')` : `abrirVisorRecibo('${id}', 'cliente')`}" title="${escapeHtml(fileC)}" class="text-[10px] font-bold border rounded px-2 py-1.5 w-28 truncate">Cliente</button>
                        <button type="button" onclick="${fileN === 'Sin archivo' ? `triggerQuickUpload('${id}', 'nuestro')` : `abrirVisorRecibo('${id}', 'nuestro')`}" title="${escapeHtml(fileN)}" class="text-[10px] font-bold border rounded px-2 py-1.5 w-28 truncate">Nuestro</button>
                    </div>
                </td>
                <td class="p-3 text-center"><button type="button" onclick="togglePagoCorapsa('${id}')" class="${badgeClass} px-3 py-1 rounded-full text-[10px] font-bold border">${badgeText}</button></td>
                <td class="p-3 text-center">
                    <button type="button" onclick="abrirActionModal('edit_corapsa', '${id}')" class="text-blue-500 hover:text-blue-800"><span class="material-icons text-[18px]">edit</span></button>
                    <button type="button" onclick="abrirActionModal('delete_corapsa', '${id}')" class="text-red-400 hover:text-red-700"><span class="material-icons text-[18px]">delete</span></button>
                </td>
            </tr>
        `;
    }).join('');
}

function triggerQuickUpload(id, type) {
    activeUploadId = id;
    activeUploadType = type;
    activeUploadJustification = '';
    document.getElementById(type === 'cliente' ? 'hidden-file-cliente' : 'hidden-file-nuestro').click();
}

async function processQuickUpload(event, fallbackType) {
    if (activeUploadId == null || event.target.files.length === 0) return;

    const type = activeUploadType || fallbackType;
    const record = corapsaData.find(item => sameRecordId(item.id, activeUploadId));
    const file = event.target.files[0];
    const idToOpen = activeUploadId;

    try {
        if (!record) throw new Error('Recibo no encontrado.');
        const body = type === 'nuestro'
            ? { fileNuestro: file.name, justificacion: activeUploadJustification }
            : { fileName: file.name, justificacion: activeUploadJustification };
        const result = await apiRequest(`/api/corapsa/${encodeURIComponent(record.id)}`, { method: 'PATCH', body });
        Object.assign(record, normalizarCorapsa(result?.corapsa || result));
        assignCorapsaAttachment(record, type, file);
        renderCorapsaTab();
        mostrarNotificacion(`Archivo ${type} adjuntado.`);
        abrirVisorRecibo(idToOpen, type);
    } catch (error) {
        mostrarNotificacion(error.message || 'No se pudo guardar el archivo.', 'error');
    } finally {
        event.target.value = '';
        activeUploadId = null;
        activeUploadType = null;
        activeUploadJustification = null;
    }
}

async function eliminarCorapsaServidor(id, justificacion) {
    await apiRequest(`/api/corapsa/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (record) {
        revokePreviewUrl(record.filePreviewUrl);
        revokePreviewUrl(record.fileNuestroPreviewUrl);
    }
    corapsaData = corapsaData.filter(item => !sameRecordId(item.id, id));
    renderCorapsaTab();
}