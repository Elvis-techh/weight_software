function updateReportesTab() {
    const tbody = document.getElementById('reports-table-body');
    const startDate = document.getElementById('filter-start').value;
    const endDate = document.getElementById('filter-end').value;

    const filteredData = transaccionesData.filter(t => {
        if (startDate && t.fecha < startDate) return false;
        if (endDate && t.fecha > endDate) return false;
        return true;
    });

    let totalTons = 0;
    let totalDinero = 0;

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-gray-400">Sin transacciones en este rango de fechas.</td></tr>`;
        document.getElementById('rep-camiones').innerText = "0";
        document.getElementById('rep-toneladas').innerText = "0.00";
        document.getElementById('rep-dinero').innerText = "L 0.00";
        return;
    }

    tbody.innerHTML = '';
    filteredData.forEach(t => {
        const tons = t.neto / 1000;
        totalTons += tons;
        totalDinero += t.total;

        const iden = t.placa !== "S/P" ? t.placa : (t.conductor !== "Desconocido" ? t.conductor : "S/P");
        const displayDate = t.fecha.split('-').reverse().join('/');

        tbody.innerHTML += `
            <tr class="hover:bg-gray-50">
                <td class="p-4 font-mono text-gray-500 text-xs">${displayDate} <br> ${t.hora}</td>
                <td class="p-4 font-bold text-gray-800 uppercase">${iden}</td>
                <td class="p-4 text-gray-600 text-sm">${t.clienteNombre}</td>
                <td class="p-4 text-right font-mono font-bold text-gray-800">${t.neto.toLocaleString()}</td>
                <td class="p-4 text-right font-mono text-gray-500 text-xs">L ${t.precioAplicado.toLocaleString()}</td>
                <td class="p-4 text-right font-mono font-bold text-green-700">L ${t.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="p-4 flex justify-center gap-2">
                    <button onclick="imprimirRecibo(${t.id})" class="text-gray-500 hover:text-gray-900 transition-colors"><span class="material-icons">print</span></button>
                    <button onclick="abrirActionModal('edit_reporte', ${t.id})" class="text-blue-500 hover:text-blue-800 transition-colors"><span class="material-icons">edit</span></button>
                    <button onclick="eliminarTransaccion(${t.id})" class="text-red-400 hover:text-red-700 transition-colors"><span class="material-icons">delete</span></button>
                </td>
            </tr>
        `;
    });

    document.getElementById('rep-camiones').innerText = filteredData.length;
    document.getElementById('rep-toneladas').innerText = totalTons.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('rep-dinero').innerText = "L " + totalDinero.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function eliminarTransaccion(id) { abrirActionModal('delete_reporte', id); }

function imprimirRecibo(id) {
    const t = transaccionesData.find(x => x.id === id);
    if (!t) return;
    const factorQq = parseFloat(document.getElementById('factor-conversion').value) || 2.2046;
    const displayDate = t.fecha.split('-').reverse().join('/');

    document.getElementById('print-content').innerHTML = `
        <p><strong>Fecha/Hora:</strong> ${displayDate} ${t.hora}</p>
        <p><strong>Productor:</strong> ${t.clienteNombre}</p>
        <p><strong>Vehículo/Chofer:</strong> ${t.placa} / ${t.conductor}</p>
        <hr class="my-2">
        <p><strong>Peso Neto:</strong> ${t.neto.toLocaleString('en-US')} KG</p>
        <p><strong>Toneladas:</strong> ${(t.neto / 1000).toFixed(2)} Ton</p>
        <p><strong>Quintales:</strong> ${((t.neto / 1000) * factorQq).toFixed(2)} Qq</p>
        <hr class="my-2">
        <p><strong>Precio Aplicado:</strong> L ${t.precioAplicado.toLocaleString('en-US')} / Ton</p>
        <p class="text-xl"><strong>Total Pagado:</strong> L ${t.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
    `;
    window.print();
}