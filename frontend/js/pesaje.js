let weightRequestInProgress = false;

function normalizarCamionPatio(record = {}) {
    let casualSnapshot = record.casualSnapshot ?? record.casual_snapshot ?? null;

    if (typeof casualSnapshot === 'string') {
        try {
            casualSnapshot = JSON.parse(casualSnapshot);
        } catch (_) {
            casualSnapshot = null;
        }
    }

    if (casualSnapshot) casualSnapshot = normalizarCliente(casualSnapshot);

    const rawPesoBruto = record.pesoBruto ?? record.peso_bruto;
    const rawPesoTara = record.pesoTara ?? record.peso_tara;

    const normalizedId = String(record.id ?? '').trim();

    return {
        id: normalizedId || null,
        clienteId: String(record.clienteId ?? record.cliente_id) === 'casual'
            ? 'casual'
            : Number(record.clienteId ?? record.cliente_id),
        clienteNombreSnapshot: String(
            record.clienteNombreSnapshot ?? record.cliente_nombre_snapshot ?? ''
        ),
        placa: String(record.placa || 'S/P'),
        conductor: String(record.conductor || 'Desconocido'),
        flete: record.flete === 'Cliente' ? 'Cliente' : 'Propio',
        pesoBruto: rawPesoBruto == null ? null : toFiniteNumber(rawPesoBruto),
        pesoTara: rawPesoTara == null ? null : toFiniteNumber(rawPesoTara),
        precioAplicado: toFiniteNumber(record.precioAplicado ?? record.precio_aplicado),
        unidad: record.unidad === 'quintal' ? 'quintal' : 'tonelada',
        casualSnapshot
    };
}

function getSelectedClientSnapshot() {
    const clienteId = document.getElementById('cliente-select')?.value;
    const flete = document.getElementById('flete-select')?.value === 'Cliente' ? 'Cliente' : 'Propio';
    if (!clienteId) return null;

    const cliente = clienteId === 'casual'
        ? MOCK_CASUAL
        : MOCK_CLIENTES.find(item => sameRecordId(item.id, clienteId));

    if (!cliente) return null;

    const precioAplicado = flete === 'Propio'
        ? cliente.precioFletePropio
        : cliente.precioFleteCliente;

    return {
        clienteId: clienteId === 'casual' ? 'casual' : Number(clienteId),
        clienteNombreSnapshot: clienteId === 'casual'
            ? cliente.nombre
            : `${cliente.nombre} ${cliente.apellido || ''}`.trim(),
        casualSnapshot: clienteId === 'casual' ? { ...cliente } : null,
        precioAplicado: toFiniteNumber(precioAplicado),
        unidad: cliente.unidad === 'quintal' ? 'quintal' : 'tonelada',
        flete
    };
}

function mostrarInfoCliente() {
    const priceBox = document.getElementById('client-price-box');
    if (!priceBox) return;

    const snapshot = activeTransaction.id
        ? {
            precioAplicado: activeTransaction.precioAplicado,
            unidad: activeTransaction.unidad
        }
        : getSelectedClientSnapshot();

    if (!snapshot) {
        priceBox.classList.add('hidden');
        return;
    }

    document.getElementById('precio-ton').textContent = formatNumberForInput(snapshot.precioAplicado, 2);
    document.getElementById('precio-unidad').textContent = snapshot.unidad === 'quintal' ? 'Quintal' : 'Ton';
    priceBox.classList.remove('hidden');

    if (activeTransaction.pesoBruto != null && activeTransaction.pesoTara != null) {
        calcularNetoYTotal();
    }
}

function manualWeight(tipo) {
    const normalizedType = tipo === 'tara' ? 'tara' : 'bruto';

    // Once a truck is loaded from the queue and its gross weight exists,
    // only the tare may be replaced before finalization.
    if (
        normalizedType === 'bruto' &&
        activeTransaction.id &&
        activeTransaction.pesoBruto != null
    ) {
        mostrarNotificacion(
            'El peso bruto ya está registrado y queda bloqueado. Solo puede actualizar la tara antes de finalizar.',
            'error'
        );
        return;
    }

    abrirActionModal(`manual_${normalizedType}`);
}

function getRequestedWeight(manualWeight) {
    if (manualWeight !== null && manualWeight !== undefined && typeof manualWeight !== 'object') {
        const weight = Number(manualWeight);
        return { weight, isManual: true, stable: true, fresh: true };
    }

    const reading = getLiveScaleReading();
    return {
        weight: Number(reading.weight),
        isManual: false,
        stable: reading.stable,
        fresh: reading.isFresh
    };
}

function setWeightButtonsBusy(busy) {
    ['btn-bruto', 'btn-tara', 'btn-guardar'].forEach(id => {
        const button = document.getElementById(id);
        if (button) button.dataset.busy = busy ? 'true' : 'false';
    });
}

function updateWeightDisplay(type, weight) {
    const display = document.getElementById(type === 'bruto' ? 'bruto-display' : 'tara-display');
    if (display) display.textContent = `${toFiniteNumber(weight).toLocaleString('en-US')}\u00A0LBS`;
}

async function saveWeight(type, manualWeight = null) {
    if (weightRequestInProgress) {
        mostrarNotificacion('Ya hay una operación de peso en curso.', 'error');
        return false;
    }

    // Protect the original gross weight of an open yard transaction.
    // Tare remains intentionally editable until the transaction is finalized.
    if (
        type === 'bruto' &&
        activeTransaction.id &&
        activeTransaction.pesoBruto != null
    ) {
        mostrarNotificacion(
            'El peso bruto ya está registrado y no puede modificarse. Actualice la tara o finalice la transacción.',
            'error'
        );
        return false;
    }

    const reading = getRequestedWeight(manualWeight);
    if (!Number.isFinite(reading.weight) || reading.weight <= 0) {
        mostrarNotificacion("El peso es 0. Use 'Ingreso Manual' si está probando sin báscula.", 'error');
        return false;
    }
    if (!reading.isManual && !reading.fresh) {
        mostrarNotificacion('La lectura de la báscula está desactualizada.', 'error');
        return false;
    }
    if (!reading.isManual && !reading.stable) {
        mostrarNotificacion('Espere a que la báscula indique PESO ESTABLE.', 'error');
        return false;
    }

    weightRequestInProgress = true;
    setWeightButtonsBusy(true);

    try {
        if (!activeTransaction.id) {
            return await crearNuevaTransaccion(type, reading.weight);
        }

        const wasReplacingTara = type === 'tara' && activeTransaction.pesoTara != null;
        const body = type === 'bruto'
            ? { pesoBruto: reading.weight }
            : { pesoTara: reading.weight };

        const result = await apiRequest(
            `/api/camiones-patio/${encodeURIComponent(activeTransaction.id)}`,
            { method: 'PATCH', body }
        );

        activeTransaction = normalizarCamionPatio(result?.camion || result);
        const index = camionesEnPatio.findIndex(item => sameRecordId(item.id, activeTransaction.id));
        if (index >= 0) camionesEnPatio[index] = { ...activeTransaction };

        updateWeightDisplay(type, reading.weight);
        renderQueue();
        calcularNetoYTotal();
        actualizarEstadoBotonesPeso();
        mostrarNotificacion(
            wasReplacingTara
                ? 'Peso tara actualizado exitosamente.'
                : `Peso ${type === 'bruto' ? 'bruto' : 'tara'} guardado exitosamente.`
        );
        return true;
    } catch (error) {
        console.error('Error al registrar peso:', error);
        mostrarNotificacion(error.message || 'Error al registrar el peso.', 'error');
        return false;
    } finally {
        weightRequestInProgress = false;
        setWeightButtonsBusy(false);
    }
}

function handleBrutoClick(manualWeight = null) {
    return saveWeight('bruto', manualWeight);
}

function handleTaraClick(manualWeight = null) {
    return saveWeight('tara', manualWeight);
}

async function crearNuevaTransaccion(tipoPeso, pesoValue) {
    const snapshot = getSelectedClientSnapshot();
    if (!snapshot) {
        mostrarNotificacion('El cliente es obligatorio para iniciar el pesaje.', 'error');
        return false;
    }

    const truckData = {
        ...snapshot,
        placa: document.getElementById('placa-input').value.trim().toUpperCase() || 'S/P',
        conductor: document.getElementById('conductor-input').value.trim() || 'Desconocido',
        pesoBruto: tipoPeso === 'bruto' ? pesoValue : null,
        pesoTara: tipoPeso === 'tara' ? pesoValue : null
    };

    try {
        const result = await apiRequest('/api/camiones-patio', {
            method: 'POST',
            body: truckData
        });

        const savedTruck = normalizarCamionPatio(result?.camion || result);
        camionesEnPatio.push(savedTruck);
        renderQueue();
        limpiarFormulario();
        mostrarNotificacion('Vehículo registrado en patio exitosamente.');
        return true;
    } catch (error) {
        console.error('Error al guardar en patio:', error);
        mostrarNotificacion(error.message || 'El camión no se guardó.', 'error');
        return false;
    }
}

function getQueueWeightLabel(truck) {
    if (truck.pesoBruto != null && truck.pesoTara != null) {
        return `Completo: ${Math.abs(truck.pesoBruto - truck.pesoTara).toLocaleString('en-US')} LBS netas`;
    }
    if (truck.pesoBruto != null) return `Bruto: ${truck.pesoBruto.toLocaleString('en-US')} LBS`;
    if (truck.pesoTara != null) return `Tara: ${truck.pesoTara.toLocaleString('en-US')} LBS`;
    return 'Sin peso registrado';
}

function renderQueue() {
    const tbody = document.getElementById('queue-list');
    const count = document.getElementById('queue-count');
    if (!tbody) return;
    if (count) count.textContent = String(camionesEnPatio.length);

    if (camionesEnPatio.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-gray-400 text-sm">No hay camiones en patio.</td></tr>';
        return;
    }

    tbody.innerHTML = camionesEnPatio.map(truck => {
        const queueId = String(truck.id ?? '').trim();
        const hasValidId = queueId.length > 0;
        const clientRecord = truck.clienteId === 'casual'
            ? truck.casualSnapshot
            : MOCK_CLIENTES.find(cliente => sameRecordId(cliente.id, truck.clienteId));
        const nombreCliente = truck.clienteNombreSnapshot || (
            truck.clienteId === 'casual'
                ? truck.casualSnapshot?.nombre || 'Casual'
                : clientRecord
                    ? `${clientRecord.nombre} ${clientRecord.apellido || ''}`.trim()
                    : 'Cliente no disponible'
        );

        const rowAction = hasValidId ? `onclick="cargarDeCola('${escapeHtml(queueId)}')"` : '';
        const invalidIdLabel = hasValidId
            ? ''
            : '<div class="text-[10px] font-bold text-red-600 mt-1">ID pendiente de reparación</div>';
        const deleteButton = hasValidId
            ? `<button type="button" onclick="eliminarDeCola('${escapeHtml(queueId)}', event)" class="bg-red-100 hover:bg-red-500 hover:text-white text-red-700 px-2 py-1 rounded text-xs font-bold transition-colors" aria-label="Eliminar de la cola">
                    <span class="material-icons text-[14px]">delete</span>
               </button>`
            : `<button type="button" disabled class="bg-gray-100 text-gray-400 px-2 py-1 rounded text-xs font-bold cursor-not-allowed" title="Reinicie el servidor para reparar este registro">
                    <span class="material-icons text-[14px]">delete</span>
               </button>`;

        return `
            <tr class="hover:bg-blue-50 ${hasValidId ? 'cursor-pointer' : 'cursor-not-allowed'} group" ${rowAction}>
                <td class="p-3 font-bold text-gray-800">${escapeHtml(truck.placa === 'S/P' ? '-' : truck.placa)}</td>
                <td class="p-3 font-bold text-gray-800">${escapeHtml(truck.conductor === 'Desconocido' ? '-' : truck.conductor)}</td>
                <td class="p-3 text-sm text-gray-600">${escapeHtml(nombreCliente)}${invalidIdLabel}</td>
                <td class="p-3 text-right font-mono font-bold text-gray-500">${escapeHtml(getQueueWeightLabel(truck))}</td>
                <td class="p-3 text-center">
                    <div class="flex justify-center gap-1">
                        <button type="button" ${hasValidId ? '' : 'disabled'} class="${hasValidId ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'} px-3 py-1 rounded text-xs font-bold">ABRIR</button>
                        ${deleteButton}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function eliminarDeCola(id, event) {
    event?.stopPropagation?.();
    const queueId = String(id ?? '').trim();
    if (!queueId) {
        return mostrarNotificacion(
            'El vehículo no tiene un ID válido. Reinicie el servidor y recargue la aplicación.',
            'error'
        );
    }
    abrirActionModal('delete_cola', queueId);
}

function cargarDeCola(truckId) {
    const queueId = String(truckId ?? '').trim();
    if (!queueId) {
        return mostrarNotificacion(
            'El vehículo no tiene un ID válido. Reinicie el servidor y recargue la aplicación.',
            'error'
        );
    }
    const truck = camionesEnPatio.find(item => sameRecordId(item.id, queueId));
    if (!truck) return mostrarNotificacion('El vehículo ya no está en la cola.', 'error');

    activeTransaction = { ...truck };

    const clienteSelect = document.getElementById('cliente-select');
    if (truck.clienteId === 'casual') {
        MOCK_CASUAL = truck.casualSnapshot
            ? { ...createDefaultCasualClient(), ...truck.casualSnapshot }
            : { ...createDefaultCasualClient(), nombre: truck.clienteNombreSnapshot || 'Casual' };
        populateClienteDropdown();
        clienteSelect.value = 'casual';
    } else {
        clienteSelect.value = String(truck.clienteId);
    }

    document.getElementById('placa-input').value = truck.placa === 'S/P' ? '' : truck.placa;
    document.getElementById('conductor-input').value = truck.conductor === 'Desconocido' ? '' : truck.conductor;
    document.getElementById('flete-select').value = truck.flete;

    ['cliente-select', 'placa-input', 'conductor-input', 'flete-select'].forEach(id => {
        document.getElementById(id).disabled = true;
    });

    updateWeightDisplayFromTransaction();
    mostrarInfoCliente();
    calcularNetoYTotal();
    actualizarEstadoBotonesPeso();
}

function updateWeightDisplayFromTransaction() {
    document.getElementById('bruto-display').textContent = activeTransaction.pesoBruto != null
        ? `${activeTransaction.pesoBruto.toLocaleString('en-US')}\u00A0LBS`
        : '----- LBS';
    document.getElementById('tara-display').textContent = activeTransaction.pesoTara != null
        ? `${activeTransaction.pesoTara.toLocaleString('en-US')}\u00A0LBS`
        : '----- LBS';
}

function actualizarEstadoBotonesPeso() {
    const brutoButton = document.getElementById('btn-bruto');
    const taraButton = document.getElementById('btn-tara');
    const manualBrutoButton = document.getElementById('manual-bruto-button');
    const manualTaraButton = document.getElementById('manual-tara-button');
    if (!brutoButton || !taraButton) return;

    const hasOpenTransaction = Boolean(activeTransaction.id);
    const brutoIsLocked = hasOpenTransaction && activeTransaction.pesoBruto != null;
    const taraAlreadyExists = hasOpenTransaction && activeTransaction.pesoTara != null;

    // Fail closed: if the scale is disconnected or its last reading is stale, a live
    // read must not be possible — this is what stops a fake/absent value from ever
    // reaching a real transaction. Manual entry (below) is a separate, deliberate
    // escape hatch and is intentionally NOT gated by this.
    const liveReading = getLiveScaleReading();
    const scaleUnavailable = liveReading.source === 'disconnected' || !liveReading.isFresh;

    // Gross weight is immutable after its first capture. Tare can always be
    // read again and overwritten until FINALIZAR Y GUARDAR is pressed.
    brutoButton.disabled = brutoIsLocked || scaleUnavailable;
    taraButton.disabled = scaleUnavailable;

    if (manualBrutoButton) {
        manualBrutoButton.disabled = brutoIsLocked;
        manualBrutoButton.classList.toggle('opacity-40', brutoIsLocked);
        manualBrutoButton.classList.toggle('cursor-not-allowed', brutoIsLocked);
        manualBrutoButton.title = brutoIsLocked
            ? 'El peso bruto está bloqueado para esta transacción.'
            : 'Registrar peso bruto manualmente';
    }

    if (manualTaraButton) {
        manualTaraButton.disabled = false;
        manualTaraButton.title = taraAlreadyExists
            ? 'Reemplazar la tara registrada usando ingreso manual'
            : 'Registrar tara manualmente';
    }

    brutoButton.classList.toggle('bg-gray-300', brutoButton.disabled);
    brutoButton.classList.toggle('bg-gray-800', !brutoButton.disabled);
    brutoButton.classList.toggle('cursor-not-allowed', brutoButton.disabled);
    brutoButton.title = brutoIsLocked
        ? 'El peso bruto queda bloqueado después de registrarse.'
        : 'Leer y registrar el peso bruto actual';

    taraButton.classList.remove('bg-gray-300');
    taraButton.classList.add('bg-gray-800');
    taraButton.classList.remove('cursor-not-allowed');
    taraButton.title = taraAlreadyExists
        ? 'Leer nuevamente la báscula y reemplazar la tara actual'
        : 'Leer y registrar la tara actual';
    taraButton.innerHTML = taraAlreadyExists
        ? '<span class="material-icons text-[18px]">sync</span> ACTUALIZAR TARA'
        : '<span class="material-icons text-[18px]">upload</span> TARA';
}

function calcularNetoYTotal() {
    const pesoBruto = toFiniteNumber(activeTransaction.pesoBruto);
    const pesoTara = toFiniteNumber(activeTransaction.pesoTara);
    const hasBothWeights = activeTransaction.pesoBruto != null && activeTransaction.pesoTara != null;
    const neto = hasBothWeights ? Math.abs(pesoBruto - pesoTara) : 0;
    const total = calculatePayment(neto, activeTransaction.precioAplicado, activeTransaction.unidad);

    document.getElementById('neto-display').textContent = `${neto.toLocaleString('en-US')} LBS`;
    document.getElementById('total-pago-display').textContent = formatMoney(total);

    const saveButton = document.getElementById('btn-guardar');
    if (saveButton) saveButton.disabled = !activeTransaction.id || !hasBothWeights || neto <= 0;

    return { neto, total };
}

async function guardarTransaccion() {
    if (weightRequestInProgress) return;
    if (!activeTransaction.id || activeTransaction.pesoBruto == null || activeTransaction.pesoTara == null) {
        return mostrarNotificacion('La transacción todavía no tiene ambos pesos.', 'error');
    }

    const { neto } = calcularNetoYTotal();
    if (neto <= 0) return mostrarNotificacion('El peso neto debe ser mayor que cero.', 'error');

    weightRequestInProgress = true;
    setWeightButtonsBusy(true);

    try {
        const result = await apiRequest(
            `/api/camiones-patio/${encodeURIComponent(activeTransaction.id)}/finalizar`,
            {
                method: 'POST',
                body: {
                    fecha: getLocalIsoDate(),
                    hora: getLocalTimeString()
                }
            }
        );

        const savedTransaction = normalizarTransaccion(result?.transaccion || result);
        transaccionesData.unshift(savedTransaction);
        camionesEnPatio = camionesEnPatio.filter(item => !sameRecordId(item.id, activeTransaction.id));

        renderQueue();
        updateReportesTab();
        limpiarFormulario();
        mostrarNotificacion('Transacción finalizada y guardada exitosamente.');
    } catch (error) {
        console.error('No se pudo finalizar la transacción:', error);
        mostrarNotificacion(error.message || 'No se pudo finalizar la transacción.', 'error');
    } finally {
        weightRequestInProgress = false;
        setWeightButtonsBusy(false);
    }
}

function limpiarFormulario() {
    activeTransaction = createEmptyTransaction();

    ['cliente-select', 'placa-input', 'conductor-input', 'flete-select'].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = false;
    });

    MOCK_CASUAL = createDefaultCasualClient();
    populateClienteDropdown();

    document.getElementById('cliente-select').value = '';
    document.getElementById('placa-input').value = '';
    document.getElementById('conductor-input').value = '';
    document.getElementById('flete-select').value = 'Propio';
    document.getElementById('client-price-box').classList.add('hidden');

    document.getElementById('bruto-display').textContent = '----- LBS';
    document.getElementById('tara-display').textContent = '----- LBS';
    document.getElementById('neto-display').textContent = '0 LBS';
    document.getElementById('total-pago-display').textContent = '0.00';
    document.getElementById('btn-guardar').disabled = true;

    actualizarEstadoBotonesPeso();
}