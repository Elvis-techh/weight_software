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

function assignCorapsaAttachment(trans, type, file) {
    const keys = getCorapsaAttachmentKeys(type);
    revokePreviewUrl(trans[keys.url]);
    trans[keys.name] = file.name;
    trans[keys.url] = URL.createObjectURL(file);
    trans[keys.mime] = file.type || '';
}

function clearCorapsaAttachment(trans, type) {
    const keys = getCorapsaAttachmentKeys(type);
    revokePreviewUrl(trans[keys.url]);
    trans[keys.name] = 'Sin Archivo';
    trans[keys.url] = null;
    trans[keys.mime] = '';
}

function abrirCorapsaModal(id = null) {
    document.getElementById('corapsa-modal').classList.remove('hidden');

    if (id) {
        const trans = corapsaData.find(t => t.id == id);
        if (!trans) return mostrarNotificacion("Recibo externo no encontrado.", "error");
        document.getElementById('corapsa-modal-title').innerText = "Editar Recibo Externo";
        document.getElementById('corapsa-edit-id').value = trans.id;
        document.getElementById('corapsa-fecha').value = trans.fecha;
        document.getElementById('corapsa-recibo-in').value = trans.reciboIn;
        document.getElementById('corapsa-cliente').value = trans.cliente;
        document.getElementById('corapsa-toneladas').value = trans.toneladas;
        document.getElementById('corapsa-precio').value = formatNumberForInput(trans.precio, 2);
        document.getElementById('corapsa-total-display').innerText = Number(trans.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById('corapsa-file').value = "";
    } else {
        document.getElementById('corapsa-modal-title').innerText = "Registrar Recibo Externo";
        document.getElementById('corapsa-edit-id').value = "";
        document.getElementById('corapsa-fecha').value = getLocalIsoDate();
        document.getElementById('corapsa-recibo-in').value = '';
        document.getElementById('corapsa-cliente').value = '';
        document.getElementById('corapsa-toneladas').value = '';
        document.getElementById('corapsa-precio').value = '';
        document.getElementById('corapsa-total-display').innerText = '0.00';
        document.getElementById('corapsa-file').value = "";
    }
}

function cerrarCorapsaModal() { document.getElementById('corapsa-modal').classList.add('hidden'); }

function handleCorapsaClientInput() {
    const inputVal = document.getElementById('corapsa-cliente').value;
    const match = MOCK_CLIENTES.find(c => `${c.nombre} ${c.apellido || ''}`.trim() === inputVal);
    if (match) {
        document.getElementById('corapsa-precio').value = formatNumberForInput(match.precioFletePropio, 2);
        calcularTotalCorapsa();
    }
}

function calcularTotalCorapsa() {
    const tons = parseFormattedNumber(document.getElementById('corapsa-toneladas').value) || 0;
    const precio = parseFormattedNumber(document.getElementById('corapsa-precio').value) || 0;
    const total = tons * precio;
    document.getElementById('corapsa-total-display').innerText = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return total;
}

async function parseOptionalJson(response) {
    try { return await response.json(); } catch (_) { return null; }
}

async function guardarCorapsa() {
    const id = document.getElementById('corapsa-edit-id').value;
    const fecha = document.getElementById('corapsa-fecha').value;
    const reciboIn = document.getElementById('corapsa-recibo-in').value.trim();
    const cliente = document.getElementById('corapsa-cliente').value.trim();
    const toneladas = parseFormattedNumber(document.getElementById('corapsa-toneladas').value);
    const precio = parseFormattedNumber(document.getElementById('corapsa-precio').value);

    const fileInput = document.getElementById('corapsa-file');
    const selectedFile = fileInput.files.length > 0 ? fileInput.files[0] : null;
    const existing = id ? corapsaData.find(t => t.id == id) : null;

    if (!cliente || !Number.isFinite(toneladas) || !Number.isFinite(precio) || !fecha || !reciboIn) {
        return mostrarNotificacion("Todos los campos con * son obligatorios.", "error");
    }
    if (toneladas <= 0 || precio < 0) {
        return mostrarNotificacion("Toneladas y precio deben contener valores válidos.", "error");
    }

    const totalCalculado = toneladas * precio;
    const payload = {
        fecha,
        reciboIn,
        cliente,
        toneladas,
        precio,
        total: totalCalculado,
        fileName: selectedFile?.name || existing?.fileName || "Sin Archivo",
        pagado: existing?.pagado ?? false
    };

    try {
        const method = id ? 'PUT' : 'POST';
        const endpoint = id ? `${API_URL}/api/corapsa/${id}` : `${API_URL}/api/corapsa`;
        const response = await fetch(endpoint, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            const serverRecord = await parseOptionalJson(response);
            if (id) {
                const trans = corapsaData.find(t => t.id == id);
                if (trans) {
                    const preservedNuestro = {
                        fileNuestro: trans.fileNuestro,
                        fileNuestroPreviewUrl: trans.fileNuestroPreviewUrl,
                        fileNuestroMimeType: trans.fileNuestroMimeType
                    };
                    Object.assign(trans, payload, serverRecord || {}, preservedNuestro);
                    if (selectedFile) assignCorapsaAttachment(trans, 'cliente', selectedFile);
                }
                mostrarNotificacion("Recibo actualizado en el servidor.");
            } else {
                const autoReciboOut = `CRX-${Date.now().toString().slice(-6)}`;
                const newRecord = {
                    id: serverRecord?.id ?? Date.now(),
                    reciboOut: serverRecord?.reciboOut ?? autoReciboOut,
                    ...payload,
                    ...(serverRecord || {})
                };
                if (selectedFile) assignCorapsaAttachment(newRecord, 'cliente', selectedFile);
                corapsaData.unshift(newRecord);
                mostrarNotificacion("Recibo externo registrado en el servidor.");
            }
            renderCorapsaTab();
            cerrarCorapsaModal();
        } else {
            mostrarNotificacion("Error al guardar el recibo en la nube.", "error");
        }
    } catch (error) {
        console.error(error);
        mostrarNotificacion("Fallo de conexión. Revise la red.", "error");
    }
}

function togglePagoCorapsa(id) {
    const trans = corapsaData.find(t => t.id == id);
    if (trans) {
        trans.pagado = !trans.pagado;
        renderCorapsaTab();
    }
}

function imprimirCorapsa(id) { mostrarNotificacion("Imprimiendo comprobante Corapsa...", "success"); }

function abrirVisorRecibo(id, type = 'cliente') {
    const trans = corapsaData.find(t => t.id == id);
    if (!trans) return mostrarNotificacion("Recibo no encontrado.", "error");

    const keys = getCorapsaAttachmentKeys(type);
    const fileName = trans[keys.name];
    if (!fileName || fileName === 'Sin Archivo') {
        return mostrarNotificacion("No hay archivo adjunto.", "error");
    }

    activeReceiptViewer = { id: trans.id, type };
    document.getElementById('visor-file-name').innerText = fileName;

    const container = document.getElementById('receipt-preview-container');
    container.replaceChildren();

    const previewUrl = trans[keys.url];
    const mimeType = trans[keys.mime] || '';

    if (previewUrl) {
        if (mimeType.startsWith('image/')) {
            const image = document.createElement('img');
            image.src = previewUrl;
            image.alt = fileName;
            image.className = 'max-w-full max-h-full object-contain rounded shadow';
            container.appendChild(image);
        } else {
            const frame = document.createElement('iframe');
            frame.src = previewUrl;
            frame.title = fileName;
            frame.className = 'w-full h-full min-h-[500px] bg-white rounded border';
            container.appendChild(frame);
        }
    } else {
        const message = document.createElement('div');
        message.className = 'max-w-lg text-center text-gray-500 bg-white border-2 border-dashed rounded-xl p-8';
        const icon = document.createElement('span');
        icon.className = 'material-icons text-6xl text-gray-400';
        icon.textContent = 'cloud_off';
        const heading = document.createElement('p');
        heading.className = 'mt-3 font-bold text-gray-700';
        heading.textContent = 'El nombre del archivo está registrado, pero el contenido no está disponible localmente.';
        const detail = document.createElement('p');
        detail.className = 'mt-2 text-sm';
        detail.textContent = 'Los archivos nuevos seleccionados durante esta sesión sí se pueden visualizar. La persistencia completa llegará con la etapa de cargas reales.';
        message.append(icon, heading, detail);
        container.appendChild(message);
    }

    document.getElementById('view-receipt-modal').classList.remove('hidden');
}

function cerrarVisorRecibo() {
    document.getElementById('view-receipt-modal').classList.add('hidden');
    activeReceiptViewer = { id: null, type: null };
}

function solicitarEliminarArchivoActual() {
    if (!activeReceiptViewer.id) return mostrarNotificacion("No hay archivo seleccionado.", "error");
    abrirActionModal('delete_corapsa_file', `${activeReceiptViewer.id}|${activeReceiptViewer.type}`);
}

function solicitarReemplazarArchivoActual() {
    if (!activeReceiptViewer.id) return mostrarNotificacion("No hay archivo seleccionado.", "error");
    abrirActionModal('replace_corapsa_file', `${activeReceiptViewer.id}|${activeReceiptViewer.type}`);
}

function eliminarArchivoCorapsa(ref, justificacion) {
    const { id, type } = getCorapsaReferenceParts(ref);
    const trans = corapsaData.find(t => t.id == id);
    if (!trans) return mostrarNotificacion("Recibo no encontrado.", "error");

    const keys = getCorapsaAttachmentKeys(type);
    const oldName = trans[keys.name];
    clearCorapsaAttachment(trans, type);
    console.log(`[AUDITORIA] Archivo Corapsa eliminado (${oldName}). Razón: ${justificacion}`);
    cerrarVisorRecibo();
    renderCorapsaTab();
    mostrarNotificacion("Archivo eliminado exitosamente.");
}

function prepararReemplazoArchivoCorapsa(ref, justificacion) {
    const { id, type } = getCorapsaReferenceParts(ref);
    const trans = corapsaData.find(t => t.id == id);
    if (!trans) return mostrarNotificacion("Recibo no encontrado.", "error");

    activeUploadId = trans.id;
    activeUploadType = type;
    activeUploadJustification = justificacion;
    cerrarVisorRecibo();
    document.getElementById(type === 'cliente' ? 'hidden-file-cliente' : 'hidden-file-nuestro').click();
}

function renderCorapsaTab() {
    const tbody = document.getElementById('corapsa-table-body');
    if (!tbody) return;

    const startD = document.getElementById('corapsa-filter-start')?.value || '';
    const endD = document.getElementById('corapsa-filter-end')?.value || '';
    const searchVal = (document.getElementById('corapsa-filter-client')?.value || '').toLowerCase();

    const filtered = corapsaData.filter(t => {
        if (startD && t.fecha < startD) return false;
        if (endD && t.fecha > endD) return false;
        if (searchVal && !String(t.cliente || '').toLowerCase().includes(searchVal) && !String(t.reciboIn || '').toLowerCase().includes(searchVal)) return false;
        return true;
    });

    let sumTons = 0;
    let sumTotal = 0;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="p-8 text-center text-gray-400">Sin recibos registrados.</td></tr>`;
        document.getElementById('corapsa-total-toneladas').innerText = "0.00";
        document.getElementById('corapsa-total-dinero').innerText = "0.00";
        return;
    }

    tbody.innerHTML = '';
    filtered.forEach(t => {
        sumTons += Number(t.toneladas || 0);
        sumTotal += Number(t.total || 0);

        const displayDate = t.fecha.split('-').reverse().join('/');
        const badgeClass = t.pagado ? "bg-green-100 text-green-700 border-green-200" : "bg-red-100 text-red-700 border-red-200";
        const badgeText = t.pagado ? "PAGADO" : "NO PAGADO";

        const fileC = t.fileName && t.fileName !== "Sin Archivo" ? t.fileName : "Sin archivo";
        const fileN = t.fileNuestro && t.fileNuestro !== "Sin Archivo" ? t.fileNuestro : "Sin archivo";
        const iconC = fileC !== "Sin archivo" ? "text-blue-600 border-blue-200 bg-blue-50" : "text-gray-400";
        const iconN = fileN !== "Sin archivo" ? "text-brand-600 border-brand-200 bg-brand-50" : "text-gray-400";
        const actionC = fileC !== 'Sin archivo' ? `abrirVisorRecibo(${t.id}, 'cliente')` : `triggerQuickUpload(${t.id}, 'cliente')`;
        const actionN = fileN !== 'Sin archivo' ? `abrirVisorRecibo(${t.id}, 'nuestro')` : `triggerQuickUpload(${t.id}, 'nuestro')`;

        tbody.innerHTML += `
            <tr class="hover:bg-blue-50">
                <td class="p-3 text-sm font-mono text-gray-600 font-bold">${displayDate}</td>
                <td class="p-3 font-bold text-gray-800">${t.cliente}</td>
                <td class="p-3">
                    <span class="inline-flex items-center gap-1 bg-yellow-100 text-yellow-900 border border-yellow-200 px-2 py-1 rounded font-mono font-bold text-xs">
                        <span class="material-icons text-[14px]">receipt_long</span>${t.reciboIn}
                    </span>
                </td>
                <td class="p-3 text-right text-xs text-gray-500">L ${Number(t.precio || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                <td class="p-3 text-right font-mono font-bold text-gray-600">${Number(t.toneladas || 0).toFixed(2)}</td>
                <td class="p-3 text-right font-mono font-bold text-blue-700 text-lg">L ${Number(t.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="p-3 text-center">
                    <div class="flex flex-col gap-1 items-center">
                        <button onclick="${actionC}" title="${fileC !== 'Sin archivo' ? 'Abrir: ' + fileC : 'Adjuntar archivo del cliente'}" class="text-[10px] font-bold border rounded px-2 py-1.5 hover:shadow flex items-center gap-1 w-28 truncate justify-center ${iconC}">
                            <span class="material-icons text-[14px]">${fileC !== 'Sin archivo' ? 'visibility' : 'attach_file'}</span> Cliente
                        </button>
                        <button onclick="${actionN}" title="${fileN !== 'Sin archivo' ? 'Abrir: ' + fileN : 'Adjuntar archivo interno'}" class="text-[10px] font-bold border rounded px-2 py-1.5 hover:shadow flex items-center gap-1 w-28 truncate justify-center ${iconN}">
                            <span class="material-icons text-[14px]">${fileN !== 'Sin archivo' ? 'visibility' : 'attach_file'}</span> Nuestro
                        </button>
                    </div>
                </td>
                <td class="p-3 text-center">
                    <button onclick="togglePagoCorapsa(${t.id})" class="${badgeClass} px-3 py-1 rounded-full text-[10px] font-bold border transition-colors hover:shadow-md cursor-pointer">${badgeText}</button>
                </td>
                <td class="p-3 text-center">
                    <div class="flex justify-center gap-1 items-center">
                        <button onclick="abrirActionModal('edit_corapsa', ${t.id})" class="text-blue-500 hover:text-blue-800 transition-colors"><span class="material-icons text-[18px]">edit</span></button>
                        <button onclick="abrirActionModal('delete_corapsa', ${t.id})" class="text-red-400 hover:text-red-700 transition-colors"><span class="material-icons text-[18px]">delete</span></button>
                    </div>
                </td>
            </tr>
        `;
    });

    document.getElementById('corapsa-total-toneladas').innerText = sumTons.toFixed(2);
    document.getElementById('corapsa-total-dinero').innerText = sumTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function triggerQuickUpload(id, type) {
    activeUploadId = id;
    activeUploadType = type;
    activeUploadJustification = null;
    document.getElementById(type === 'cliente' ? 'hidden-file-cliente' : 'hidden-file-nuestro').click();
}

function processQuickUpload(event, fallbackType) {
    if (!activeUploadId || event.target.files.length === 0) return;
    const type = activeUploadType || fallbackType;
    const trans = corapsaData.find(t => t.id == activeUploadId);
    const file = event.target.files[0];
    const idToOpen = activeUploadId;

    if (trans) {
        assignCorapsaAttachment(trans, type, file);
        const reason = activeUploadJustification ? ` Razón: ${activeUploadJustification}` : '';
        console.log(`[AUDITORIA] Archivo ${type} adjuntado/reemplazado: ${file.name}.${reason}`);
        mostrarNotificacion(`Archivo ${type} adjuntado.`);
        renderCorapsaTab();
    }

    event.target.value = '';
    activeUploadId = null;
    activeUploadType = null;
    activeUploadJustification = null;

    if (trans) abrirVisorRecibo(idToOpen, type);
}