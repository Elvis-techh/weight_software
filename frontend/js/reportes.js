// 1. Fetch transactions from the backend and save them globally
async function fetchTransacciones() {
    try {
        const transacciones = await apiRequest('/api/transacciones');

        // CRUCIAL: Save the DB data to your global array so filters and printing work!
        transaccionesData = Array.isArray(transacciones) ? transacciones : [];

        // Trigger the render function
        updateReportesTab();
    } catch (error) {
        console.error("Error al cargar reportes:", error);
        mostrarNotificacion("Error al conectar con la base de datos de reportes.", "error");
    }
}

// 2. Filter, Calculate, and Render the Table
function updateReportesTab() {
    const tbody = document.getElementById('reports-table-body'); // Matching your HTML ID
    if (!tbody) return;

    const startDate = document.getElementById('filter-start')?.value || '';
    const endDate = document.getElementById('filter-end')?.value || '';
    const customerSearch = (document.getElementById('filter-client')?.value || '').trim().toLocaleLowerCase('es');

    // Filter the global array based on the UI inputs
    const filteredData = transaccionesData.filter(t => {
        if (startDate && t.fecha < startDate) return false;
        if (endDate && t.fecha > endDate) return false;

        if (customerSearch) {
            // Use snake_case because SQLite returns 'cliente_nombre'
            const searchableCustomer = String(t.cliente_nombre || '').toLocaleLowerCase('es');
            if (!searchableCustomer.includes(customerSearch)) return false;
        }
        return true;
    });

    let totalLbs = 0;
    let totalDinero = 0;

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-gray-400">Sin transacciones para el cliente y rango de fechas seleccionados.</td></tr>`;
        document.getElementById('rep-camiones').innerText = "0";
        document.getElementById('rep-toneladas').innerText = "0.00";
        document.getElementById('rep-dinero').innerText = "L 0.00";
        return;
    }

    tbody.innerHTML = '';

    filteredData.forEach(t => {
        const pesoNeto = Number(t.neto || 0);
        const precioAplicado = Number(t.precio_aplicado || 0);
        const total = Number(t.total || 0);

        totalLbs += pesoNeto;
        totalDinero += total;

        const iden = t.placa !== "S/P" ? t.placa : (t.conductor !== "Desconocido" ? t.conductor : "S/P");
        const displayDate = t.fecha.split('-').reverse().join('/');

        tbody.innerHTML += `
            <tr class="hover:bg-gray-50 border-b border-gray-100">
                <td class="p-4 font-mono text-gray-500 text-xs">${displayDate} <br> ${t.hora}</td>
                <td class="p-4 font-bold text-gray-800 uppercase">${iden}</td>
                <td class="p-4 text-gray-600 text-sm">${t.cliente_nombre}</td>
                <td class="p-4 text-right font-mono font-bold text-gray-800">${pesoNeto.toLocaleString('en-US')} LBS</td>
                <td class="p-4 text-right font-mono text-gray-500 text-xs">L ${precioAplicado.toLocaleString('en-US')}</td>
                <td class="p-4 text-right font-mono font-bold text-green-700">L ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="p-4 flex justify-center gap-2">
                    <button onclick="imprimirRecibo(${t.id})" class="text-gray-500 hover:text-gray-900 transition-colors"><span class="material-icons">print</span></button>
                    <button onclick="abrirActionModal('edit_reporte', ${t.id})" class="text-blue-500 hover:text-blue-800 transition-colors"><span class="material-icons">edit</span></button>
                    <button onclick="eliminarTransaccion(${t.id})" class="text-red-400 hover:text-red-700 transition-colors"><span class="material-icons">delete</span></button>
                </td>
            </tr>
        `;
    });

    // Calculate total metric tons 
    const totalTons = totalLbs / 2204.62;

    document.getElementById('rep-camiones').innerText = filteredData.length;
    document.getElementById('rep-toneladas').innerText = totalTons.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('rep-dinero').innerText = "L " + totalDinero.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 3. Print the receipt using the newly converted math!
function imprimirRecibo(id) {
    const t = transaccionesData.find(x => x.id === id);
    if (!t) return;

    const displayDate = t.fecha.split('-').reverse().join('/');

    document.getElementById('print-content').innerHTML = `
        <p><strong>Fecha/Hora:</strong> ${displayDate} ${t.hora}</p>
        <p><strong>Productor:</strong> ${t.cliente_nombre}</p>
        <p><strong>Vehículo/Chofer:</strong> ${t.placa} / ${t.conductor}</p>
        <hr class="my-2">
        <p><strong>Peso Neto:</strong> ${t.neto.toLocaleString('en-US')} LBS</p>
        <p><strong>Toneladas:</strong> ${(t.neto / 2204.62).toFixed(2)} Ton</p>
        <p><strong>Quintales:</strong> ${(t.neto / 100).toFixed(2)} Qq</p>
        <hr class="my-2">
        <p><strong>Precio Aplicado:</strong> L ${t.precio_aplicado.toLocaleString('en-US')} / Ton</p>
        <p class="text-xl"><strong>Total Pagado:</strong> L ${t.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
    `;
    window.print();
}

function eliminarTransaccion(id) { abrirActionModal('delete_reporte', id); }