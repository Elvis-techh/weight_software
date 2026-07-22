function mostrarInfoCliente() {
    const clienteId = document.getElementById('cliente-select').value;
    const fleteTipo = document.getElementById('flete-select').value;
    const priceBox = document.getElementById('client-price-box');

    if (!clienteId) { priceBox.classList.add('hidden'); return; }

    const cliente = clienteId === 'casual' ? MOCK_CASUAL : MOCK_CLIENTES.find(c => c.id == clienteId);
    const precioActual = fleteTipo === 'Propio' ? cliente.precioFletePropio : cliente.precioFleteCliente;

    document.getElementById('precio-ton').innerText = precioActual.toLocaleString('en-US');
    priceBox.classList.remove('hidden');

    if (activeTransaction.pesoBruto && activeTransaction.pesoTara) calcularNetoYTotal();
}

function manualWeight(tipo) { abrirActionModal(`manual_${tipo}`); }

function handleBrutoClick(pesoOverride = null) {
    const peso = (typeof pesoOverride === 'number') ? pesoOverride : currentLiveWeight;
    if (!activeTransaction.id) crearNuevaTransaccion('bruto', peso);
    else {
        activeTransaction.pesoBruto = peso;
        document.getElementById('bruto-display').innerText = activeTransaction.pesoBruto.toLocaleString() + " KG";
        calcularNetoYTotal();
    }
}

function handleTaraClick(pesoOverride = null) {
    const peso = (typeof pesoOverride === 'number') ? pesoOverride : currentLiveWeight;
    if (!activeTransaction.id) crearNuevaTransaccion('tara', peso);
    else {
        activeTransaction.pesoTara = peso;
        document.getElementById('tara-display').innerText = activeTransaction.pesoTara.toLocaleString() + " KG";
        calcularNetoYTotal();
    }
}

function crearNuevaTransaccion(tipoPeso, pesoValue) {
    const clienteId = document.getElementById('cliente-select').value;
    if (!clienteId) return alert("Atención: El Cliente es obligatorio para iniciar el pesaje.");

    const truckData = {
        id: Date.now().toString().slice(-6),
        clienteId: clienteId === 'casual' ? 'casual' : parseInt(clienteId),
        casualSnapshot: clienteId === 'casual' ? { ...MOCK_CASUAL } : null,
        placa: document.getElementById('placa-input').value.toUpperCase() || "S/P",
        conductor: document.getElementById('conductor-input').value || "Desconocido",
        flete: document.getElementById('flete-select').value,
        pesoBruto: tipoPeso === 'bruto' ? pesoValue : null,
        pesoTara: tipoPeso === 'tara' ? pesoValue : null
    };
    camionesEnPatio.push(truckData);
    renderQueue();
    limpiarFormulario();
}

function renderQueue() {
    const tbody = document.getElementById('queue-list');
    document.getElementById('queue-count').innerText = camionesEnPatio.length;
    if (camionesEnPatio.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-gray-400 text-sm">No hay camiones en patio.</td></tr>`;
        return;
    }
    tbody.innerHTML = '';
    camionesEnPatio.forEach(t => {
        const nombreCliente = t.clienteId === 'casual' ? t.casualSnapshot.nombre : MOCK_CLIENTES.find(c => c.id === t.clienteId).nombre;
        const identificacion = t.placa !== "S/P" ? t.placa : t.conductor;
        const pesoMostrar = t.pesoBruto ? `Bruto: ${t.pesoBruto.toLocaleString()}` : `Tara: ${t.pesoTara.toLocaleString()}`;

        tbody.innerHTML += `
            <tr class="hover:bg-blue-50 cursor-pointer group" onclick="cargarDeCola('${t.id}')">
                <td class="p-3 font-bold text-gray-800">${identificacion}</td>
                <td class="p-3 text-sm text-gray-600">${nombreCliente}</td>
                <td class="p-3 text-right font-mono font-bold text-gray-500">${pesoMostrar}</td>
                <td class="p-3 text-center flex justify-center gap-1">
                    <button class="bg-blue-100 text-blue-700 px-3 py-1 rounded text-xs font-bold">CERRAR</button>
                    <button onclick="eliminarDeCola('${t.id}', event)" class="bg-red-100 hover:bg-red-500 hover:text-white text-red-700 px-2 py-1 rounded text-xs font-bold transition-colors"><span class="material-icons text-[14px]">delete</span></button>
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
    const truck = camionesEnPatio.find(t => t.id === truckId);
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

    document.getElementById('placa-input').value = truck.placa === "S/P" ? "" : truck.placa;
    document.getElementById('conductor-input').value = truck.conductor === "Desconocido" ? "" : truck.conductor;

    document.getElementById('cliente-select').disabled = true;
    document.getElementById('placa-input').disabled = true;
    document.getElementById('conductor-input').disabled = true;
    document.getElementById('flete-select').disabled = true;

    const btnBruto = document.getElementById('btn-bruto');
    const btnTara = document.getElementById('btn-tara');

    if (truck.pesoBruto) {
        document.getElementById('bruto-display').innerText = truck.pesoBruto.toLocaleString() + " KG";
        btnBruto.disabled = true; btnBruto.classList.replace('bg-gray-800', 'bg-gray-300');
        btnTara.disabled = false; btnTara.classList.replace('bg-gray-300', 'bg-gray-800');
    } else {
        document.getElementById('bruto-display').innerText = "----- KG";
    }

    if (truck.pesoTara) {
        document.getElementById('tara-display').innerText = truck.pesoTara.toLocaleString() + " KG";
        btnTara.disabled = true; btnTara.classList.replace('bg-gray-800', 'bg-gray-300');
        btnBruto.disabled = false; btnBruto.classList.replace('bg-gray-300', 'bg-gray-800');
    } else {
        document.getElementById('tara-display').innerText = "----- KG";
    }

    document.getElementById('neto-display').innerText = "0 KG";
    document.getElementById('total-pago-display').innerText = "0.00";
    document.getElementById('btn-guardar').disabled = true;
}

function calcularNetoYTotal() {
    if (activeTransaction.pesoBruto && activeTransaction.pesoTara) {
        const neto = Math.abs(activeTransaction.pesoBruto - activeTransaction.pesoTara);
        document.getElementById('neto-display').innerText = neto.toLocaleString('en-US') + " KG";

        const cliente = activeTransaction.clienteId === 'casual' ? MOCK_CASUAL : MOCK_CLIENTES.find(c => c.id == document.getElementById('cliente-select').value);
        const precioAplicado = activeTransaction.flete === 'Propio' ? cliente.precioFletePropio : cliente.precioFleteCliente;
        activeTransaction.precioAplicado = precioAplicado; 

        const totalPagar = (neto / 1000) * precioAplicado;
        document.getElementById('total-pago-display').innerText = totalPagar.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById('btn-guardar').disabled = false;
    }
}

async function guardarTransaccion() {
    const cliente = activeTransaction.clienteId === 'casual' ? activeTransaction.casualSnapshot : MOCK_CLIENTES.find(c => c.id == document.getElementById('cliente-select').value);
    const neto = Math.abs(activeTransaction.pesoBruto - activeTransaction.pesoTara);

    const logEntry = {
        id: Date.now(),
        fecha: getLocalIsoDate(),
        hora: new Date().toLocaleTimeString('es-HN', { hour12: false }),
        placa: activeTransaction.placa,
        conductor: activeTransaction.conductor,
        clienteNombre: activeTransaction.clienteId === 'casual' ? cliente.nombre : `${cliente.nombre} ${cliente.apellido}`,
        neto: neto,
        precioAplicado: activeTransaction.precioAplicado,
        total: (neto / 1000) * activeTransaction.precioAplicado
    };

    try {
        const response = await fetch(`${API_URL}/api/transacciones`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logEntry)
        });

        if (response.ok) {
            transaccionesData.unshift(logEntry);
            camionesEnPatio = camionesEnPatio.filter(t => t.id !== activeTransaction.id);
            renderQueue();
            updateReportesTab();
            limpiarFormulario();
            mostrarNotificacion("Transacción guardada en la nube exitosamente.");
        } else {
            mostrarNotificacion("Error al guardar en el servidor.", "error");
        }
    } catch (error) {
        console.error("Error de conexión:", error);
        mostrarNotificacion("Fallo de conexión. Revise la red.", "error");
    }
}

function limpiarFormulario() {
    activeTransaction = { id: null, clienteId: null, placa: "", conductor: "", flete: "Propio", pesoBruto: null, pesoTara: null, precioAplicado: 0 };

    document.getElementById('cliente-select').disabled = false;
    document.getElementById('placa-input').disabled = false;
    document.getElementById('conductor-input').disabled = false;
    document.getElementById('flete-select').disabled = false;

    document.getElementById('cliente-select').value = "";
    document.getElementById('client-price-box').classList.add('hidden');
    document.getElementById('placa-input').value = "";
    document.getElementById('conductor-input').value = "";
    document.getElementById('flete-select').value = "Propio";

    document.getElementById('bruto-display').innerText = "----- KG";
    document.getElementById('tara-display').innerText = "----- KG";
    document.getElementById('neto-display').innerText = "0 KG";
    document.getElementById('total-pago-display').innerText = "0.00";

    document.getElementById('btn-bruto').disabled = false;
    document.getElementById('btn-bruto').classList.replace('bg-gray-300', 'bg-gray-800');
    document.getElementById('btn-tara').disabled = false;
    document.getElementById('btn-tara').classList.replace('bg-gray-300', 'bg-gray-800');
    document.getElementById('btn-guardar').disabled = true;
}