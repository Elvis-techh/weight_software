function normalizarGasto(record = {}) {
    return {
        id: record.id,
        fecha: String(record.fecha || ''),
        monto: toFiniteNumber(record.monto),
        concepto: String(record.concepto || ''),
        justificacion: String(record.justificacion || ''),
        fileName: String(record.fileName ?? record.file_name ?? 'Sin Archivo')
    };
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
    document.getElementById('gastos-modal').classList.remove('hidden');
}

function cerrarGastosModal() {
    document.getElementById('gastos-modal').classList.add('hidden');
}

async function guardarGasto() {
    const id = document.getElementById('gastos-edit-id').value;
    const existing = id ? gastosData.find(item => sameRecordId(item.id, id)) : null;
    const selectedFile = document.getElementById('gastos-file').files[0] || null;

    const payload = {
        fecha: document.getElementById('gastos-fecha').value,
        monto: parseFormattedNumber(document.getElementById('gastos-monto').value),
        concepto: document.getElementById('gastos-concepto').value.trim(),
        justificacion: document.getElementById('gastos-justificacion').value.trim(),
        fileName: selectedFile?.name || existing?.fileName || 'Sin Archivo'
    };

    if (!payload.fecha || !payload.concepto) return mostrarNotificacion('Complete los campos obligatorios.', 'error');
    if (!Number.isFinite(payload.monto) || payload.monto <= 0) return mostrarNotificacion('El monto debe ser mayor que cero.', 'error');

    try {
        const result = id
            ? await apiRequest(`/api/gastos/${encodeURIComponent(id)}`, { method: 'PUT', body: payload })
            : await apiRequest('/api/gastos', { method: 'POST', body: payload });
        const saved = normalizarGasto(result?.gasto || result);
        const index = gastosData.findIndex(item => sameRecordId(item.id, saved.id));
        if (index >= 0) gastosData[index] = saved;
        else gastosData.unshift(saved);

        renderGastos();
        cerrarGastosModal();
        mostrarNotificacion(id ? 'Gasto actualizado.' : 'Gasto registrado.');
    } catch (error) {
        console.error('Error al guardar gasto:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el gasto.', 'error');
    }
}

function renderGastos() {
    const tbody = document.getElementById('gastos-table-body');
    if (!tbody) return;

    if (gastosData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-gray-400">Sin gastos registrados.</td></tr>';
        return;
    }

    tbody.innerHTML = gastosData.map(gasto => `
        <tr class="hover:bg-red-50">
            <td class="p-4 font-mono text-gray-600">${escapeHtml(formatDateForDisplay(gasto.fecha))}</td>
            <td class="p-4 font-bold text-gray-800">${escapeHtml(gasto.concepto)}</td>
            <td class="p-4 text-right font-mono font-bold text-red-700">L ${formatMoney(gasto.monto)}</td>
            <td class="p-4 text-xs text-gray-500">${escapeHtml(gasto.justificacion || '-')}</td>
            <td class="p-4 text-center"><span class="text-[10px] bg-gray-200 px-2 py-1 rounded truncate max-w-[120px] inline-block" title="${escapeHtml(gasto.fileName)}">📎 ${escapeHtml(gasto.fileName)}</span></td>
            <td class="p-4 text-center">
                <button type="button" onclick="abrirGastosModal('${escapeHtml(gasto.id)}')" class="text-blue-500 hover:text-blue-800 mx-1"><span class="material-icons text-[18px]">edit</span></button>
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