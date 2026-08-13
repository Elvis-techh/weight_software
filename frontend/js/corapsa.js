function normalizarCorapsa(record = {}) {
    return {
        id: record.id,
        fecha: String(record.fecha || ''),
        reciboIn: String(record.reciboIn ?? record.recibo_in ?? ''),
        reciboOut: String(record.reciboOut ?? record.recibo_out ?? ''),
        cliente: String(record.cliente || ''),
        destino: String(record.destino || ''),
        aNombreDe: String(record.aNombreDe ?? record.a_nombre_de ?? ''),
        toneladas: toFiniteNumber(record.toneladas),
        precio: toFiniteNumber(record.precio),
        total: toFiniteNumber(record.total),
        fileName: String(record.fileName ?? record.file_name ?? 'Sin Archivo'),
        fileMimeType: String(record.fileMimeType ?? record.file_mime_type ?? ''),
        hasFile: record.hasFile === true,
        fileNuestro: String(record.fileNuestro ?? record.file_nuestro ?? 'Sin Archivo'),
        fileNuestroMimeType: String(record.fileNuestroMimeType ?? record.file_nuestro_mime_type ?? ''),
        hasFileNuestro: record.hasFileNuestro === true,
        pagado: record.pagado === true || Number(record.pagado) === 1,
        esProductoPropio: record.esProductoPropio === true || Number(record.esProductoPropio ?? record.es_producto_propio) === 1,
        updatedAt: String(record.updatedAt ?? record.updated_at ?? '')
    };
}

function getCorapsaAttachmentMeta(record, type) {
    const nuestro = type === 'nuestro';
    return {
        type: nuestro ? 'nuestro' : 'cliente',
        label: nuestro ? 'Nuestro' : 'Cliente',
        fileName: nuestro ? record.fileNuestro : record.fileName,
        mimeType: nuestro ? record.fileNuestroMimeType : record.fileMimeType,
        hasFile: nuestro ? record.hasFileNuestro : record.hasFile
    };
}

function getCorapsaReferenceParts(ref) {
    const [idRaw, typeRaw] = String(ref).split('|');
    return { id: idRaw, type: typeRaw === 'nuestro' ? 'nuestro' : 'cliente' };
}

function getCorapsaAttachmentUrl(record, type) {
    const version = encodeURIComponent(record.updatedAt || Date.now());
    return buildApiUrl(`/api/corapsa/${encodeURIComponent(record.id)}/archivo/${type}?v=${version}`);
}

function updateCorapsaModalAttachmentState(record) {
    const configuration = [
        ['cliente', 'corapsa-current-cliente', 'corapsa-current-cliente-preview'],
        ['nuestro', 'corapsa-current-nuestro', 'corapsa-current-nuestro-preview']
    ];

    configuration.forEach(([type, textId, buttonId]) => {
        const text = document.getElementById(textId);
        const button = document.getElementById(buttonId);
        if (!text || !button) return;

        if (!record) {
            text.textContent = 'Sin archivo guardado';
            button.classList.add('hidden');
            return;
        }

        const meta = getCorapsaAttachmentMeta(record, type);
        text.textContent = meta.hasFile ? meta.fileName : 'Sin archivo guardado';
        button.classList.toggle('hidden', !meta.hasFile);
        button.onclick = meta.hasFile ? () => abrirVisorRecibo(record.id, type) : null;
    });
}

function abrirCorapsaModal(id = null, justificacion = '') {
    const record = id == null ? null : corapsaData.find(item => sameRecordId(item.id, id));
    if (id != null && !record) return mostrarNotificacion('Recibo externo no encontrado.', 'error');

    activeCorapsaEditJustification = justificacion;
    document.getElementById('corapsa-modal-title').textContent = record ? 'Editar Recibo Externo' : 'Registrar Recibo Externo';
    document.getElementById('corapsa-edit-id').value = record?.id ?? '';
    document.getElementById('corapsa-fecha').value = record?.fecha || getLocalIsoDate();
    document.getElementById('corapsa-recibo-in').value = record?.reciboIn || '';
    document.getElementById('corapsa-cliente').value = record?.cliente || '';
    ensureDestinoOption('corapsa-destino', record?.destino || '');
    document.getElementById('corapsa-destino').value = record?.destino || '';
    document.getElementById('corapsa-a-nombre-de').value = record?.aNombreDe || '';
    document.getElementById('corapsa-es-producto-propio').checked = Boolean(record?.esProductoPropio);
    document.getElementById('corapsa-toneladas').value = record?.toneladas || '';
    document.getElementById('corapsa-precio').value = record ? formatNumberForInput(record.precio, 2) : '';
    document.getElementById('corapsa-recibo-out').value = record?.reciboOut || 'Se generará automáticamente';
    document.getElementById('corapsa-total-display').textContent = formatMoney(record?.total || 0);
    document.getElementById('corapsa-file').value = '';
    document.getElementById('corapsa-file-nuestro').value = '';
    updateCorapsaModalAttachmentState(record);
    document.getElementById('corapsa-modal').classList.remove('hidden');
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

// Defaults the price (and therefore total) to 0 when the receipt is flagged
// as own-Acopio product, since it was already paid for at our scale. Users
// can still override the price afterward if they need to record it.
function handleProductoPropioToggle() {
    if (!document.getElementById('corapsa-es-producto-propio').checked) return;
    document.getElementById('corapsa-precio').value = formatNumberForInput(0, 2);
    calcularTotalCorapsa();
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
    const existing = id ? corapsaData.find(item => sameRecordId(item.id, id)) : null;
    const clienteFile = document.getElementById('corapsa-file').files[0] || null;
    const nuestroFile = document.getElementById('corapsa-file-nuestro').files[0] || null;

    const payload = {
        fecha: document.getElementById('corapsa-fecha').value,
        reciboIn: document.getElementById('corapsa-recibo-in').value.trim(),
        cliente: document.getElementById('corapsa-cliente').value.trim(),
        destino: document.getElementById('corapsa-destino').value.trim(),
        aNombreDe: document.getElementById('corapsa-a-nombre-de').value.trim(),
        esProductoPropio: document.getElementById('corapsa-es-producto-propio').checked,
        toneladas: parseFormattedNumber(document.getElementById('corapsa-toneladas').value),
        precio: parseFormattedNumber(document.getElementById('corapsa-precio').value),
        pagado: existing?.pagado || false,
        justificacion: activeCorapsaEditJustification
    };

    if (!payload.fecha || !payload.reciboIn || !payload.cliente || !payload.destino) {
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
        const [archivoCliente, archivoNuestro] = await Promise.all([
            buildAttachmentPayload(clienteFile),
            buildAttachmentPayload(nuestroFile)
        ]);
        if (archivoCliente) payload.archivoCliente = archivoCliente;
        if (archivoNuestro) payload.archivoNuestro = archivoNuestro;

        const result = id
            ? await apiRequest(`/api/corapsa/${encodeURIComponent(id)}`, { method: 'PUT', body: payload, timeoutMs: 30000 })
            : await apiRequest('/api/corapsa', { method: 'POST', body: payload, timeoutMs: 30000 });
        const saved = normalizarCorapsa(result?.corapsa || result);
        const index = corapsaData.findIndex(item => sameRecordId(item.id, saved.id));
        if (index >= 0) corapsaData[index] = saved;
        else corapsaData.unshift(saved);

        renderCorapsaTab();
        cerrarCorapsaModal();
        mostrarNotificacion(id ? 'Recibo y archivos actualizados.' : 'Recibo externo registrado.');
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

function toggleAttachmentImageSize(image) {
    const actualSize = image.dataset.actualSize === 'true';
    image.dataset.actualSize = actualSize ? 'false' : 'true';
    image.style.maxWidth = actualSize ? '100%' : 'none';
    image.style.maxHeight = actualSize ? '100%' : 'none';
    image.style.cursor = actualSize ? 'zoom-in' : 'zoom-out';
}

function openAttachmentViewer({ module, id, type, fileName, mimeType, url }) {
    activeReceiptViewer = { module, id, type };
    document.getElementById('visor-file-name').textContent = fileName;

    const container = document.getElementById('receipt-preview-container');
    container.replaceChildren();

    if (isImageAttachmentType(mimeType)) {
        const image = document.createElement('img');
        image.src = url;
        image.alt = fileName;
        image.title = 'Haga clic para alternar entre ajustar a pantalla y tamaño real';
        image.dataset.actualSize = 'false';
        image.className = 'max-w-full max-h-full h-auto object-contain rounded shadow bg-white';
        image.style.cursor = 'zoom-in';
        image.addEventListener('click', () => toggleAttachmentImageSize(image));
        container.appendChild(image);
    } else {
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.title = fileName;
        frame.className = 'w-full h-full min-h-[500px] bg-white rounded border';
        container.appendChild(frame);
    }

    const hint = document.getElementById('viewer-hint');
    if (hint) hint.textContent = isImageAttachmentType(mimeType)
        ? 'Haga clic sobre la imagen para verla en tamaño real.'
        : 'Use los controles del visor PDF para ampliar el documento.';

    const deleteButton = document.getElementById('viewer-delete-button');
    const replaceButton = document.getElementById('viewer-replace-button');
    if (deleteButton) deleteButton.classList.toggle('hidden', module !== 'corapsa');
    if (replaceButton) {
        replaceButton.classList.remove('hidden');
        const label = replaceButton.querySelector('[data-label]');
        if (label) label.textContent = module === 'gasto'
            ? 'Editar / Reemplazar'
            : 'Reemplazar';
    }

    document.getElementById('view-receipt-modal').classList.remove('hidden');
}

function abrirVisorRecibo(id, type = 'cliente') {
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (!record) return mostrarNotificacion('Recibo no encontrado.', 'error');

    const meta = getCorapsaAttachmentMeta(record, type);
    if (!meta.hasFile) return mostrarNotificacion('No hay un archivo disponible para visualizar.', 'error');

    openAttachmentViewer({
        module: 'corapsa',
        id: record.id,
        type: meta.type,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        url: getCorapsaAttachmentUrl(record, meta.type)
    });
}

function cerrarVisorRecibo() {
    document.getElementById('view-receipt-modal').classList.add('hidden');
    document.getElementById('receipt-preview-container').replaceChildren();
    activeReceiptViewer = { module: null, id: null, type: null };
}

function solicitarEliminarArchivoActual() {
    if (activeReceiptViewer.module !== 'corapsa' || activeReceiptViewer.id == null) {
        return mostrarNotificacion('Este visor no permite eliminar el archivo directamente.', 'error');
    }
    abrirActionModal('delete_corapsa_file', `${activeReceiptViewer.id}|${activeReceiptViewer.type}`);
}

function solicitarReemplazarArchivoActual() {
    if (activeReceiptViewer.id == null) return mostrarNotificacion('No hay archivo seleccionado.', 'error');

    if (activeReceiptViewer.module === 'gasto') {
        const id = activeReceiptViewer.id;
        cerrarVisorRecibo();
        abrirGastosModal(id);
        setTimeout(() => document.getElementById('gastos-file')?.focus(), 0);
        return;
    }

    abrirActionModal('replace_corapsa_file', `${activeReceiptViewer.id}|${activeReceiptViewer.type}`);
}

async function eliminarArchivoCorapsa(ref, justificacion) {
    const { id, type } = getCorapsaReferenceParts(ref);
    const record = corapsaData.find(item => sameRecordId(item.id, id));
    if (!record) throw new Error('Recibo no encontrado.');

    const body = type === 'nuestro'
        ? { eliminarArchivoNuestro: true, justificacion }
        : { eliminarArchivoCliente: true, justificacion };
    const result = await apiRequest(`/api/corapsa/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    Object.assign(record, normalizarCorapsa(result?.corapsa || result));
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

function renderCorapsaAttachmentThumbnail(record, type) {
    const meta = getCorapsaAttachmentMeta(record, type);
    const theme = type === 'nuestro'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-blue-200 bg-blue-50 text-blue-700';

    if (!meta.hasFile) {
        const legacyName = meta.fileName && meta.fileName !== 'Sin Archivo' ? meta.fileName : '';
        return `
            <button type="button" onclick="triggerQuickUpload('${escapeHtml(record.id)}', '${type}')"
                title="${legacyName ? `El contenido de ${escapeHtml(legacyName)} no está guardado. Vuelva a adjuntarlo.` : `Adjuntar archivo ${meta.label}`}"
                class="w-24 h-16 rounded-lg border border-dashed ${theme} flex flex-col items-center justify-center hover:shadow transition-shadow">
                <span class="material-icons text-[22px]">${legacyName ? 'cloud_upload' : 'add_photo_alternate'}</span>
                <span class="text-[9px] font-bold uppercase mt-1">${legacyName ? 'Re-subir' : meta.label}</span>
            </button>`;
    }

    const url = getCorapsaAttachmentUrl(record, type);
    if (isImageAttachmentType(meta.mimeType)) {
        return `
            <button type="button" onclick="abrirVisorRecibo('${escapeHtml(record.id)}', '${type}')"
                title="Abrir ${escapeHtml(meta.fileName)}"
                class="group relative w-24 h-16 rounded-lg border overflow-hidden bg-gray-100 hover:shadow-md transition-shadow">
                <img src="${escapeHtml(url)}" alt="${escapeHtml(meta.fileName)}" class="w-full h-full object-cover">
                <span class="absolute inset-x-0 bottom-0 bg-black/65 text-white text-[9px] font-bold py-1">${meta.label}</span>
            </button>`;
    }

    return `
        <button type="button" onclick="abrirVisorRecibo('${escapeHtml(record.id)}', '${type}')"
            title="Abrir ${escapeHtml(meta.fileName)}"
            class="w-24 h-16 rounded-lg border ${theme} flex flex-col items-center justify-center hover:shadow-md transition-shadow">
            <span class="material-icons text-[25px]">picture_as_pdf</span>
            <span class="text-[9px] font-bold uppercase mt-1">${meta.label}</span>
        </button>`;
}

// Holds whatever renderCorapsaTab() last filtered, so "Imprimir Listado" can
// reuse it directly instead of re-reading the filter inputs and re-filtering
// corapsaData itself — mirrors reportes.js's ultimoFiltroReportes.
let ultimoFiltroCorapsa = {
    filteredData: [], startDate: '', endDate: '', searchRaw: '', destinoFilter: '', sumTons: 0, sumTotal: 0
};

function renderCorapsaTab() {
    const tbody = document.getElementById('corapsa-table-body');
    if (!tbody) return;

    const startDate = document.getElementById('corapsa-filter-start')?.value || '';
    const endDate = document.getElementById('corapsa-filter-end')?.value || '';
    const searchRaw = (document.getElementById('corapsa-filter-client')?.value || '').trim();
    const search = searchRaw.toLocaleLowerCase('es');
    const destinoFilter = document.getElementById('corapsa-filter-destino')?.value || '';

    const filtered = corapsaData.filter(record => {
        if (startDate && record.fecha < startDate) return false;
        if (endDate && record.fecha > endDate) return false;
        if (destinoFilter && record.destino !== destinoFilter) return false;
        const searchable = `${record.cliente} ${record.aNombreDe} ${record.reciboIn} ${record.reciboOut}`.toLocaleLowerCase('es');
        return !search || searchable.includes(search);
    });

    const sumTons = filtered.reduce((sum, item) => sum + item.toneladas, 0);
    const sumTotal = filtered.reduce((sum, item) => sum + item.total, 0);
    document.getElementById('corapsa-total-toneladas').textContent = sumTons.toFixed(2);
    document.getElementById('corapsa-total-dinero').textContent = formatMoney(sumTotal);

    // Held for "Imprimir Listado" (see construirPayloadCorapsaListado()) so it
    // reuses exactly what's currently filtered instead of re-reading the
    // filter inputs and re-filtering corapsaData itself.
    ultimoFiltroCorapsa = { filteredData: filtered, startDate, endDate, searchRaw, destinoFilter, sumTons, sumTotal };
    const listadoButton = document.getElementById('btn-imprimir-listado-corapsa');
    if (listadoButton) listadoButton.disabled = filtered.length === 0;

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="p-8 text-center text-gray-400">Sin recibos registrados.</td></tr>';
        return;
    }

    tbody.innerHTML = filtered.map(record => {
        const badgeClass = record.pagado ? 'bg-green-100 text-green-700 border-green-200' : 'bg-red-100 text-red-700 border-red-200';
        const badgeText = record.pagado ? 'PAGADO' : 'NO PAGADO';
        const id = escapeHtml(record.id);

        return `
            <tr class="hover:bg-blue-50">
                <td class="p-3 text-sm font-mono text-gray-600 font-bold">${escapeHtml(formatDateForDisplay(record.fecha))}</td>
                <td class="p-3 font-bold text-gray-800">${escapeHtml(record.cliente)}${record.aNombreDe ? `<br><span class="text-[11px] font-semibold text-gray-400">A nombre de: ${escapeHtml(record.aNombreDe)}</span>` : ''}</td>
                <td class="p-3"><span class="inline-flex items-center bg-slate-100 text-slate-800 border border-slate-200 px-2 py-1 rounded font-bold text-xs uppercase">${escapeHtml(record.destino || '-')}</span></td>
                <td class="p-3">${record.esProductoPropio
                    ? '<span class="inline-flex items-center gap-1 bg-amber-100 text-amber-800 border border-amber-200 px-2 py-1 rounded font-bold text-[10px] uppercase" title="Ya pagado en báscula propia; excluido de Compra Directo"><span class="material-icons text-[12px]">warehouse</span>Acopio</span>'
                    : '<span class="inline-flex items-center bg-slate-50 text-slate-500 border border-slate-200 px-2 py-1 rounded font-bold text-[10px] uppercase">Directo</span>'}</td>
                <td class="p-3"><span class="inline-flex items-center gap-1 bg-yellow-100 text-yellow-900 border border-yellow-200 px-2 py-1 rounded font-mono font-bold text-xs"><span class="material-icons text-[14px]">receipt_long</span>${escapeHtml(record.reciboIn)}</span></td>
                <td class="p-3 text-right text-xs text-gray-500">L ${formatMoney(record.precio)}</td>
                <td class="p-3 text-right font-mono font-bold text-gray-600">${record.toneladas.toFixed(2)}</td>
                <td class="p-3 text-right font-mono font-bold text-blue-700 text-lg">L ${formatMoney(record.total)}</td>
                <td class="p-3 text-center">
                    <div class="flex gap-2 items-center justify-center">
                        ${renderCorapsaAttachmentThumbnail(record, 'cliente')}
                        ${renderCorapsaAttachmentThumbnail(record, 'nuestro')}
                    </div>
                </td>
                <td class="p-3 text-center"><button type="button" onclick="togglePagoCorapsa('${id}')" class="${badgeClass} px-3 py-1 rounded-full text-[10px] font-bold border">${badgeText}</button></td>
                <td class="p-3 text-center">
                    <button type="button" onclick="abrirActionModal('edit_corapsa', '${id}')" class="text-blue-500 hover:text-blue-800" title="Editar datos y reemplazar archivos"><span class="material-icons text-[18px]">edit</span></button>
                    <button type="button" onclick="abrirActionModal('delete_corapsa', '${id}')" class="text-red-400 hover:text-red-700"><span class="material-icons text-[18px]">delete</span></button>
                </td>
            </tr>`;
    }).join('');
}

// Builds the pre-formatted payload for the Corapsa listado print/preview from
// whatever renderCorapsaTab() last filtered (see ultimoFiltroCorapsa) — never
// re-reads the filter inputs or re-filters corapsaData itself.
function construirPayloadListadoCorapsa() {
    const { filteredData, startDate, endDate, searchRaw, destinoFilter, sumTons, sumTotal } = ultimoFiltroCorapsa;

    const rows = filteredData.map(record => ({
        fecha: formatDateForDisplay(record.fecha),
        cliente: record.cliente,
        destino: record.destino || '-',
        origen: record.esProductoPropio ? 'Acopio' : 'Directo',
        recibo: record.reciboIn,
        precioUnidad: `L ${formatMoney(record.precio)}`,
        toneladas: record.toneladas.toFixed(2),
        total: `L ${formatMoney(record.total)}`,
        estado: record.pagado ? 'Pagado' : 'No Pagado'
    }));

    return {
        generatedAt: new Date().toLocaleString('es-HN'),
        filtroCliente: searchRaw || 'Todos',
        filtroDestino: destinoFilter || 'Todos',
        filtroDesde: startDate ? formatDateForDisplay(startDate) : 'Sin límite',
        filtroHasta: endDate ? formatDateForDisplay(endDate) : 'Sin límite',
        totalRegistros: String(rows.length),
        rows,
        totalToneladas: `${sumTons.toFixed(2)} TON`,
        totalDinero: `L ${formatMoney(sumTotal)}`
    };
}

// Performs the real print IPC call; only invoked once the operator confirms
// "Imprimir" in the preview modal (see printPreview.js).
async function ejecutarImpresionListadoCorapsa(payload) {
    const result = await window.electronAPI.printCorapsaListado(payload);
    if (result?.mode === 'pdf') {
        mostrarNotificacion(`No se encontró una impresora. Listado guardado como PDF en: ${result.path}`, 'error');
    }
}

// Performs the "Guardar" IPC call — lets the operator pick where the PDF
// goes. Returns { cancelled: true } (instead of just resolving) when the
// operator closes the native Save dialog without picking a location, so the
// preview modal knows to stay open instead of treating that as a completed save.
async function ejecutarGuardadoListadoCorapsa(payload) {
    const result = await window.electronAPI.saveCorapsaListadoAsPdf(payload);
    if (result?.mode === 'cancelled') return { cancelled: true };
    mostrarNotificacion(`Listado guardado en: ${result.path}`);
    return result;
}

function imprimirListadoCorapsa() {
    if (typeof window.electronAPI?.printCorapsaListado !== 'function') {
        return mostrarNotificacion(
            'La impresión de listados solo está disponible dentro de la aplicación de escritorio.',
            'error'
        );
    }

    if (ultimoFiltroCorapsa.filteredData.length === 0) {
        return mostrarNotificacion('No hay recibos externos para el filtro actual.', 'error');
    }

    const payload = construirPayloadListadoCorapsa();

    mostrarVistaPrevia({
        template: 'corapsaListado',
        payload,
        title: `Vista previa - Listado de Recibos Externos (${payload.totalRegistros} registros)`,
        printAction: () => ejecutarImpresionListadoCorapsa(payload),
        saveAction: () => ejecutarGuardadoListadoCorapsa(payload)
    });
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
        const attachment = await buildAttachmentPayload(file);
        const body = type === 'nuestro'
            ? { archivoNuestro: attachment, justificacion: activeUploadJustification }
            : { archivoCliente: attachment, justificacion: activeUploadJustification };
        const result = await apiRequest(`/api/corapsa/${encodeURIComponent(record.id)}`, {
            method: 'PATCH',
            body,
            timeoutMs: 30000
        });
        Object.assign(record, normalizarCorapsa(result?.corapsa || result));
        renderCorapsaTab();
        mostrarNotificacion(`Archivo ${type} guardado.`);
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
    corapsaData = corapsaData.filter(item => !sameRecordId(item.id, id));
    renderCorapsaTab();
}