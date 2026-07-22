function abrirPlanillaModal(id = null) {
    document.getElementById('planilla-modal').classList.remove('hidden');
    if (id) {
        const p = planillaData.find(x => x.id === id);
        document.getElementById('planilla-modal-title').innerText = "Editar Trabajador";
        document.getElementById('planilla-edit-id').value = p.id;
        document.getElementById('planilla-nombre').value = p.nombre;
        document.getElementById('planilla-apellido').value = p.apellido;
        document.getElementById('planilla-telefono').value = p.telefono;
        document.getElementById('planilla-sueldo').value = p.sueldoBase;
    } else {
        document.getElementById('planilla-modal-title').innerText = "Agregar Trabajador";
        document.getElementById('planilla-edit-id').value = "";
        document.getElementById('planilla-nombre').value = "";
        document.getElementById('planilla-apellido').value = "";
        document.getElementById('planilla-telefono').value = "";
        document.getElementById('planilla-sueldo').value = "";
    }
}

function cerrarPlanillaModal() { document.getElementById('planilla-modal').classList.add('hidden'); }

async function guardarTrabajador() {
    const id = document.getElementById('planilla-edit-id').value;
    const nombre = document.getElementById('planilla-nombre').value;
    const apellido = document.getElementById('planilla-apellido').value;
    const telefono = document.getElementById('planilla-telefono').value;
    const sueldoBase = parseFloat(document.getElementById('planilla-sueldo').value);

    if (!nombre || !apellido || isNaN(sueldoBase)) return mostrarNotificacion("Complete los campos obligatorios.", "error");

    const payload = { nombre, apellido, telefono, sueldoBase };

    try {
        const method = id ? 'PUT' : 'POST';
        const endpoint = id ? `${API_URL}/api/planilla/${id}` : `${API_URL}/api/planilla`;

        const response = await fetch(endpoint, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            if (id) {
                const p = planillaData.find(x => x.id == id);
                p.nombre = nombre; p.apellido = apellido; p.telefono = telefono; p.sueldoBase = sueldoBase;
                mostrarNotificacion("Trabajador actualizado en el servidor.");
            } else {
                planillaData.push({ id: Date.now(), ...payload, diasTrabajados: 6, extras: 0 });
                mostrarNotificacion("Trabajador registrado en el servidor.");
            }
            renderPlanilla();
            cerrarPlanillaModal();
        } else {
            mostrarNotificacion("Error al guardar el trabajador en la nube.", "error");
        }
    } catch (error) {
        mostrarNotificacion("Fallo de conexión. Revise la red.", "error");
    }
}

function calcularFilaPlanilla(id) {
    const p = planillaData.find(x => x.id == id);
    if (!p) return;

    p.diasTrabajados = parseFloat(document.getElementById(`dias-${id}`).value) || 0;
    p.extras = parseFloat(document.getElementById(`extras-${id}`).value) || 0;

    const dailyRate = p.sueldoBase / 6;
    const total = (dailyRate * p.diasTrabajados) + p.extras;

    document.getElementById(`total-${id}`).innerText = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderPlanilla() {
    const tbody = document.getElementById('planilla-table-body');
    if (planillaData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-gray-400">Sin trabajadores registrados.</td></tr>`;
        return;
    }
    tbody.innerHTML = '';
    planillaData.forEach(p => {
        const dailyRate = p.sueldoBase / 6;
        const initialTotal = (dailyRate * p.diasTrabajados) + p.extras;

        tbody.innerHTML += `
            <tr class="hover:bg-orange-50 border-b border-gray-100">
                <td class="p-3">
                    <div class="font-bold text-gray-800">${p.nombre} ${p.apellido}</div>
                    <div class="text-xs text-gray-500">${p.telefono || 'Sin teléfono'}</div>
                </td>
                <td class="p-3 text-center font-mono font-bold text-gray-600">L ${p.sueldoBase.toLocaleString()}</td>
                <td class="p-3 text-center">
                    <input type="number" id="dias-${p.id}" value="${p.diasTrabajados}" step="0.5" min="0" max="7" oninput="calcularFilaPlanilla(${p.id})" class="w-16 border rounded p-1 text-center font-bold text-orange-900 focus:ring-2 outline-none">
                </td>
                <td class="p-3 text-center">
                    <input type="number" id="extras-${p.id}" value="${p.extras}" step="10" oninput="calcularFilaPlanilla(${p.id})" class="w-20 border rounded p-1 text-right font-bold text-green-700 focus:ring-2 outline-none">
                </td>
                <td class="p-3 text-right bg-orange-50">
                    <div class="font-mono font-black text-orange-700 text-lg">L <span id="total-${p.id}">${initialTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                </td>
                <td class="p-3 text-center">
                    <button onclick="abrirPlanillaModal(${p.id})" class="text-blue-500 hover:text-blue-800 mx-1"><span class="material-icons text-[18px]">edit</span></button>
                    <button onclick="planillaData = planillaData.filter(x=>x.id!=${p.id}); renderPlanilla();" class="text-red-400 hover:text-red-700 mx-1"><span class="material-icons text-[18px]">delete</span></button>
                </td>
            </tr>
        `;
    });
}