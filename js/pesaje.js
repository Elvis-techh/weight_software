let weightRequestInProgress = false;

function sameRecordId(left, right) {
    return String(left) === String(right);
}

function normalizarCamionPatio(record) {
    let casualSnapshot = record.casualSnapshot ?? null;

    if (typeof casualSnapshot === 'string') {
        try { casualSnapshot = JSON.parse(casualSnapshot); }
        catch (_) { casualSnapshot = null; }
    }

    return {
        ...record,
        id: record.id,
        clienteId: record.clienteId === 'casual' ? 'casual' : Number(record.clienteId),
        casualSnapshot,
        pesoBruto: record.pesoBruto == null ? null : Number(record.pesoBruto),
        pesoTara: record.pesoTara == null ? null : Number(record.pesoTara),
        precioAplicado: record.precioAplicado == null ? 0 : Number(record.precioAplicado)
    };
}

function mostrarInfoCliente() {
    const clienteId = document.getElementById('cliente-select').value;
    const fleteTipo = document.getElementById('flete-select').value;
    const priceBox = document.getElementById('client-price-box');

    if (!clienteId) { priceBox.classList.add('hidden'); return; }

    const cliente = clienteId === 'casual' ? MOCK_CASUAL : MOCK_CLIENTES.find(c => c.id == clienteId);
    if (!cliente) {
        priceBox.classList.add('hidden');
        return;
    }

    const precioActual = fleteTipo === 'Propio' ? cliente.precioFletePropio : cliente.precioFleteCliente;
    document.getElementById('precio-ton').innerText = Number(precioActual || 0).toLocaleString('en-US');
    priceBox.classList.remove('hidden');

    if (activeTransaction.pesoBruto && activeTransaction.pesoTara) calcularNetoYTotal();
}

function manualWeight(tipo) { abrirActionModal(`manual_${tipo}`); }

async function handleBrutoClick(pesoOverride = null) {
    const peso = typeof pesoOverride === 'number' ? pesoOverride : currentLiveWeight;
    if (!activeTransaction.id) return crearNuevaTransaccion('bruto', peso);
    return guardarSegundoPeso('bruto', peso);
}

async function handleTaraClick(pesoOverride = null) {
    const peso = typeof pesoOverride === 'number' ? pesoOverride : currentLiveWeight;
    if (!activeTransaction.id) return crearNuevaTransaccion('tara', peso);
    return guardarSegundoPeso('tara', peso);
}

async function crearNuevaTransaccion(tipoPeso, pesoValue) {
    if (weightRequestInProgress) return false;

    const clienteId = document.getElementById('cliente-select').value;
    if (!clienteId) {
        mostrarNotificacion('El cliente es obligatorio para iniciar el pesaje.', 'error');
        return false;
    }

    if (!Number.isFinite(pesoValue) || pesoValue <= 0) {
        mostrarNotificacion('El peso debe ser mayor que cero.', 'error');
        return false;
    }

    const payload = {
        clienteId: clienteId === 'casual' ? 'casual' : Number(clienteId),
        casualSnapshot: clienteId === 'casual' ? { ...MOCK_CASUAL } : null,
        placa: document.getElementById('placa-input').value.toUpperCase() || 'S/P',
        conductor: document.getElementById('conductor-input').value || 'Desconocido',
        flete: document.getElementById('flete-select').value,
        pesoBruto: tipoPeso === 'bruto' ? pesoValue : null,
        pesoTara: tipoPeso === 'tara' ? pesoValue : null
    };

    weightRequestInProgress = true;
    try {
        const savedRecord = normalizarCamionPatio(await apiRequest('/api/camiones-patio', {
            method: 'POST',
            body: payload
        }));

        camionesEnPatio.push(savedRecord);
        renderQueue();
        limpiarFormulario();
        mostrarNotificacion('Pesaje inicial guardado en la cola del servidor.');
        return true;
    } catch (error) {
        console.error('No se pudo guardar el pesaje inicial:', error);
        mostrarNotificacion(error.message, 'error');
        return false;
    } finally {
        weightRequestInProgress = false;
    }
}

async function guardarSegundoPeso(tipoPeso, pesoValue) {
    if (weightRequestInProgress) return false;
    if (!activeTransaction.id) return false;

    if (!Number.isFinite(pesoValue) || pesoValue <= 0) {
        mostrarNotificacion('El peso debe ser mayor que cero.', 'error');
        return false;
    }

    const field = tipoPeso === 'bruto' ? 'pesoBruto' : 'pesoTara';
    if (activeTransaction[field] != null) {
        mostrarNotificacion('Ese peso ya fue registrado.', 'error');
        return false;
    }

    weightRequestInProgress = true;
    try {
        const updatedRecord = normalizarCamionPatio(await apiRequest(
            `/api/camiones-patio/${encodeURIComponent(activeTransaction.id)}`,
            {
                method: 'PATCH',
                body: { [field]: pesoValue }
            }
        ));

        activeTransaction = { ...activeTransaction, ...updatedRecord };
        const queueIndex = camionesEnPatio.findIndex(t => sameRecordId(t.id, updatedRecord.id));
        if (queueIndex >= 0) camionesEnPatio[queueIndex] = updatedRecord;

        document.getElementById('bruto-display').innerText = activeTransaction.pesoBruto != null
            ? `${activeTransaction.pesoBruto.toLocaleString('en-US')} KG`
            : '----- KG';
        document.getElementById('tara-display').innerText = activeTransaction.pesoTara != null
            ? `${activeTransaction.pesoTara.toLocaleString('en-US')} KG`
            : '----- KG';

        calcularNetoYTotal();
        renderQueue();
        mostrarNotificacion('Segundo peso guardado en el servidor.');
        return true;
    } catch (error) {
        console.error('No se pudo guardar el segundo peso:', error);
        mostrarNotificacion(error.message, 'error');
        return false;
    } finally {
        weightRequestInProgress = false;
    }
}

function renderQueue() {
    const tbody = document.getElementById('queue-list');
    if (!tbody) return;

    document.getElementById('queue-count').innerText = camionesEnPatio.length;
    if (camionesEnPatio.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-gray-400 text-sm">No hay camiones en patio.</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    camionesEnPatio.forEach(t => {
        const clientRecord = t.clienteId === 'casual'
            ? t.casualSnapshot
            : MOCK_CLIENTES.find(c => c.id == t.clienteId);
        const nombreCliente = t.clienteId === 'casual'
            ? (t.casualSnapshot?.nombre || 'Casual')
            : (clientRecord ? `${clientRecord.nombre} ${clientRecord.apellido || ''}`.trim() : 'Cliente no disponible');
        const identificacion = t.placa !== 'S/P' ? t.placa : t.conductor;
        const pesoMostrar = t.pesoBruto != null
            ? `Bruto: ${t.pesoBruto.toLocaleString('en-US')}`
            : `Tara: ${t.pesoTara.toLocaleString('en-US')}`;

        tbody.innerHTML += `
            <tr class="hover:bg-blue-50 cursor-pointer group" onclick="cargarDeCola('${t.id}')">
                <td class="p-3 font-bold text-gray-800">${identificacion}</td>
                <td class="p-3 text-sm text-gray-600">${nombreCliente}</td>
                <td class="p-3 text-right font-mono font-bold text-gray-500">${pesoMostrar}</td>
                <td class="p-3 text-center">
                    <div class="flex justify-center gap-1">
                        <button class="bg-blue-100 text-blue-700 px-3 py-1 rounded text-xs font-bold">CERRAR</button>
                        <button onclick="eliminarDeCola('${t.id}', event)" class="bg-red-100 hover:bg-red-500 hover:text-white text-red-700 px-2 py-1 rounded text-xs font-bold transition-colors"><span class="material-icons text-[14px]">delete</span></button>
                    </div>
                </td>
            </tr>
        `;
    });
}

function eliminarDeCola(id, event) {
    event.stopPropagation();
    abrirActionModal('delete_cola', id);
}

function cargarDeCola(truckId) {
    const truck = camionesEnPatio.find(t => sameRecordId(t.id, truckId));
    if (!truck) return;

    document.getElementById('cliente-select').disabled = false;
    document.getElementById('placa-input').disabled = false;
    document.getElementById('conductor-input').disabled = false;
    document.getElementById('flete-select').disabled = false;

    activeTransaction = { ...truck };

    if (truck.clienteId === 'casual') {
        MOCK_CASUAL = truck.casualSnapshot;
        document.getElementById('cliente-select').value = 'casual';
    } else {
        document.getElementById('cliente-select').value = truck.clienteId;
    }

    document.getElementById('flete-select').value = truck.flete;
    mostrarInfoCliente();

    document.getElementById('placa-input').value = truck.placa === 'S/P' ? '' : truck.placa;
    document.getElementById('conductor-input').value = truck.conductor === 'Desconocido' ? '' : truck.conductor;

    document.getElementById('cliente-select').disabled = true;
    document.getElementById('placa-input').disabled = true;
    document.getElementById('conductor-input').disabled = true;
    document.getElementById('flete-select').disabled = true;

    const btnBruto = document.getElementById('btn-bruto');
    const btnTara = document.getElementById('btn-tara');

    document.getElementById('bruto-display').innerText = truck.pesoBruto != null
        ? `${truck.pesoBruto.toLocaleString('en-US')} KG`
        : '----- KG';
    document.getElementById('tara-display').innerText = truck.pesoTara != null
        ? `${truck.pesoTara.toLocaleString('en-US')} KG`
        : '----- KG';

    btnBruto.disabled = truck.pesoBruto != null;
    btnTara.disabled = truck.pesoTara != null;
    btnBruto.classList.toggle('bg-gray-300', btnBruto.disabled);
    btnBruto.classList.toggle('bg-gray-800', !btnBruto.disabled);
    btnTara.classList.toggle('bg-gray-300', btnTara.disabled);
    btnTara.classList.toggle('bg-gray-800', !btnTara.disabled);

    document.getElementById('neto-display').innerText = '0 KG';
    document.getElementById('total-pago-display').innerText = '0.00';
    document.getElementById('btn-guardar').disabled = true;

    if (truck.pesoBruto != null && truck.pesoTara != null) calcularNetoYTotal();
}

function calcularNetoYTotal() {
    if (activeTransaction.pesoBruto == null || activeTransaction.pesoTara == null) return;

    const neto = Math.abs(activeTransaction.pesoBruto - activeTransaction.pesoTara);
    document.getElementById('neto-display').innerText = `${neto.toLocaleString('en-US')} KG`;

    const cliente = activeTransaction.clienteId === 'casual'
        ? (activeTransaction.casualSnapshot || MOCK_CASUAL)
        : MOCK_CLIENTES.find(c => c.id == activeTransaction.clienteId);
    if (!cliente) return mostrarNotificacion('El cliente de esta transacción ya no existe.', 'error');

    const precioAplicado = activeTransaction.flete === 'Propio'
        ? Number(cliente.precioFletePropio)
        : Number(cliente.precioFleteCliente);
    activeTransaction.precioAplicado = precioAplicado;

    const totalPagar = (neto / 1000) * precioAplicado;
    document.getElementById('total-pago-display').innerText = totalPagar.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    document.getElementById('btn-guardar').disabled = false;
}

async function guardarTransaccion() {
    if (!activeTransaction.id || activeTransaction.pesoBruto == null || activeTransaction.pesoTara == null) {
        return mostrarNotificacion('La transacción todavía no tiene ambos pesos.', 'error');
    }

    const cliente = activeTransaction.clienteId === 'casual'
        ? activeTransaction.casualSnapshot
        : MOCK_CLIENTES.find(c => c.id == activeTransaction.clienteId);
    if (!cliente) return mostrarNotificacion('No se encontró el cliente de la transacción.', 'error');

    const clienteNombre = activeTransaction.clienteId === 'casual'
        ? cliente.nombre
        : `${cliente.nombre} ${cliente.apellido || ''}`.trim();

    try {
        const result = await apiRequest(
            `/api/camiones-patio/${encodeURIComponent(activeTransaction.id)}/finalizar`,
            {
                method: 'POST',
                body: {
                    fecha: getLocalIsoDate(),
                    hora: new Date().toLocaleTimeString('es-HN', { hour12: false }),
                    clienteNombre,
                    precioAplicado: activeTransaction.precioAplicado
                }
            }
        );

        const savedTransaction = result.transaccion;
        transaccionesData.unshift(savedTransaction);
        camionesEnPatio = camionesEnPatio.filter(t => !sameRecordId(t.id, activeTransaction.id));
        renderQueue();
        updateReportesTab();
        limpiarFormulario();
        mostrarNotificacion('Transacción finalizada y guardada en la nube.');
    } catch (error) {
        console.error('No se pudo finalizar la transacción:', error);
        mostrarNotificacion(error.message, 'error');
    }
}

function limpiarFormulario() {
    activeTransaction = { id: null, clienteId: null, placa: '', conductor: '', flete: 'Propio', pesoBruto: null, pesoTara: null, precioAplicado: 0 };

    document.getElementById('cliente-select').disabled = false;
    document.getElementById('placa-input').disabled = false;
    document.getElementById('conductor-input').disabled = false;
    document.getElementById('flete-select').disabled = false;

    document.getElementById('cliente-select').value = '';
    document.getElementById('client-price-box').classList.add('hidden');
    document.getElementById('placa-input').value = '';
    document.getElementById('conductor-input').value = '';
    document.getElementById('flete-select').value = 'Propio';

    document.getElementById('bruto-display').innerText = '----- KG';
    document.getElementById('tara-display').innerText = '----- KG';
    document.getElementById('neto-display').innerText = '0 KG';
    document.getElementById('total-pago-display').innerText = '0.00';

    document.getElementById('btn-bruto').disabled = false;
    document.getElementById('btn-bruto').classList.remove('bg-gray-300');
    document.getElementById('btn-bruto').classList.add('bg-gray-800');
    document.getElementById('btn-tara').disabled = false;
    document.getElementById('btn-tara').classList.remove('bg-gray-300');
    document.getElementById('btn-tara').classList.add('bg-gray-800');
    document.getElementById('btn-guardar').disabled = true;
}