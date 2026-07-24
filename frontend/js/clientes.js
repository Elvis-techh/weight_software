function renderClientesTab() {
    const tbody = document.getElementById('clients-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    MOCK_CLIENTES.forEach(c => {
        tbody.innerHTML += `
            <tr class="hover:bg-blue-50 border-b border-gray-100 last:border-0 transition-colors">
                <td class="p-3 text-sm text-gray-500 font-mono">#${c.id}</td>
                <td class="p-3 text-sm font-bold text-gray-800">${c.nombre} ${c.apellido || ''}</td>
                <td class="p-3 text-sm text-gray-600">${c.telefono || '-'}</td>
                <td class="p-3 text-sm text-gray-600">${c.ubicacion || '-'}</td>
                
                <!-- Separated Prices -->
                <td class="p-3 text-sm font-mono font-bold text-blue-700">L ${Number(c.precioFletePropio).toLocaleString('en-US')}</td>
                <td class="p-3 text-sm font-mono font-bold text-teal-700">L ${Number(c.precioFleteCliente).toLocaleString('en-US')}</td>
                
                <td class="p-3 text-center text-sm font-bold text-gray-600 uppercase">
                    ${c.unidad === 'quintal' ? 'QQ' : 'TON'}
                </td>
        
                <td class="p-3 text-center">
                    <div class="flex justify-center gap-2">
                        <!-- Corrected Button Function Names! -->
                        <button onclick="abrirModalCliente('${c.id}')" class="text-blue-500 hover:text-blue-700 transition-colors"><span class="material-icons text-[18px]">edit</span></button>
                        <button onclick="solicitarEliminarCliente('${c.id}')" class="text-red-500 hover:text-red-700 transition-colors"><span class="material-icons text-[18px]">delete</span></button>
                    </div>
                </td>
            </tr>
        `;
    });
    populateClienteDropdown();
}

function populateClienteDropdown() {
    const select = document.getElementById('cliente-select');
    const dataList = document.getElementById('corapsa-clientes-list');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>Seleccione un cliente...</option>';
    select.innerHTML += '<option value="casual" class="font-bold text-blue-600">👤 Cliente Casual / Rápido</option>';
    if (dataList) dataList.innerHTML = '';

    MOCK_CLIENTES.forEach(c => {
        const option = document.createElement('option');
        option.value = c.id;
        option.text = `${c.nombre} ${c.apellido || ''}`.trim();
        select.appendChild(option);

        if (dataList) {
            const item = document.createElement('option');
            item.value = `${c.nombre} ${c.apellido || ''}`.trim();
            dataList.appendChild(item);
        }
    });
}

function handleClienteSelect() {
    const val = document.getElementById('cliente-select').value;
    if (val === 'casual') {
        document.getElementById('casual-nombre').value = "";
        document.getElementById('casual-precio').value = "";
        document.getElementById('casual-modal').classList.remove('hidden');
    } else {
        mostrarInfoCliente();
    }
}

function cerrarCasualModal() {
    document.getElementById('casual-modal').classList.add('hidden');
    document.getElementById('cliente-select').value = "";
    mostrarInfoCliente();
}

function guardarCasual() {
    const nom = document.getElementById('casual-nombre').value.trim() || "Casual";
    const precioRaw = document.getElementById('casual-precio').value;
    const unidad = document.getElementById('casual-unidad').value;

    if (!precioRaw) return mostrarNotificacion("El precio es obligatorio.", "error");

    let precioFinal = parseFormattedNumber(precioRaw);
    if (!Number.isFinite(precioFinal) || precioFinal < 0) {
        return mostrarNotificacion("Ingrese un precio válido.", "error");
    }

    // Save exactly what they typed, plus the unit
    MOCK_CASUAL.nombre = nom;
    MOCK_CASUAL.precioFletePropio = precioFinal;
    MOCK_CASUAL.precioFleteCliente = precioFinal;
    MOCK_CASUAL.unidad = unidad;

    // Update the dropdown to show the custom name!
    const select = document.getElementById('cliente-select');
    const casualOption = Array.from(select.options).find(opt => opt.value === 'casual');
    if (casualOption) {
        casualOption.text = `👤 Casual: ${nom}`;
    }

    document.getElementById('casual-modal').classList.add('hidden');
    mostrarInfoCliente();
    mostrarNotificacion("Cliente casual configurado.");
}

function abrirModalCliente(id = null) {
    document.getElementById('client-modal').classList.remove('hidden');

    if (id) {
        // --- EDIT MODE ---
        const c = MOCK_CLIENTES.find(x => x.id == id);
        if (!c) return mostrarNotificacion("Cliente no encontrado.", "error");

        document.getElementById('modal-title').innerText = "Editar Cliente";
        document.getElementById('modal-client-id').value = c.id;
        document.getElementById('modal-nombre').value = c.nombre || '';
        document.getElementById('modal-apellido').value = c.apellido || '';
        document.getElementById('modal-telefono').value = c.telefono || '';
        document.getElementById('modal-ubicacion').value = c.ubicacion || '';
        document.getElementById('modal-unidad').value = c.unidad || 'tonelada';
        document.getElementById('modal-precio-propio').value = formatNumberForInput(c.precioFletePropio, 0);
        document.getElementById('modal-precio-cliente').value = formatNumberForInput(c.precioFleteCliente, 0);

        // Show justification box
        document.getElementById('modal-justificacion-container').classList.remove('hidden');
        document.getElementById('modal-justificacion').value = "";
    } else {
        // --- NEW MODE ---
        document.getElementById('modal-title').innerText = "Nuevo Cliente";
        document.getElementById('modal-client-id').value = "";

        ['nombre', 'apellido', 'telefono', 'ubicacion', 'precio-propio', 'precio-cliente', 'justificacion'].forEach(id => {
            const el = document.getElementById(`modal-${id}`);
            if (el) el.value = "";
        });

        // Hide justification box for new clients
        document.getElementById('modal-justificacion-container').classList.add('hidden');
    }
}

function cerrarModalCliente() { document.getElementById('client-modal').classList.add('hidden'); }

function getRequiredElement(id) {
    const element = document.getElementById(id);

    if (!element) {
        throw new Error(`No se encontró el elemento HTML #${id}`);
    }

    return element;
}

function parsePrecioInput(id) {
    const rawValue = getRequiredElement(id).value
        .trim()
        .replace(/,/g, '');

    if (rawValue === '') {
        return NaN;
    }

    return Number(rawValue);
}

async function guardarCliente(event) {
    event.preventDefault();

    const form = getRequiredElement('client-form');
    const saveButton = event.submitter || document.getElementById('btn-guardar-cliente');

    // Check if we have an ID (which means we are editing)
    const clientId = document.getElementById('modal-client-id').value;
    const justificacionStr = document.getElementById('modal-justificacion').value.trim();

    // If we are editing, we MUST have a justification
    if (clientId && !justificacionStr) {
        return mostrarNotificacion('Debe ingresar una justificación para editar el cliente.', 'error');
    }

    const clienteData = {
        nombre: getRequiredElement('modal-nombre').value.trim(),
        apellido: getRequiredElement('modal-apellido').value.trim(),
        telefono: getRequiredElement('modal-telefono').value.trim(),
        ubicacion: getRequiredElement('modal-ubicacion').value.trim(),
        precioFletePropio: parsePrecioInput('modal-precio-propio'),
        precioFleteCliente: parsePrecioInput('modal-precio-cliente'),
        unidad: getRequiredElement('modal-unidad').value,
        justificacion: justificacionStr
    };

    if (!clienteData.nombre) return mostrarNotificacion('El nombre es obligatorio.', 'error');
    if (!Number.isFinite(clienteData.precioFletePropio)) return mostrarNotificacion('Precio propio inválido.', 'error');
    if (!Number.isFinite(clienteData.precioFleteCliente)) return mostrarNotificacion('Precio cliente inválido.', 'error');

    try {
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = 'Guardando...';
        }

        let result;

        if (clientId) {
            // --- FIRE THE PUT ROUTE (EDIT) ---
            result = await apiRequest(`/api/clientes/${clientId}`, {
                method: 'PUT',
                body: clienteData
            });

            // Replace the old client in RAM with the new one
            const index = MOCK_CLIENTES.findIndex(c => c.id == clientId);
            if (index !== -1) MOCK_CLIENTES[index] = result.cliente;

            console.log(`[ALERTA EMAIL] Cliente Modificado: ${clienteData.nombre}. Razón: ${clienteData.justificacion}`);
            mostrarNotificacion('Cliente actualizado exitosamente.');

        } else {
            // --- FIRE THE POST ROUTE (NEW) ---
            result = await apiRequest('/api/clientes', {
                method: 'POST',
                body: clienteData
            });
            MOCK_CLIENTES.push(result.cliente);
            mostrarNotificacion('Cliente guardado exitosamente.');
        }

        renderClientesTab();
        cerrarModalCliente();
        form.reset();

    } catch (error) {
        console.error('Error al guardar cliente:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el cliente.', 'error');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar';
        }
    }
}

function solicitarEliminarCliente(id) {
    abrirActionModal('delete_cliente', id);
}

function abrirAjusteGlobal() {
    document.getElementById('ajuste-monto').value = "";
    document.getElementById('ajuste-razon').value = "";
    document.getElementById('global-price-modal').classList.remove('hidden');
}

function cerrarAjusteGlobal() {
    document.getElementById('global-price-modal').classList.add('hidden');
}

async function aplicarAjusteGlobalForm() {
    const accion = document.getElementById('ajuste-accion').value;
    const montoRaw = document.getElementById('ajuste-monto').value;
    const razon = document.getElementById('ajuste-razon').value;

    if (!montoRaw || !razon) return mostrarNotificacion("Debe ingresar el monto y una justificación.", "error");

    // Clean any commas from the input before parsing
    let monto = Number(montoRaw.replace(/,/g, ''));
    if (!Number.isFinite(monto)) return mostrarNotificacion("Ingrese un monto válido.", "error");

    if (accion === 'disminuir') monto = -monto;

    try {
        // 1. Tell the backend to update the SQLite database
        await apiRequest('/api/clientes/ajuste-global', {
            method: 'POST',
            body: { monto: monto, razon: razon }
        });

        // 2. Update the local RAM array so the table instantly shows the new prices
        MOCK_CLIENTES.forEach(c => {
            c.precioFletePropio += monto;
            c.precioFleteCliente += monto;
        });

        console.log(`[ALERTA EMAIL] Ajuste global: ${monto > 0 ? '+L' + monto : '-L' + Math.abs(monto)}. Razón: ${razon}`);

        mostrarNotificacion(`Precios actualizados exitosamente en la base de datos.`);
        renderClientesTab();
        cerrarAjusteGlobal();

    } catch (error) {
        console.error("Error al aplicar ajuste global:", error);
        mostrarNotificacion("Error al guardar el ajuste en la base de datos.", "error");
    }
}