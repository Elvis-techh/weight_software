function startClock() {
    const updateClock = () => {
        const now = new Date();
        const time = document.getElementById('current-time');
        const date = document.getElementById('current-date');
        if (time) time.innerText = now.toLocaleTimeString('es-HN', { hour12: false });
        if (date) date.innerText = now.toLocaleDateString('es-HN');
    };
    updateClock();
    setInterval(updateClock, 1000);
}

function switchTab(tabName) {
    ['pesaje', 'clientes', 'reportes', 'corapsa', 'gastos', 'planilla'].forEach(t => {
        const btn = document.getElementById(`nav-${t}`);
        const view = document.getElementById(`view-${t}`);
        if (!btn || !view) return;

        if (t === tabName) {
            btn.classList.replace('tab-inactive', 'tab-active');
            view.classList.remove('hidden');
            view.classList.add('flex');
        } else {
            btn.classList.replace('tab-active', 'tab-inactive');
            view.classList.add('hidden');
            view.classList.remove('flex');
        }
    });

    if (tabName === 'reportes') updateReportesTab();
    if (tabName === 'corapsa') renderCorapsaTab();
    if (tabName === 'clientes') renderClientesTab();
    if (tabName === 'gastos') renderGastos();
    if (tabName === 'planilla') renderPlanilla();
}

function mostrarNotificacion(msg, tipo = "success") {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.innerHTML = `<span class="material-icons">${tipo === 'error' ? 'error' : 'check_circle'}</span> ${msg}`;
    toast.className = `fixed top-5 right-5 px-6 py-4 rounded shadow-xl font-bold z-50 text-white flex items-center gap-2 ${tipo === 'error' ? 'bg-red-500' : 'bg-brand-500'}`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 4000);
}

function abrirActionModal(action, id = null) {
    pendingAction = action;
    pendingActionId = id;

    const input = document.getElementById('action-input');
    input.value = '';
    input.type = 'text';
    input.removeAttribute('inputmode');
    input.oninput = null;
    document.getElementById('action-modal').classList.remove('hidden');

    if (action === 'manual_bruto' || action === 'manual_tara') {
        document.getElementById('action-title').innerText = "Ingreso Manual de Peso";
        document.getElementById('action-label').innerText = "Ingrese el peso (KG):";
        input.setAttribute('inputmode', 'numeric');
        input.placeholder = 'Ej. 20,500';
        input.oninput = formatIntegerThousandsInput;
    } else if (action === 'edit_reporte' || action === 'edit_corapsa') {
        document.getElementById('action-title').innerText = "Autorización de Edición";
        document.getElementById('action-label').innerText = "Ingrese la justificación de auditoría:";
        input.placeholder = 'Explique el motivo de la modificación';
    } else if (action === 'replace_corapsa_file') {
        document.getElementById('action-title').innerText = "Reemplazar Archivo";
        document.getElementById('action-label').innerText = "Justificación para reemplazar el archivo:";
        input.placeholder = 'Ej. Se adjuntó el recibo incorrecto';
    } else if (action === 'delete_corapsa_file') {
        document.getElementById('action-title').innerText = "Eliminar Archivo";
        document.getElementById('action-label').innerText = "Justificación para eliminar el archivo:";
        input.placeholder = 'Explique por qué debe eliminarse';
    } else if (action === 'delete_cliente') {
        document.getElementById('action-title').innerText = "Eliminar Cliente";
        document.getElementById('action-label').innerText = "Justificación para eliminar el cliente:";
        input.placeholder = 'Explique el motivo de la eliminación';
    } else {
        document.getElementById('action-title').innerText = "Confirmar Eliminación";
        document.getElementById('action-label').innerText = "Justificación (Obligatoria):";
        input.placeholder = 'Explique el motivo';
    }

    setTimeout(() => input.focus(), 0);
}

function cerrarActionModal() {
    document.getElementById('action-modal').classList.add('hidden');
    pendingAction = null;
    pendingActionId = null;
}

async function confirmarActionModal() {
    const input = document.getElementById('action-input');
    const val = input.value.trim();
    if (!val) return mostrarNotificacion("Este campo es obligatorio.", "error");

    if (pendingAction === 'manual_bruto' || pendingAction === 'manual_tara') {
        const weight = parseFormattedNumber(val);
        if (!Number.isFinite(weight) || weight <= 0) {
            return mostrarNotificacion("Ingrese un peso válido mayor que cero.", "error");
        }
        const saved = pendingAction === 'manual_bruto'
            ? await handleBrutoClick(weight)
            : await handleTaraClick(weight);
        if (saved !== false) cerrarActionModal();
        return;
    }

    if (pendingAction === 'delete_cola') {
        const queueId = pendingActionId;
        try {
            await apiRequest(`/api/camiones-patio/${encodeURIComponent(queueId)}`, {
                method: 'DELETE',
                body: { justificacion: val }
            });

            camionesEnPatio = camionesEnPatio.filter(t => !sameRecordId(t.id, queueId));
            if (activeTransaction.id && sameRecordId(activeTransaction.id, queueId)) limpiarFormulario();
            renderQueue();
            console.log(`[AUDITORIA] Vehículo removido de la fila. Razón: ${val}`);
            mostrarNotificacion('Vehículo removido de la fila y del servidor.');
            cerrarActionModal();
        } catch (error) {
            console.error('No se pudo eliminar el vehículo de la cola:', error);
            mostrarNotificacion(error.message, 'error');
        }
    } else if (pendingAction === 'delete_reporte') {
        transaccionesData = transaccionesData.filter(t => t.id != pendingActionId);
        updateReportesTab();
        console.log(`[AUDITORIA] Transacción eliminada. Razón: ${val}`);
        mostrarNotificacion("Transacción eliminada exitosamente.");
        cerrarActionModal();
    } else if (pendingAction === 'delete_cliente') {
        const cliente = MOCK_CLIENTES.find(c => c.id == pendingActionId);
        if (!cliente) {
            mostrarNotificacion("Cliente no encontrado.", "error");
            cerrarActionModal();
            return;
        }
        MOCK_CLIENTES = MOCK_CLIENTES.filter(c => c.id != pendingActionId);
        console.log(`[AUDITORIA] Cliente eliminado: ${cliente.nombre} ${cliente.apellido || ''}. Razón: ${val}`);
        renderClientesTab();
        mostrarNotificacion("Cliente eliminado exitosamente.");
        cerrarActionModal();
    } else if (pendingAction === 'edit_reporte') {
        console.log(`[AUDITORIA EMAIL] Modificación de reporte. Razón: ${val}`);
        mostrarNotificacion("Edición de reportes en desarrollo.", "success");
        cerrarActionModal();
    } else if (pendingAction === 'edit_corapsa') {
        const id = pendingActionId;
        console.log(`[AUDITORIA EMAIL] Edición Corapsa autorizada. Razón: ${val}`);
        cerrarActionModal();
        abrirCorapsaModal(id);
    } else if (pendingAction === 'delete_corapsa') {
        corapsaData = corapsaData.filter(t => t.id != pendingActionId);
        renderCorapsaTab();
        console.log(`[AUDITORIA] Recibo Corapsa eliminado. Razón: ${val}`);
        mostrarNotificacion("Recibo Corapsa eliminado exitosamente.");
        cerrarActionModal();
    } else if (pendingAction === 'delete_corapsa_file') {
        const ref = pendingActionId;
        cerrarActionModal();
        eliminarArchivoCorapsa(ref, val);
    } else if (pendingAction === 'replace_corapsa_file') {
        const ref = pendingActionId;
        cerrarActionModal();
        prepararReemplazoArchivoCorapsa(ref, val);
    }
}