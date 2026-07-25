let clockTimer = null;
let toastTimer = null;
let actionInProgress = false;

function startClock() {
    if (clockTimer) clearInterval(clockTimer);

    const updateClock = () => {
        const now = new Date();
        const time = document.getElementById('current-time');
        const date = document.getElementById('current-date');
        if (time) time.textContent = now.toLocaleTimeString('es-HN', { hour12: false });
        if (date) date.textContent = now.toLocaleDateString('es-HN');
    };

    updateClock();
    clockTimer = setInterval(updateClock, 1000);
}

function switchTab(tabName) {
    ['pesaje', 'overview', 'clientes', 'reportes', 'corapsa', 'gastos', 'planilla'].forEach(name => {
        const button = document.getElementById(`nav-${name}`);
        const view = document.getElementById(`view-${name}`);
        if (!button || !view) return;

        const active = name === tabName;
        button.classList.toggle('tab-active', active);
        button.classList.toggle('tab-inactive', !active);
        view.classList.toggle('hidden', !active);
        view.classList.toggle('flex', active);
    });

    const renderers = {
        overview: fetchOverview,
        reportes: updateReportesTab,
        corapsa: renderCorapsaTab,
        clientes: renderClientesTab,
        gastos: renderGastos,
        planilla: renderPlanilla
    };
    renderers[tabName]?.();
}

function mostrarNotificacion(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    if (toastTimer) clearTimeout(toastTimer);
    toast.replaceChildren();

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = type === 'error' ? 'error' : 'check_circle';

    const text = document.createElement('span');
    text.textContent = String(message ?? '');
    toast.append(icon, text);

    toast.className = `fixed top-5 right-5 px-6 py-4 rounded shadow-xl font-bold z-50 text-white flex items-center gap-2 ${type === 'error' ? 'bg-red-500' : 'bg-brand-500'}`;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

function actionRequiresRecordId(action) {
    return new Set([
        'delete_cola',
        'delete_reporte',
        'delete_cliente',
        'edit_reporte',
        'edit_corapsa',
        'delete_corapsa',
        'delete_corapsa_file',
        'replace_corapsa_file',
        'delete_gasto',
        'delete_trabajador',
        'delete_corapsa_pago'
    ]).has(action);
}

function normalizeActionRecordId(id) {
    const normalized = String(id ?? '').trim();
    return normalized || null;
}

function getActionModalCopy(action) {
    const copies = {
        manual_bruto: ['Ingreso Manual de Peso', 'Ingrese el peso (LBS):', 'Ej. 20,500'],
        manual_tara: ['Ingreso Manual de Peso', 'Ingrese el peso (LBS):', 'Ej. 8,500'],
        edit_reporte: ['Autorización de Edición', 'Ingrese la justificación de auditoría:', 'Explique el motivo de la modificación'],
        edit_corapsa: ['Autorización de Edición', 'Ingrese la justificación de auditoría:', 'Explique el motivo de la modificación'],
        replace_corapsa_file: ['Reemplazar Archivo', 'Justificación para reemplazar el archivo:', 'Ej. Se adjuntó el recibo incorrecto'],
        delete_corapsa_file: ['Eliminar Archivo', 'Justificación para eliminar el archivo:', 'Explique por qué debe eliminarse'],
        delete_cliente: ['Eliminar Cliente', 'Justificación para eliminar el cliente:', 'Explique el motivo'],
        delete_cola: ['Remover Vehículo', 'Justificación para removerlo de la cola:', 'Explique el motivo'],
        delete_reporte: ['Eliminar Transacción', 'Justificación para eliminar la transacción:', 'Explique el motivo'],
        delete_corapsa: ['Eliminar Recibo', 'Justificación para eliminar el recibo:', 'Explique el motivo'],
        delete_gasto: ['Eliminar Gasto', 'Justificación para eliminar el gasto:', 'Explique el motivo'],
        delete_trabajador: ['Eliminar Trabajador', 'Justificación para eliminar al trabajador:', 'Explique el motivo'],
        delete_corapsa_pago: ['Eliminar Pago de Corapsa', 'Justificación para eliminar el estado de cuenta:', 'Explique el motivo']
    };

    return copies[action] || ['Confirmar Acción', 'Justificación obligatoria:', 'Explique el motivo'];
}

function abrirActionModal(action, id = null) {
    const normalizedId = normalizeActionRecordId(id);
    if (actionRequiresRecordId(action) && !normalizedId) {
        mostrarNotificacion(
            'Este registro no tiene un ID válido. Reinicie el servidor y recargue la aplicación para reparar la cola.',
            'error'
        );
        fetchCamionesEnPatio?.().catch(error => console.error('No se pudo recargar la cola:', error));
        return;
    }

    pendingAction = action;
    pendingActionId = normalizedId ?? id;

    const input = document.getElementById('action-input');
    const [title, label, placeholder] = getActionModalCopy(action);
    document.getElementById('action-title').textContent = title;
    document.getElementById('action-label').textContent = label;
    input.value = '';
    input.placeholder = placeholder;
    input.type = 'text';
    input.removeAttribute('inputmode');
    input.oninput = null;

    if (action === 'manual_bruto' || action === 'manual_tara') {
        input.setAttribute('inputmode', 'numeric');
        input.oninput = formatIntegerThousandsInput;
    }

    document.getElementById('action-modal').classList.remove('hidden');
    setTimeout(() => input.focus(), 0);
}

function cerrarActionModal() {
    if (actionInProgress) return;
    document.getElementById('action-modal').classList.add('hidden');
    pendingAction = null;
    pendingActionId = null;
}

function setActionModalBusy(busy) {
    actionInProgress = busy;
    const button = document.getElementById('action-confirm-button');
    if (button) {
        button.disabled = busy;
        button.textContent = busy ? 'Procesando...' : 'Confirmar';
    }
}

async function confirmarActionModal() {
    if (actionInProgress) return;

    const value = document.getElementById('action-input').value.trim();
    const action = pendingAction;
    const id = pendingActionId;
    if (!value) return mostrarNotificacion('Este campo es obligatorio.', 'error');

    setActionModalBusy(true);

    try {
        switch (action) {
            case 'manual_bruto':
            case 'manual_tara': {
                const weight = parseFormattedNumber(value);
                if (!Number.isFinite(weight) || weight <= 0) throw new Error('Ingrese un peso válido mayor que cero.');
                const saved = action === 'manual_bruto'
                    ? await handleBrutoClick(weight)
                    : await handleTaraClick(weight);
                if (saved === false) return;
                break;
            }

            case 'delete_cola': {
                const queueId = normalizeActionRecordId(id);
                if (!queueId) {
                    throw new Error(
                        'El vehículo no tiene un ID válido. Reinicie el servidor y recargue la aplicación.'
                    );
                }

                await apiRequest(`/api/camiones-patio/${encodeURIComponent(queueId)}`, {
                    method: 'DELETE',
                    body: { justificacion: value }
                });
                camionesEnPatio = camionesEnPatio.filter(item => !sameRecordId(item.id, queueId));
                if (activeTransaction.id && sameRecordId(activeTransaction.id, queueId)) limpiarFormulario();
                renderQueue();
                mostrarNotificacion('Vehículo removido de la fila.');
                break;
            }

            case 'delete_reporte':
                await eliminarTransaccionServidor(id, value);
                mostrarNotificacion('Transacción eliminada.');
                break;

            case 'delete_cliente':
                await eliminarClienteServidor(id, value);
                mostrarNotificacion('Cliente eliminado.');
                break;

            case 'edit_reporte':
                mostrarNotificacion('La edición de reportes sigue en desarrollo.');
                break;

            case 'edit_corapsa':
                document.getElementById('action-modal').classList.add('hidden');
                pendingAction = null;
                pendingActionId = null;
                abrirCorapsaModal(id, value);
                return;

            case 'delete_corapsa':
                await eliminarCorapsaServidor(id, value);
                mostrarNotificacion('Recibo Corapsa eliminado.');
                break;

            case 'delete_corapsa_file':
                await eliminarArchivoCorapsa(id, value);
                mostrarNotificacion('Archivo eliminado.');
                break;

            case 'replace_corapsa_file':
                document.getElementById('action-modal').classList.add('hidden');
                pendingAction = null;
                pendingActionId = null;
                prepararReemplazoArchivoCorapsa(id, value);
                return;

            case 'delete_gasto':
                await eliminarGastoServidor(id, value);
                mostrarNotificacion('Gasto eliminado.');
                break;

            case 'delete_corapsa_pago':
                await eliminarPagoCorapsaServidor(id, value);
                mostrarNotificacion('Pago de Corapsa eliminado.');
                break;

            case 'delete_trabajador':
                await eliminarTrabajadorServidor(id, value);
                mostrarNotificacion('Trabajador eliminado.');
                break;

            default:
                throw new Error('La acción solicitada no está implementada.');
        }

        document.getElementById('action-modal').classList.add('hidden');
        pendingAction = null;
        pendingActionId = null;
    } catch (error) {
        console.error(`Error al ejecutar ${action}:`, error);
        mostrarNotificacion(error.message || 'No se pudo completar la acción.', 'error');
    } finally {
        setActionModalBusy(false);
    }
}

document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !document.getElementById('action-modal')?.classList.contains('hidden')) {
        event.preventDefault();
        confirmarActionModal();
    }
    if (event.key === 'Escape') {
        const modal = document.getElementById('action-modal');
        if (modal && !modal.classList.contains('hidden') && !actionInProgress) cerrarActionModal();
    }
});