function startClock() {
    setInterval(() => {
        const now = new Date();
        document.getElementById('current-time').innerText = now.toLocaleTimeString('es-HN', { hour12: false });
        document.getElementById('current-date').innerText = now.toLocaleDateString('es-HN');
    }, 1000);
}

function switchTab(tabName) {
    ['pesaje', 'clientes', 'reportes', 'corapsa', 'gastos', 'planilla'].forEach(t => {
        const btn = document.getElementById(`nav-${t}`);
        const view = document.getElementById(`view-${t}`);
        if (!btn || !view) return;

        if (t === tabName) {
            btn.classList.replace('tab-inactive', 'tab-active');
            view.classList.replace('hidden', 'flex');
        } else {
            btn.classList.replace('tab-active', 'tab-inactive');
            view.classList.add('hidden');
            view.classList.remove('flex');
        }
    });
}

function mostrarNotificacion(msg, tipo = "success") {
    const toast = document.getElementById('toast');
    toast.innerHTML = `<span class="material-icons">${tipo === 'error' ? 'error' : 'check_circle'}</span> ${msg}`;
    toast.className = `fixed top-5 right-5 px-6 py-4 rounded shadow-xl font-bold z-50 text-white flex items-center gap-2 ${tipo === 'error' ? 'bg-red-500' : 'bg-brand-500'}`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 4000);
}

function abrirActionModal(action, id = null) {
    pendingAction = action;
    pendingActionId = id;
    document.getElementById('action-input').value = '';
    document.getElementById('action-modal').classList.remove('hidden');

    if (action === 'manual_bruto' || action === 'manual_tara') {
        document.getElementById('action-title').innerText = "Ingreso Manual de Peso";
        document.getElementById('action-label').innerText = "Ingrese el peso (KG):";
        document.getElementById('action-input').type = "number";
    } else if (action === 'edit_reporte' || action === 'edit_corapsa') {
        document.getElementById('action-title').innerText = "Autorización de Edición";
        document.getElementById('action-label').innerText = "Ingrese la justificación de auditoría:";
        document.getElementById('action-input').type = "text";
    } else {
        document.getElementById('action-title').innerText = "Confirmar Eliminación";
        document.getElementById('action-label').innerText = "Justificación (Obligatoria):";
        document.getElementById('action-input').type = "text";
    }
}

function cerrarActionModal() { document.getElementById('action-modal').classList.add('hidden'); }

function confirmarActionModal() {
    const val = document.getElementById('action-input').value;
    if (!val) return mostrarNotificacion("Este campo es obligatorio.", "error");

    if (pendingAction === 'manual_bruto') {
        handleBrutoClick(parseInt(val));
        cerrarActionModal();
    } else if (pendingAction === 'manual_tara') {
        handleTaraClick(parseInt(val));
        cerrarActionModal();
    } else if (pendingAction === 'delete_cola') {
        camionesEnPatio = camionesEnPatio.filter(t => t.id !== pendingActionId);
        renderQueue();
        mostrarNotificacion("Vehículo removido de la fila.");
        cerrarActionModal();
    } else if (pendingAction === 'delete_reporte') {
        transaccionesData = transaccionesData.filter(t => t.id != pendingActionId);
        updateReportesTab();
        mostrarNotificacion("Transacción eliminada exitosamente.");
        cerrarActionModal();
    } else if (pendingAction === 'edit_reporte') {
        console.log(`[AUDITORIA EMAIL] Modificación de reporte. Razón: ${val}`);
        mostrarNotificacion("Edición de reportes en desarrollo.", "success");
        cerrarActionModal();
    } else if (pendingAction === 'edit_corapsa') {
        console.log(`[AUDITORIA EMAIL] Edición Corapsa autorizada. Razón: ${val}`);
        cerrarActionModal();
        abrirCorapsaModal(pendingActionId);
    } else if (pendingAction === 'delete_corapsa') {
        corapsaData = corapsaData.filter(t => t.id != pendingActionId);
        renderCorapsaTab();
        mostrarNotificacion("Recibo Corapsa eliminado exitosamente.");
        cerrarActionModal();
    }
}