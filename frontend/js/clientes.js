function renderClientesTab() {
    const tbody = document.getElementById('clients-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    MOCK_CLIENTES.forEach(c => {
        // Inside your render/draw function:
        tbody.innerHTML += `
            <tr class="hover:bg-blue-50 border-b border-gray-100 last:border-0 transition-colors">
                <td class="p-3 text-sm text-gray-500 font-mono">#${c.id}</td>
                <td class="p-3 text-sm font-bold text-gray-800">${c.nombre} ${c.apellido || ''}</td>
                <td class="p-3 text-sm text-gray-600 hidden md:table-cell">${c.telefono || '-'}</td>
                <td class="p-3 text-sm text-gray-600 hidden lg:table-cell">${c.ubicacion || '-'}</td>
                <td class="p-3 text-sm font-mono font-bold text-blue-700">L ${Number(c.precioFletePropio).toLocaleString('en-US')} / L ${Number(c.precioFleteCliente).toLocaleString('en-US')}</td>
        
                <!-- NEW COLUMN: UNIDAD -->
                <td class="p-3 text-center text-sm font-bold text-gray-600 uppercase">
                    ${c.unidad === 'quintal' ? 'QQ' : 'TON'}
                </td>
        
                <td class="p-3 text-center">
                    <div class="flex justify-center gap-2">
                        <button onclick="editarCliente('${c.id}')" class="text-blue-500 hover:text-blue-700 transition-colors"><span class="material-icons text-[18px]">edit</span></button>
                        <button onclick="eliminarCliente('${c.id}')" class="text-red-500 hover:text-red-700 transition-colors"><span class="material-icons text-[18px]">delete</span></button>
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
        const c = MOCK_CLIENTES.find(x => x.id == id);
        if (!c) return mostrarNotificacion("Cliente no encontrado.", "error");
        document.getElementById('modal-title').innerText = "Editar Cliente";
        document.getElementById('modal-client-id').value = c.id;
        document.getElementById('modal-nombre').value = c.nombre || '';
        document.getElementById('modal-apellido').value = c.apellido || '';
        document.getElementById('modal-telefono').value = c.telefono || '';
        document.getElementById('modal-ubicacion').value = c.ubicacion || '';
        document.getElementById('modal-precio-propio').value = formatNumberForInput(c.precioFletePropio, 0);
        document.getElementById('modal-precio-cliente').value = formatNumberForInput(c.precioFleteCliente, 0);
    } else {
        document.getElementById('modal-title').innerText = "Nuevo Cliente";
        document.getElementById('modal-client-id').value = "";
        ['nombre', 'apellido', 'telefono', 'ubicacion', 'precio-propio', 'precio-cliente'].forEach(id => {
            document.getElementById(`modal-${id}`).value = "";
        });
    }
}

function cerrarModalCliente() { document.getElementById('client-modal').classList.add('hidden'); }

function guardarCliente() {
    const id = document.getElementById('modal-client-id').value;
    const nombre = document.getElementById('modal-nombre').value.trim();
    const nuevoPPropio = parseFormattedNumber(document.getElementById('modal-precio-propio').value);
    const nuevoPCliente = parseFormattedNumber(document.getElementById('modal-precio-cliente').value);
    const unidadSeleccionada = document.getElementById('cliente-unidad').value;

    const clienteData = {
        nombre: document.getElementById('cliente-nombre').value.trim(),
        apellido: document.getElementById('cliente-apellido').value.trim(),
        telefono: document.getElementById('cliente-telefono').value.trim(),
        ubicacion: document.getElementById('cliente-ubicacion').value.trim(),
        precioFletePropio: parseFloat(document.getElementById('cliente-precio-propio').value),
        precioFleteCliente: parseFloat(document.getElementById('cliente-precio-cliente').value),
        unidad: unidadSeleccionada // Add it to the data payload!
    };

    if (!nombre || !Number.isFinite(nuevoPPropio) || !Number.isFinite(nuevoPCliente)) {
        return mostrarNotificacion("Complete los campos obligatorios con valores válidos.", "error");
    }

    if (id) {
        const index = MOCK_CLIENTES.findIndex(x => x.id == id);
        if (index < 0) return mostrarNotificacion("Cliente no encontrado.", "error");
        const oldC = MOCK_CLIENTES[index];

        if (oldC.precioFletePropio !== nuevoPPropio || oldC.precioFleteCliente !== nuevoPCliente) {
            console.log(`[AUDITORIA] Precio modificado para ${oldC.nombre}.`);
        }

        MOCK_CLIENTES[index] = {
            ...oldC,
            nombre,
            apellido: document.getElementById('modal-apellido').value.trim(),
            telefono: document.getElementById('modal-telefono').value,
            ubicacion: document.getElementById('modal-ubicacion').value,
            precioFletePropio: nuevoPPropio,
            precioFleteCliente: nuevoPCliente
        };
    } else {
        MOCK_CLIENTES.push({
            id: Date.now(),
            nombre,
            apellido: document.getElementById('modal-apellido').value.trim(),
            telefono: document.getElementById('modal-telefono').value,
            ubicacion: document.getElementById('modal-ubicacion').value,
            precioFletePropio: nuevoPPropio,
            precioFleteCliente: nuevoPCliente
        });
    }
    renderClientesTab();
    cerrarModalCliente();
    mostrarNotificacion("Cliente guardado exitosamente.");
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

function aplicarAjusteGlobalForm() {
    const accion = document.getElementById('ajuste-accion').value;
    const montoRaw = document.getElementById('ajuste-monto').value;
    const razon = document.getElementById('ajuste-razon').value;

    if (!montoRaw || !razon) return mostrarNotificacion("Debe ingresar el monto y una justificación.", "error");

    let monto = parseFormattedNumber(montoRaw);
    if (!Number.isFinite(monto)) return mostrarNotificacion("Ingrese un monto válido.", "error");
    if (accion === 'disminuir') monto = -monto;

    MOCK_CLIENTES.forEach(c => {
        c.precioFletePropio += monto;
        c.precioFleteCliente += monto;
    });

    console.log(`[ALERTA EMAIL] Ajuste global: ${monto > 0 ? '+L' + monto : '-L' + Math.abs(monto)}. Razón: ${razon}`);
    mostrarNotificacion(`Precios actualizados exitosamente.`);
    renderClientesTab();
    cerrarAjusteGlobal();
}