function normalizarTrabajador(record = {}) {
    return {
        id: record.id,
        nombre: String(record.nombre || ''),
        apellido: String(record.apellido || ''),
        telefono: String(record.telefono || ''),
        sueldoBase: toFiniteNumber(record.sueldoBase ?? record.sueldo_base),
        diasTrabajados: toFiniteNumber(record.diasTrabajados ?? record.dias_trabajados, 6),
        extras: toFiniteNumber(record.extras)
    };
}

function abrirPlanillaModal(id = null) {
    const trabajador = id == null ? null : planillaData.find(item => sameRecordId(item.id, id));
    if (id != null && !trabajador) return mostrarNotificacion('Trabajador no encontrado.', 'error');

    document.getElementById('planilla-modal-title').textContent = trabajador ? 'Editar Trabajador' : 'Agregar Trabajador';
    document.getElementById('planilla-edit-id').value = trabajador?.id ?? '';
    document.getElementById('planilla-nombre').value = trabajador?.nombre || '';
    document.getElementById('planilla-apellido').value = trabajador?.apellido || '';
    document.getElementById('planilla-telefono').value = trabajador?.telefono || '';
    document.getElementById('planilla-sueldo').value = trabajador?.sueldoBase || '';
    document.getElementById('planilla-modal').classList.remove('hidden');
}

function cerrarPlanillaModal() {
    document.getElementById('planilla-modal').classList.add('hidden');
}

async function guardarTrabajador() {
    const id = document.getElementById('planilla-edit-id').value;
    const existing = id ? planillaData.find(item => sameRecordId(item.id, id)) : null;
    const payload = {
        nombre: document.getElementById('planilla-nombre').value.trim(),
        apellido: document.getElementById('planilla-apellido').value.trim(),
        telefono: document.getElementById('planilla-telefono').value.trim(),
        sueldoBase: parseFormattedNumber(document.getElementById('planilla-sueldo').value),
        diasTrabajados: existing?.diasTrabajados ?? 6,
        extras: existing?.extras ?? 0
    };

    if (!payload.nombre || !payload.apellido) return mostrarNotificacion('Nombre y apellido son obligatorios.', 'error');
    if (!Number.isFinite(payload.sueldoBase) || payload.sueldoBase <= 0) return mostrarNotificacion('El sueldo base debe ser mayor que cero.', 'error');

    try {
        const result = id
            ? await apiRequest(`/api/planilla/${encodeURIComponent(id)}`, { method: 'PUT', body: payload })
            : await apiRequest('/api/planilla', { method: 'POST', body: payload });
        const saved = normalizarTrabajador(result?.trabajador || result);
        const index = planillaData.findIndex(item => sameRecordId(item.id, saved.id));
        if (index >= 0) planillaData[index] = saved;
        else planillaData.push(saved);

        renderPlanilla();
        cerrarPlanillaModal();
        mostrarNotificacion(id ? 'Trabajador actualizado.' : 'Trabajador registrado.');
    } catch (error) {
        console.error('Error al guardar trabajador:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el trabajador.', 'error');
    }
}

function calcularFilaPlanilla(id) {
    const trabajador = planillaData.find(item => sameRecordId(item.id, id));
    if (!trabajador) return;

    const dias = parseFormattedNumber(document.getElementById(`dias-${id}`)?.value);
    const extras = parseFormattedNumber(document.getElementById(`extras-${id}`)?.value);
    trabajador.diasTrabajados = Number.isFinite(dias) ? Math.min(Math.max(dias, 0), 7) : 0;
    trabajador.extras = Number.isFinite(extras) ? Math.max(extras, 0) : 0;

    const total = (trabajador.sueldoBase / 6) * trabajador.diasTrabajados + trabajador.extras;
    const display = document.getElementById(`total-${id}`);
    if (display) display.textContent = formatMoney(total);
}

async function guardarFilaPlanilla(id) {
    const trabajador = planillaData.find(item => sameRecordId(item.id, id));
    if (!trabajador) return;
    calcularFilaPlanilla(id);

    try {
        const result = await apiRequest(`/api/planilla/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: {
                diasTrabajados: trabajador.diasTrabajados,
                extras: trabajador.extras
            }
        });
        Object.assign(trabajador, normalizarTrabajador(result?.trabajador || result));
    } catch (error) {
        console.error('No se pudo actualizar la fila de planilla:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar la jornada.', 'error');
        await fetchPlanilla().catch(() => {});
    }
}

function renderPlanilla() {
    const tbody = document.getElementById('planilla-table-body');
    if (!tbody) return;

    if (planillaData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-gray-400">Sin trabajadores registrados.</td></tr>';
        return;
    }

    tbody.innerHTML = planillaData.map(trabajador => {
        const total = (trabajador.sueldoBase / 6) * trabajador.diasTrabajados + trabajador.extras;
        const id = escapeHtml(trabajador.id);
        return `
            <tr class="hover:bg-orange-50 border-b border-gray-100">
                <td class="p-3"><div class="font-bold text-gray-800">${escapeHtml(`${trabajador.nombre} ${trabajador.apellido}`)}</div><div class="text-xs text-gray-500">${escapeHtml(trabajador.telefono || 'Sin teléfono')}</div></td>
                <td class="p-3 text-center font-mono font-bold text-gray-600">L ${formatMoney(trabajador.sueldoBase)}</td>
                <td class="p-3 text-center"><input type="number" id="dias-${id}" value="${trabajador.diasTrabajados}" step="0.5" min="0" max="7" oninput="calcularFilaPlanilla('${id}')" onchange="guardarFilaPlanilla('${id}')" class="w-16 border rounded p-1 text-center font-bold text-orange-900 focus:ring-2 outline-none"></td>
                <td class="p-3 text-center"><input type="number" id="extras-${id}" value="${trabajador.extras}" step="10" min="0" oninput="calcularFilaPlanilla('${id}')" onchange="guardarFilaPlanilla('${id}')" class="w-20 border rounded p-1 text-right font-bold text-green-700 focus:ring-2 outline-none"></td>
                <td class="p-3 text-right bg-orange-50"><div class="font-mono font-black text-orange-700 text-lg">L <span id="total-${id}">${formatMoney(total)}</span></div></td>
                <td class="p-3 text-center">
                    <button type="button" onclick="abrirPlanillaModal('${id}')" class="text-blue-500 hover:text-blue-800 mx-1"><span class="material-icons text-[18px]">edit</span></button>
                    <button type="button" onclick="abrirActionModal('delete_trabajador', '${id}')" class="text-red-400 hover:text-red-700 mx-1"><span class="material-icons text-[18px]">delete</span></button>
                </td>
            </tr>
        `;
    }).join('');
}

async function eliminarTrabajadorServidor(id, justificacion) {
    await apiRequest(`/api/planilla/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });
    planillaData = planillaData.filter(item => !sameRecordId(item.id, id));
    renderPlanilla();
}