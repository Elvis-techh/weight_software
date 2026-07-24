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

    if (!clienteId) {
        priceBox.classList.add('hidden');
        return;
    }

    // Identify if it is a casual client or a registered one
    const cliente = clienteId === 'casual' ? MOCK_CASUAL : MOCK_CLIENTES.find(c => c.id == clienteId);

    if (!cliente) {
        priceBox.classList.add('hidden');
        return;
    }

    // Determine which price to show based on Flete Propio / Flete Cliente
    const precioActual = fleteTipo === 'Propio' ? cliente.precioFletePropio : cliente.precioFleteCliente;

    // Display the price
    document.getElementById('precio-ton').innerText = Number(precioActual || 0).toLocaleString('en-US');

    // Display the correct unit for ALL clients (registered and casual)
    const unidadSpan = document.getElementById('precio-unidad');
    if (unidadSpan) {
        unidadSpan.innerText = (cliente.unidad === 'quintal') ? 'Quintal' : 'Ton';
    }

    // IMPORTANT: Save this globally so calcularNetoYTotal() knows which math to do!
    window.currentClienteUnidad = cliente.unidad || 'tonelada';

    priceBox.classList.remove('hidden');

    // If a truck already has weights, recalculate the total immediately
    if (activeTransaction.pesoBruto && activeTransaction.pesoTara) {
        calcularNetoYTotal();
    }
}
function manualWeight(tipo) { abrirActionModal(`manual_${tipo}`); }

async function handleBrutoClick(manualWeight = null) {
    // 1. Prevent HTML event objects from messing up the math
    if (typeof manualWeight === 'object') manualWeight = null;

    // 2. Grab manual input, OR grab live weight. If both fail, default to 0.
    const weight = (manualWeight !== null && manualWeight !== undefined)
        ? Number(manualWeight)
        : Number(window.currentLiveWeight || 0);

    if (!weight || weight <= 0 || isNaN(weight)) {
        return mostrarNotificacion("El peso es 0. Si está probando sin báscula, use 'Ingreso Manual'.", "error");
    }

    // --- THE FIX: If no truck is selected, create a new one! ---
    if (!activeTransaction || !activeTransaction.id) {
        return await crearNuevaTransaccion('bruto', weight);
    }
    // -----------------------------------------------------------

    try {
        await apiRequest(`/api/camiones-patio/${activeTransaction.id}`, {
            method: 'PATCH',
            body: { pesoBruto: weight }
        });

        activeTransaction.pesoBruto = weight;
        const index = camionesEnPatio.findIndex(t => t.id === activeTransaction.id);
        if (index !== -1) camionesEnPatio[index].pesoBruto = weight;

        // INLINE FIX
        document.getElementById('bruto-display').innerText = `${weight.toLocaleString('en-US')}\u00A0LBS`;

        // DYNAMIC LABEL FIX
        const sourceElement = document.getElementById('bruto-source');
        if (sourceElement) {
            if (manualWeight !== null) {
                sourceElement.innerHTML = `<span class="material-icons text-[12px] align-middle">keyboard</span> Ingreso Manual`;
                sourceElement.classList.remove('text-green-600');
                sourceElement.classList.add('text-gray-400');
            } else {
                sourceElement.innerHTML = `<span class="material-icons text-[12px] align-middle">usb</span> COM3: LECTURA EN VIVO`;
                sourceElement.classList.remove('text-gray-400');
                sourceElement.classList.add('text-green-600');
            }
        }

        if (activeTransaction.pesoBruto > 0 && activeTransaction.pesoTara > 0) {
            calcularNetoYTotal();
        }

        renderQueue();
        mostrarNotificacion("Peso Bruto guardado exitosamente.");
        return true;
    } catch (error) {
        console.error("Error al registrar peso:", error);
        mostrarNotificacion("Error al registrar el peso.", "error");
        return false;
    }
}

async function handleTaraClick(manualWeight = null) {
    // 1. Prevent HTML event objects from messing up the math
    if (typeof manualWeight === 'object') manualWeight = null;

    // 2. Grab manual input, OR grab live weight. If both fail, default to 0.
    const weight = (manualWeight !== null && manualWeight !== undefined)
        ? Number(manualWeight)
        : Number(window.currentLiveWeight || 0);

    if (!weight || weight <= 0 || isNaN(weight)) {
        return mostrarNotificacion("El peso es 0. Si está probando sin báscula, use 'Ingreso Manual'.", "error");
    }

    // --- THE FIX: If no truck is selected, create a new one! ---
    if (!activeTransaction || !activeTransaction.id) {
        return await crearNuevaTransaccion('tara', weight);
    }
    // -----------------------------------------------------------

    try {
        await apiRequest(`/api/camiones-patio/${activeTransaction.id}`, {
            method: 'PATCH',
            body: { pesoTara: weight }
        });

        activeTransaction.pesoTara = weight;
        const index = camionesEnPatio.findIndex(t => t.id === activeTransaction.id);
        if (index !== -1) camionesEnPatio[index].pesoTara = weight;

        // INLINE FIX
        document.getElementById('tara-display').innerText = `${weight.toLocaleString('en-US')}\u00A0LBS`;

        // DYNAMIC LABEL FIX
        const sourceElement = document.getElementById('tara-source');
        if (sourceElement) {
            if (manualWeight !== null) {
                sourceElement.innerHTML = `<span class="material-icons text-[12px] align-middle">keyboard</span> Ingreso Manual`;
                sourceElement.classList.remove('text-green-600');
                sourceElement.classList.add('text-gray-400');
            } else {
                sourceElement.innerHTML = `<span class="material-icons text-[12px] align-middle">usb</span> COM3: LECTURA EN VIVO`;
                sourceElement.classList.remove('text-gray-400');
                sourceElement.classList.add('text-green-600');
            }
        }

        if (activeTransaction.pesoBruto > 0 && activeTransaction.pesoTara > 0) {
            calcularNetoYTotal();
        }

        renderQueue();
        mostrarNotificacion("Peso Tara guardado exitosamente.");
        return true;
    } catch (error) {
        console.error("Error al registrar peso:", error);
        mostrarNotificacion("Error al registrar el peso.", "error");
        return false;
    }
}

async function handleTaraClick(manualWeight = null) {
    // 1. Prevent HTML event objects from messing up the math
    if (typeof manualWeight === 'object') manualWeight = null;

    // 2. Grab manual input, OR grab live weight. If both fail, default to 0.
    const weight = (manualWeight !== null && manualWeight !== undefined)
        ? Number(manualWeight)
        : Number(window.currentLiveWeight || 0);

    if (!weight || weight <= 0 || isNaN(weight)) {
        return mostrarNotificacion("El peso es 0. Si está probando sin báscula, use 'Ingreso Manual'.", "error");
    }
    if (!activeTransaction || !activeTransaction.id) {
        return mostrarNotificacion("Seleccione un vehículo de la fila primero.", "error");
    }

    try {
        await apiRequest(`/api/camiones-patio/${activeTransaction.id}`, {
            method: 'PATCH',
            body: { pesoTara: weight }
        });

        activeTransaction.pesoTara = weight;
        const index = camionesEnPatio.findIndex(t => t.id === activeTransaction.id);
        if (index !== -1) camionesEnPatio[index].pesoTara = weight;

        // INLINE FIX: \u00A0 keeps the number and LBS glued together
        document.getElementById('tara-display').innerText = `${weight.toLocaleString('en-US')}\u00A0LBS`;

        // DYNAMIC LABEL FIX
        const sourceElement = document.getElementById('tara-source');
        if (sourceElement) {
            if (manualWeight !== null) {
                sourceElement.innerHTML = `<span class="material-icons text-[12px] align-middle">keyboard</span> Ingreso Manual`;
                sourceElement.classList.remove('text-green-600');
                sourceElement.classList.add('text-gray-400');
            } else {
                sourceElement.innerHTML = `<span class="material-icons text-[12px] align-middle">usb</span> COM3: LECTURA EN VIVO`;
                sourceElement.classList.remove('text-gray-400');
                sourceElement.classList.add('text-green-600');
            }
        }

        if (activeTransaction.pesoBruto > 0 && activeTransaction.pesoTara > 0) {
            calcularNetoYTotal();
        }

        renderQueue();
        mostrarNotificacion("Peso Tara guardado exitosamente.");
        return true;
    } catch (error) {
        console.error("Error al registrar peso:", error);
        mostrarNotificacion("Error al registrar el peso.", "error");
        return false;
    }
}

async function crearNuevaTransaccion(tipoPeso, pesoValue) {
    const clienteId = document.getElementById('cliente-select').value;
    if (!clienteId) return mostrarNotificacion("Atención: El Cliente es obligatorio para iniciar el pesaje.", "error");

    const truckData = {
        clienteId: clienteId === 'casual' ? 'casual' : parseInt(clienteId),
        casualSnapshot: clienteId === 'casual' ? { ...MOCK_CASUAL } : null,
        placa: document.getElementById('placa-input').value.toUpperCase() || "S/P",
        conductor: document.getElementById('conductor-input').value || "Desconocido",
        flete: document.getElementById('flete-select').value,
        pesoBruto: tipoPeso === 'bruto' ? pesoValue : null,
        pesoTara: tipoPeso === 'tara' ? pesoValue : null
    };

    try {
        const result = await apiRequest('/api/camiones-patio', {
            method: 'POST',
            body: truckData
        });

        const savedTruck = result.camion || result;
        camionesEnPatio.push(savedTruck);
        renderQueue();
        limpiarFormulario();
        mostrarNotificacion("Vehículo registrado en patio exitosamente.");
    } catch (error) {
        console.error("Error al guardar en patio:", error);
        mostrarNotificacion(error.message || "Fallo de conexión. El camión no se guardó.", "error");
    }
}

function renderQueue() {
    const tbody = document.getElementById('queue-list');
    if (!tbody) return;

    document.getElementById('queue-count').innerText = camionesEnPatio.length;
    if (camionesEnPatio.length === 0) {
        // Notice we changed colspan to 5 here to match the new columns!
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-gray-400 text-sm">No hay camiones en patio.</td></tr>';
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

        const pesoMostrar = t.pesoBruto != null
            ? `Bruto: ${t.pesoBruto.toLocaleString('en-US')}`
            : `Tara: ${t.pesoTara.toLocaleString('en-US')}`;

        tbody.innerHTML += `
            <tr class="hover:bg-blue-50 cursor-pointer group" onclick="cargarDeCola('${t.id}')">
                <td class="p-3 font-bold text-gray-800">${t.placa === 'S/P' ? '-' : t.placa}</td>
                <td class="p-3 font-bold text-gray-800">${t.conductor === 'Desconocido' ? '-' : t.conductor}</td>
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
        ? `${truck.pesoBruto.toLocaleString('en-US')} LBS`
        : '----- LBS';
    document.getElementById('tara-display').innerText = truck.pesoTara != null
        ? `${truck.pesoTara.toLocaleString('en-US')} LBS`
        : '----- LBS';

    btnBruto.disabled = truck.pesoBruto != null;
    btnTara.disabled = truck.pesoTara != null;
    btnBruto.classList.toggle('bg-gray-300', btnBruto.disabled);
    btnBruto.classList.toggle('bg-gray-800', !btnBruto.disabled);
    btnTara.classList.toggle('bg-gray-300', btnTara.disabled);
    btnTara.classList.toggle('bg-gray-800', !btnTara.disabled);

    document.getElementById('neto-display').innerText = '0 LBS';
    document.getElementById('total-pago-display').innerText = '0.00';
    document.getElementById('btn-guardar').disabled = true;

    if (truck.pesoBruto != null && truck.pesoTara != null) calcularNetoYTotal();
}

function calcularNetoYTotal() {
    // 1. Get weights using the CORRECT HTML IDs
    const brutoText = document.getElementById('bruto-display').innerText;
    const taraText = document.getElementById('tara-display').innerText;

    // Extract only the numbers
    const pesoBruto = parseFloat(brutoText.replace(/[^\d.-]/g, '')) || 0;
    const pesoTara = parseFloat(taraText.replace(/[^\d.-]/g, '')) || 0;

    // 2. Calculate Net Weight and ENABLE BUTTON
    let neto = 0;
    const btnGuardar = document.getElementById('btn-guardar');

    if (pesoBruto > 0 && pesoTara > 0) {
        // The absolute value math allows you to weigh empty first or loaded first!
        neto = Math.abs(pesoBruto - pesoTara);

        // UNLOCK THE FINALIZAR BUTTON!
        btnGuardar.disabled = false;
    } else {
        // KEEP IT LOCKED IF A WEIGHT IS MISSING
        btnGuardar.disabled = true;
    }

    // Update the UI
    document.getElementById('neto-display').innerText = neto.toLocaleString('en-US') + ' LBS';

    // 3. Get Price
    const precioRaw = document.getElementById('precio-ton').innerText.replace(/,/g, '');
    const precioAplicado = parseFloat(precioRaw) || 0;

    // 4. Dynamic Math based on Quintal vs Tonelada
    const unidad = window.currentClienteUnidad || 'tonelada';
    let total = 0;

    if (unidad === 'quintal') {
        total = (neto / 100) * precioAplicado;
    } else {
        total = (neto / 2204.62) * precioAplicado;
    }

    // 5. Update UI 
    document.getElementById('total-pago-display').innerText = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
        // --- THE FIX: Grab the exact price directly from the UI ---
        const precioRaw = document.getElementById('precio-ton').innerText.replace(/,/g, '');
        const precioParaServidor = parseFloat(precioRaw) || 0;

        const result = await apiRequest(
            `/api/camiones-patio/${encodeURIComponent(activeTransaction.id)}/finalizar`,
            {
                method: 'POST',
                body: {
                    fecha: getLocalIsoDate(),
                    hora: new Date().toLocaleTimeString('es-HN', { hour12: false }),
                    clienteNombre,
                    precioAplicado: precioParaServidor, // Ensures it is never null!
                    unidad: window.currentClienteUnidad || 'tonelada'
                }
            }
        );

        const savedTransaction = result.transaccion;
        transaccionesData.unshift(savedTransaction);

        // Remove from the queue
        camionesEnPatio = camionesEnPatio.filter(t => !sameRecordId(t.id, activeTransaction.id));

        renderQueue();
        updateReportesTab();
        limpiarFormulario();
        mostrarNotificacion('Transacción finalizada y guardada exitosamente.');
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

    // Reset casual name back to default
    const casualOpt = Array.from(document.getElementById('cliente-select').options).find(o => o.value === 'casual');
    if (casualOpt) casualOpt.text = '👤 Cliente Casual / Rápido';

    document.getElementById('cliente-select').value = '';
    document.getElementById('client-price-box').classList.add('hidden');
    document.getElementById('placa-input').value = '';
    document.getElementById('conductor-input').value = '';
    document.getElementById('flete-select').value = 'Propio';

    document.getElementById('bruto-display').innerText = '----- LBS';
    document.getElementById('tara-display').innerText = '----- LBS';
    document.getElementById('neto-display').innerText = '0 LBS';
    document.getElementById('total-pago-display').innerText = '0.00';

    document.getElementById('btn-bruto').disabled = false;
    document.getElementById('btn-bruto').classList.remove('bg-gray-300');
    document.getElementById('btn-bruto').classList.add('bg-gray-800');
    document.getElementById('btn-tara').disabled = false;
    document.getElementById('btn-tara').classList.remove('bg-gray-300');
    document.getElementById('btn-tara').classList.add('bg-gray-800');
    document.getElementById('btn-guardar').disabled = true;
}