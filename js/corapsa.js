function abrirCorapsaModal(id = null) {
    document.getElementById('corapsa-modal').classList.remove('hidden');

    if (id) {
        const trans = corapsaData.find(t => t.id == id);
        document.getElementById('corapsa-modal-title').innerText = "Editar Recibo Externo";
        document.getElementById('corapsa-edit-id').value = trans.id;
        document.getElementById('corapsa-fecha').value = trans.fecha;
        document.getElementById('corapsa-recibo-in').value = trans.reciboIn;
        document.getElementById('corapsa-cliente').value = trans.cliente;
        document.getElementById('corapsa-toneladas').value = trans.toneladas;
        document.getElementById('corapsa-precio').value = trans.precio;
        document.getElementById('corapsa-total-display').innerText = trans.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        document.getElementById('corapsa-file').value = ""; 
    } else {
        document.getElementById('corapsa-modal-title').innerText = "Registrar Recibo Externo";
        document.getElementById('corapsa-edit-id').value = "";
        document.getElementById('corapsa-fecha').value = getLocalIsoDate(); 
        document.getElementById('corapsa-recibo-in').value = '';
        document.getElementById('corapsa-cliente').value = '';
        document.getElementById('corapsa-toneladas').value = '';
        document.getElementById('corapsa-precio').value = '';
        document.getElementById('corapsa-total-display').innerText = '0.00';
        document.getElementById('corapsa-file').value = "";
    }
}

function cerrarCorapsaModal() { document.getElementById('corapsa-modal').classList.add('hidden'); }

function handleCorapsaClientInput() {
    const inputVal = document.getElementById('corapsa-cliente').value;
    const match = MOCK_CLIENTES.find(c => `${c.nombre} ${c.apellido}` === inputVal);
    if (match) {
        document.getElementById('corapsa-precio').value = match.precioFletePropio;
        calcularTotalCorapsa();
    }
}

function calcularTotalCorapsa() {
    const tons = parseFloat(document.getElementById('corapsa-toneladas').value) || 0;
    const precio = parseFloat(document.getElementById('corapsa-precio').value) || 0;
    const total = tons * precio;
    document.getElementById('corapsa-total-display').innerText = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return total;
}

async function guardarCorapsa() {
    const id = document.getElementById('corapsa-edit-id').value;
    const fecha = document.getElementById('corapsa-fecha').value;
    const reciboIn = document.getElementById('corapsa-recibo-in').value;
    const cliente = document.getElementById('corapsa-cliente').value;
    const toneladas = parseFloat(document.getElementById('corapsa-toneladas').value);
    const precio = parseFloat(document.getElementById('corapsa-precio').value);

    const fileInput = document.getElementById('corapsa-file');
    const fileName = fileInput.files.length > 0 ? fileInput.files[0].name : null;

    if (!cliente || isNaN(toneladas) || isNaN(precio) || !fecha || !reciboIn) {
        return mostrarNotificacion("Todos los campos con * son obligatorios.", "error");
    }

    const totalCalculado = toneladas * precio;
    const payload = {
        fecha, reciboIn, cliente, toneladas, precio, total: totalCalculado,
        fileName: fileName || "Sin Archivo", pagado: false
    };

    try {
        const method = id ? 'PUT' : 'POST';
        const endpoint = id ? `${API_URL}/api/corapsa/${id}` : `${API_URL}/api/corapsa`;
        const response = await fetch(endpoint, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            if (id) {
                const trans = corapsaData.find(t => t.id == id);
                if (trans) {
                    Object.assign(trans, payload);
                    if (!fileName) trans.fileName = corapsaData.find(t => t.id == id).fileName;
                }
                mostrarNotificacion("Recibo actualizado en el servidor.");
            } else {
                const autoReciboOut = `CRX-${Date.now().toString().slice(-6)}`;
                corapsaData.unshift({ id: Date.now(), reciboOut: autoReciboOut, ...payload });
                mostrarNotificacion("Recibo externo registrado en el servidor.");
            }
            renderCorapsaTab();
            cerrarCorapsaModal();
        } else {
            mostrarNotificacion("Error al guardar el recibo en la nube.", "error");
        }
    } catch (error) {
        mostrarNotificacion("Fallo de conexión. Revise la red.", "error");
    }
}

function togglePagoCorapsa(id) {
    const trans = corapsaData.find(t => t.id == id);
    if (trans) {
        trans.pagado = !trans.pagado;
        renderCorapsaTab();
    }
}

function imprimirCorapsa(id) { mostrarNotificacion("Imprimiendo comprobante Corapsa...", "success"); }

function abrirVisorRecibo(fileName) {
    if (fileName === "Sin Archivo") return mostrarNotificacion("No hay archivo adjunto.", "error");
    document.getElementById('visor-file-name').innerText = fileName;
    document.getElementById('view-receipt-modal').classList.remove('hidden');
}

function cerrarVisorRecibo() { document.getElementById('view-receipt-modal').classList.add('hidden'); }

function renderCorapsaTab() {
    const tbody = document.getElementById('corapsa-table-body');
    const startD = document.getElementById('corapsa-filter-start').value;
    const endD = document.getElementById('corapsa-filter-end').value;
    const searchVal = document.getElementById('corapsa-filter-client').value.toLowerCase();

    const filtered = corapsaData.filter(t => {
        if (startD && t.fecha < startD) return false;
        if (endD && t.fecha > endD) return false;
        if (searchVal && !t.cliente.toLowerCase().includes(searchVal) && !(t.reciboIn || "").toLowerCase().includes(searchVal)) return false;
        return true;
    });

    let sumTons = 0;
    let sumTotal = 0;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-gray-400">Sin recibos registrados.</td></tr>`;
        document.getElementById('corapsa-total-toneladas').innerText = "0.00";
        document.getElementById('corapsa-total-dinero').innerText = "0.00";
        return;
    }

    tbody.innerHTML = '';
    filtered.forEach(t => {
        sumTons += t.toneladas;
        sumTotal += t.total;

        const displayDate = t.fecha.split('-').reverse().join('/');
        const badgeClass = t.pagado ? "bg-green-100 text-green-700 border-green-200" : "bg-red-100 text-red-700 border-red-200";
        const badgeText = t.pagado ? "PAGADO" : "NO PAGADO";

        const fileC = t.fileName && t.fileName !== "Sin Archivo" ? t.fileName : "Sin archivo";
        const fileN = t.fileNuestro && t.fileNuestro !== "Sin Archivo" ? t.fileNuestro : "Sin archivo";
        const iconC = fileC !== "Sin archivo" ? "text-blue-600" : "text-gray-300";
        const iconN = fileN !== "Sin archivo" ? "text-brand-600" : "text-gray-300";

        tbody.innerHTML += `
            <tr class="hover:bg-blue-50">
                <td class="p-3 text-sm font-mono text-gray-600">
                    <div class="font-bold text-gray-800">${displayDate}</div>
                    <div class="text-[10px] bg-yellow-100 text-yellow-800 inline-block px-1 rounded mt-1">#️⃣ ${t.reciboIn}</div>
                </td>
                <td class="p-3 font-bold text-gray-800">${t.cliente}</td>
                <td class="p-3 text-right text-xs text-gray-500">L ${t.precio.toLocaleString()}</td>
                <td class="p-3 text-right font-mono font-bold text-gray-600">${t.toneladas.toFixed(2)}</td>
                <td class="p-3 text-right font-mono font-bold text-blue-700 text-lg">L ${t.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="p-3 text-center">
                    <div class="flex flex-col gap-1 items-center">
                        <button onclick="triggerQuickUpload(${t.id}, 'cliente')" title="${fileC}" class="text-[10px] font-bold border rounded px-2 hover:bg-gray-100 flex items-center gap-1 w-24 truncate justify-center ${iconC}">
                            <span class="material-icons text-[14px]">attach_file</span> Cliente
                        </button>
                        <button onclick="triggerQuickUpload(${t.id}, 'nuestro')" title="${fileN}" class="text-[10px] font-bold border rounded px-2 hover:bg-gray-100 flex items-center gap-1 w-24 truncate justify-center ${iconN}">
                            <span class="material-icons text-[14px]">attach_file</span> Nuestro
                        </button>
                    </div>
                </td>
                <td class="p-3 text-center">
                    <button onclick="togglePagoCorapsa(${t.id})" class="${badgeClass} px-3 py-1 rounded-full text-[10px] font-bold border transition-colors hover:shadow-md cursor-pointer">${badgeText}</button>
                </td>
                <td class="p-3 text-center flex justify-center gap-1 items-center h-full mt-2">
                    <button onclick="abrirActionModal('edit_corapsa', ${t.id})" class="text-blue-500 hover:text-blue-800 transition-colors"><span class="material-icons text-[18px]">edit</span></button>
                    <button onclick="abrirActionModal('delete_corapsa', ${t.id})" class="text-red-400 hover:text-red-700 transition-colors"><span class="material-icons text-[18px]">delete</span></button>
                </td>
            </tr>
        `;
    });

    document.getElementById('corapsa-total-toneladas').innerText = sumTons.toFixed(2);
    document.getElementById('corapsa-total-dinero').innerText = sumTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function triggerQuickUpload(id, type) {
    activeUploadId = id;
    if (type === 'cliente') document.getElementById('hidden-file-cliente').click();
    else document.getElementById('hidden-file-nuestro').click();
}

function processQuickUpload(event, type) {
    if (!activeUploadId || event.target.files.length === 0) return;
    const trans = corapsaData.find(t => t.id === activeUploadId);
    if (trans) {
        if (type === 'cliente') trans.fileName = event.target.files[0].name;
        if (type === 'nuestro') trans.fileNuestro = event.target.files[0].name;
        mostrarNotificacion(`Archivo ${type} adjuntado.`);
        renderCorapsaTab();
    }
    event.target.value = ''; 
}