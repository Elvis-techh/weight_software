function renderClientesTab() {
    const tbody = document.getElementById('clients-table-body');
    tbody.innerHTML = '';
    MOCK_CLIENTES.forEach(c => {
        tbody.innerHTML += `
            <tr class="hover:bg-gray-50">
                <td class="p-4 font-mono text-gray-500 text-sm">#${c.id}</td>
                <td class="p-4 font-bold text-gray-800">${c.nombre} ${c.apellido}</td>
                <td class="p-4 text-gray-600">${c.telefono || '-'}</td>
                <td class="p-4 text-right font-mono font-bold text-blue-800">L ${c.precioFletePropio.toLocaleString('en-US')}</td>
                <td class="p-4 text-right font-mono font-bold text-brand-800">L ${c.precioFleteCliente.toLocaleString('en-US')}</td>
                <td class="p-4 text-center">
                    <button onclick="abrirModalCliente(${c.id})" class="text-blue-600 hover:bg-blue-50 p-2 rounded-full"><span class="material-icons text-xl">edit</span></button>
                </td>
            </tr>
        `;
    });
    populateClienteDropdown();
}

function populateClienteDropdown() {
    const select = document.getElementById('cliente-select');
    const dataList = document.getElementById('corapsa-clientes-list');

    select.innerHTML = '<option value="" disabled selected>Seleccione un cliente...</option>';
    select.innerHTML += '<option value="casual" class="font-bold text-blue-600">👤 Cliente Casual / Rápido</option>';
    if (dataList) dataList.innerHTML = '';

    MOCK_CLIENTES.forEach(c => {
        const option = document.createElement('option');
        option.value = c.id;
        option.text = `${c.nombre} ${c.apellido}`;
        select.appendChild(option);

        if (dataList) {
            dataList.innerHTML += `<option value="${c.nombre} ${c.apellido}">`;
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
    const nom = document.getElementById('casual-nombre').value || "Visitante";
    const precioRaw = document.getElementById('casual-precio').value.replace(/,/g, '');
    const unidad = document.getElementById('casual-unidad').value;

    if (!precioRaw) return mostrarNotificacion("El precio es obligatorio.", "error");

    let precioFinal = parseFloat(precioRaw);
    if (unidad === 'quintal') {
        precioFinal = precioFinal * 2;
    }

    MOCK_CASUAL.nombre = nom;
    MOCK_CASUAL.precioFletePropio = precioFinal;
    MOCK_CASUAL.precioFleteCliente = precioFinal;

    document.getElementById('casual-modal').classList.add('hidden');
    mostrarInfoCliente();
    mostrarNotificacion("Cliente casual configurado.");
}

function abrirModalCliente(id = null) {
    document.getElementById('client-modal').classList.remove('hidden');
    if (id) {
        const c = MOCK_CLIENTES.find(x => x.id === id);
        document.getElementById('modal-title').innerText = "Editar Cliente";
        document.getElementById('modal-client-id').value = c.id;
        document.getElementById('modal-nombre').value = c.nombre;
        document.getElementById('modal-apellido').value = c.apellido;
        document.getElementById('modal-telefono').value = c.telefono;
        document.getElementById('modal-ubicacion').value = c.ubicacion;
        document.getElementById('modal-precio-propio').value = c.precioFletePropio.toLocaleString('en-US');
        document.getElementById('modal-precio-cliente').value = c.precioFleteCliente.toLocaleString('en-US');
    } else {
        document.getElementById('modal-title').innerText = "Nuevo Cliente";
        document.getElementById('modal-client-id').value = "";
        ['nombre', 'apellido', 'telefono', 'ubicacion', 'precio-propio', 'precio-cliente'].forEach(id => document.getElementById(`modal-${id}`).value = "");
    }
}

function cerrarModalCliente() { document.getElementById('client-modal').classList.add('hidden'); }

function guardarCliente() {
    const id = document.getElementById('modal-client-id').value;
    const pPropioRaw = document.getElementById('modal-precio-propio').value.replace(/,/g, '');
    const pClienteRaw = document.getElementById('modal-precio-cliente').value.replace(/,/g, '');
    const nuevoPPropio = parseFloat(pPropioRaw);
    const nuevoPCliente = parseFloat(pClienteRaw);

    if (id) {
        const index = MOCK_CLIENTES.findIndex(x => x.id === parseInt(id));
        const oldC = MOCK_CLIENTES[index];

        if (oldC.precioFletePropio !== nuevoPPropio || oldC.precioFleteCliente !== nuevoPCliente) {
            console.log(`[AUDITORIA] Precio modificado para ${oldC.nombre}.`);
        }

        MOCK_CLIENTES[index] = { ...oldC, nombre: document.getElementById('modal-nombre').value, apellido: document.getElementById('modal-apellido').value, telefono: document.getElementById('modal-telefono').value, ubicacion: document.getElementById('modal-ubicacion').value, precioFletePropio: nuevoPPropio, precioFleteCliente: nuevoPCliente };
    } else {
        MOCK_CLIENTES.push({ id: Date.now(), nombre: document.getElementById('modal-nombre').value, apellido: document.getElementById('modal-apellido').value, telefono: document.getElementById('modal-telefono').value, ubicacion: document.getElementById('modal-ubicacion').value, precioFletePropio: nuevoPPropio, precioFleteCliente: nuevoPCliente });
    }
    renderClientesTab();
    cerrarModalCliente();
    mostrarNotificacion("Cliente guardado exitosamente.");
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

    let monto = parseFloat(montoRaw);
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