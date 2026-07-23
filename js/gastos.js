function abrirGastosModal(id = null) {
    document.getElementById('gastos-modal').classList.remove('hidden');
    if (id) {
        const g = gastosData.find(x => x.id == id);
        if (!g) return mostrarNotificacion("Gasto no encontrado.", "error");
        document.getElementById('gastos-modal-title').innerText = "Editar Gasto";
        document.getElementById('gastos-edit-id').value = g.id;
        document.getElementById('gastos-fecha').value = g.fecha;
        document.getElementById('gastos-monto').value = formatNumberForInput(g.monto, 2);
        document.getElementById('gastos-concepto').value = g.concepto;
        document.getElementById('gastos-justificacion').value = g.justificacion;
    } else {
        document.getElementById('gastos-modal-title').innerText = "Nuevo Gasto";
        document.getElementById('gastos-edit-id').value = "";
        document.getElementById('gastos-fecha').value = getLocalIsoDate();
        document.getElementById('gastos-monto').value = "";
        document.getElementById('gastos-concepto').value = "";
        document.getElementById('gastos-justificacion').value = "";
    }
    document.getElementById('gastos-file').value = "";
}

function cerrarGastosModal() { document.getElementById('gastos-modal').classList.add('hidden'); }

async function guardarGasto() {
    const id = document.getElementById('gastos-edit-id').value;
    const fecha = document.getElementById('gastos-fecha').value;
    const monto = parseFormattedNumber(document.getElementById('gastos-monto').value);
    const concepto = document.getElementById('gastos-concepto').value.trim();
    const justificacion = document.getElementById('gastos-justificacion').value.trim();
    const fileInput = document.getElementById('gastos-file');
    const existing = id ? gastosData.find(x => x.id == id) : null;
    const fileName = fileInput.files.length > 0 ? fileInput.files[0].name : (existing?.fileName || "Sin Archivo");

    if (!fecha || !Number.isFinite(monto) || monto < 0 || !concepto) {
        return mostrarNotificacion("Complete los campos obligatorios con valores válidos.", "error");
    }

    const payload = { fecha, monto, concepto, justificacion, fileName };

    try {
        const method = id ? 'PUT' : 'POST';
        const endpoint = id ? `${API_URL}/api/gastos/${id}` : `${API_URL}/api/gastos`;

        const response = await fetch(endpoint, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            let serverRecord = null;
            try { serverRecord = await response.json(); } catch (_) { /* optional body */ }

            if (id) {
                const g = gastosData.find(x => x.id == id);
                if (g) Object.assign(g, payload, serverRecord || {});
                mostrarNotificacion("Gasto actualizado en el servidor.");
            } else {
                gastosData.unshift({ id: serverRecord?.id ?? Date.now(), ...payload, ...(serverRecord || {}) });
                mostrarNotificacion("Gasto registrado en el servidor.");
            }
            renderGastos();
            cerrarGastosModal();
        } else {
            mostrarNotificacion("Error al guardar el gasto en la nube.", "error");
        }
    } catch (error) {
        console.error(error);
        mostrarNotificacion("Fallo de conexión. Revise la red.", "error");
    }
}

function renderGastos() {
    const tbody = document.getElementById('gastos-table-body');
    if (!tbody) return;
    if (gastosData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-gray-400">Sin gastos registrados.</td></tr>`;
        return;
    }
    tbody.innerHTML = '';
    gastosData.forEach(g => {
        const displayDate = g.fecha.split('-').reverse().join('/');
        tbody.innerHTML += `
            <tr class="hover:bg-red-50">
                <td class="p-4 font-mono text-gray-600">${displayDate}</td>
                <td class="p-4 font-bold text-gray-800">${g.concepto}</td>
                <td class="p-4 text-right font-mono font-bold text-red-700">L ${Number(g.monto || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                <td class="p-4 text-xs text-gray-500">${g.justificacion || '-'}</td>
                <td class="p-4 text-center">
                    <span class="text-[10px] bg-gray-200 px-2 py-1 rounded truncate max-w-[120px] inline-block" title="${g.fileName}">📎 ${g.fileName}</span>
                </td>
                <td class="p-4 text-center">
                    <button onclick="abrirGastosModal(${g.id})" class="text-blue-500 hover:text-blue-800 mx-1"><span class="material-icons text-[18px]">edit</span></button>
                    <button onclick="gastosData = gastosData.filter(x=>x.id!=${g.id}); renderGastos();" class="text-red-400 hover:text-red-700 mx-1"><span class="material-icons text-[18px]">delete</span></button>
                </td>
            </tr>
        `;
    });
}