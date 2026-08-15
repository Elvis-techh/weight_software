const DESTINO_SELECT_IDS = ['corapsa-destino', 'overview-payment-destino'];
const DESTINO_OTRO_VALUE = '__otro__';

let otroDestinoTargetSelectId = null;
let otroDestinoPreviousValue = '';

function populateDestinoDropdowns() {
    let filterValueChanged = false;

    [...DESTINO_SELECT_IDS, 'corapsa-filter-destino'].forEach(selectId => {
        const select = document.getElementById(selectId);
        if (!select) return;

        const previousValue = select.value;
        const isFilter = selectId === 'corapsa-filter-destino';
        const fragment = document.createDocumentFragment();

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = isFilter ? 'Todos los destinos' : 'Seleccione...';
        fragment.appendChild(placeholder);

        MOCK_COMPANIES.forEach(company => {
            const option = document.createElement('option');
            option.value = company.nombre;
            option.textContent = company.nombre;
            fragment.appendChild(option);
        });

        if (!isFilter) {
            const otroOption = document.createElement('option');
            otroOption.value = DESTINO_OTRO_VALUE;
            otroOption.textContent = 'Otro...';
            fragment.appendChild(otroOption);
        }

        select.replaceChildren(fragment);

        const canRestore = Array.from(select.options).some(option => option.value === previousValue);
        select.value = canRestore ? previousValue : '';

        if (isFilter && select.value !== previousValue) filterValueChanged = true;
    });

    // A rename/delete can force the Corapsa filter back to "Todos los destinos"
    // above (previousValue no longer exists as an option); without this, the
    // table beneath keeps showing the old filtered subset until some other
    // control triggers a re-render, desyncing it from what the dropdown shows.
    if (filterValueChanged && typeof renderCorapsaTab === 'function') renderCorapsaTab();
}

// Snapshots the select's value before the browser applies the user's new
// choice, so cerrarOtroDestinoModal() can restore it on Cancel. A native
// <select> always gains focus before its value changes, whether the user
// clicks or navigates with the keyboard, so onfocus is a reliable hook point.
function rememberDestinoValue(selectEl) {
    if (selectEl.value !== DESTINO_OTRO_VALUE) {
        selectEl.dataset.priorValue = selectEl.value;
    }
}

function handleDestinoSelect(selectEl) {
    if (selectEl.value !== DESTINO_OTRO_VALUE) return;

    otroDestinoTargetSelectId = selectEl.id;
    otroDestinoPreviousValue = selectEl.dataset.priorValue || '';
    selectEl.value = '';

    document.getElementById('otro-destino-nombre').value = '';
    document.getElementById('otro-destino-modal').classList.remove('hidden');
}

function cerrarOtroDestinoModal({ restorePrevious = true } = {}) {
    if (restorePrevious && otroDestinoTargetSelectId) {
        const select = document.getElementById(otroDestinoTargetSelectId);
        if (select) select.value = otroDestinoPreviousValue;
    }

    document.getElementById('otro-destino-modal').classList.add('hidden');
    document.getElementById('otro-destino-nombre').value = '';
    otroDestinoTargetSelectId = null;
    otroDestinoPreviousValue = '';
}

function readOtroDestinoNombre() {
    const nombre = document.getElementById('otro-destino-nombre').value.trim().toUpperCase();
    if (!nombre) {
        mostrarNotificacion('El nombre de la empresa es obligatorio.', 'error');
        return null;
    }
    return nombre;
}

// Injects `nombre` as a select option if it isn't already one of the known
// companies — used both for the just-typed "Otro" value and for reopening a
// record whose destino was saved temporarily (never added to `companies`) so
// it doesn't render blank on edit.
function ensureDestinoOption(selectId, nombre) {
    if (!nombre) return;
    const select = document.getElementById(selectId);
    if (!select) return;

    const exists = Array.from(select.options).some(option => option.value === nombre);
    if (exists) return;

    const option = document.createElement('option');
    option.value = nombre;
    option.textContent = nombre;
    const otroOption = select.querySelector(`option[value="${DESTINO_OTRO_VALUE}"]`);
    select.insertBefore(option, otroOption || null);
}

// Strips any option that isn't a real (permanent) company — i.e. a one-off
// "Usar Solo Esta Vez" value, or a historical destino injected by
// ensureDestinoOption while editing a record. Call this whenever the modal
// that owns the select is closed (cancel or successful save), so a temporary
// name doesn't linger in the dropdown beyond that single use.
function limpiarDestinoTemporal(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const validValues = new Set(['', DESTINO_OTRO_VALUE, ...MOCK_COMPANIES.map(company => company.nombre)]);
    Array.from(select.options)
        .filter(option => !validValues.has(option.value))
        .forEach(option => option.remove());
}

function applyDestinoToTargetSelect(nombre) {
    ensureDestinoOption(otroDestinoTargetSelectId, nombre);
    document.getElementById(otroDestinoTargetSelectId).value = nombre;
}

function guardarOtroDestinoTemporal() {
    const nombre = readOtroDestinoNombre();
    if (!nombre) return;

    applyDestinoToTargetSelect(nombre);
    cerrarOtroDestinoModal({ restorePrevious: false });
}

// POSTs a new company and keeps MOCK_COMPANIES / the destino selects in
// sync. Shared by the "Otro" flow and the Gestionar Empresas "add" row.
async function crearCompanyRemota(nombre) {
    const result = await apiRequest('/api/companies', { method: 'POST', body: { nombre } });
    const company = normalizarCompany(result?.company || result);
    MOCK_COMPANIES.push(company);
    populateDestinoDropdowns();
    return company;
}

async function guardarOtroDestinoPermanente() {
    const nombre = readOtroDestinoNombre();
    if (!nombre) return;

    const saveButton = document.getElementById('btn-guardar-otro-destino-permanente');

    try {
        if (saveButton) saveButton.disabled = true;

        const company = await crearCompanyRemota(nombre);

        applyDestinoToTargetSelect(company.nombre);
        cerrarOtroDestinoModal({ restorePrevious: false });
        mostrarNotificacion('Empresa agregada.');
    } catch (error) {
        console.error('Error al guardar empresa:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar la empresa.', 'error');
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}

function normalizarCompany(record = {}) {
    return {
        id: record.id,
        nombre: String(record.nombre || '').trim()
    };
}

function sortedCompanies() {
    return [...MOCK_COMPANIES].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function abrirGestionEmpresasModal() {
    document.getElementById('gestion-empresa-nombre-nueva').value = '';
    renderGestionEmpresasLista();
    document.getElementById('gestion-empresas-modal').classList.remove('hidden');
}

function cerrarGestionEmpresasModal() {
    document.getElementById('gestion-empresas-modal').classList.add('hidden');
}

function renderGestionEmpresasLista() {
    const container = document.getElementById('gestion-empresas-lista');
    if (!container) return;

    const companies = sortedCompanies();
    if (companies.length === 0) {
        container.innerHTML = '<p class="text-sm text-gray-500 text-center py-4">No hay empresas registradas.</p>';
        return;
    }

    container.innerHTML = companies.map(company => `
        <div class="flex items-center justify-between border-b border-gray-100 last:border-0 py-2">
            <span class="text-sm font-bold text-gray-700">${escapeHtml(company.nombre)}</span>
            <div class="flex items-center gap-2">
                <button type="button" onclick="abrirEditarEmpresaModal('${escapeHtml(company.id)}')" class="text-blue-500 hover:text-blue-700 transition-colors" aria-label="Editar empresa">
                    <span class="material-icons text-[18px]">edit</span>
                </button>
                <button type="button" onclick="solicitarEliminarEmpresa('${escapeHtml(company.id)}')" class="text-red-500 hover:text-red-700 transition-colors" aria-label="Eliminar empresa">
                    <span class="material-icons text-[18px]">delete</span>
                </button>
            </div>
        </div>
    `).join('');
}

async function agregarEmpresaDesdeGestion() {
    const input = document.getElementById('gestion-empresa-nombre-nueva');
    const nombre = input.value.trim().toUpperCase();
    if (!nombre) return mostrarNotificacion('El nombre de la empresa es obligatorio.', 'error');

    try {
        await crearCompanyRemota(nombre);
        input.value = '';
        renderGestionEmpresasLista();
        mostrarNotificacion('Empresa agregada.');
    } catch (error) {
        console.error('Error al agregar empresa:', error);
        mostrarNotificacion(error.message || 'No se pudo agregar la empresa.', 'error');
    }
}

function abrirEditarEmpresaModal(id) {
    const company = MOCK_COMPANIES.find(item => sameRecordId(item.id, id));
    if (!company) return mostrarNotificacion('Empresa no encontrada.', 'error');

    document.getElementById('editar-empresa-id').value = company.id;
    document.getElementById('editar-empresa-nombre').value = company.nombre;
    document.getElementById('editar-empresa-justificacion').value = '';
    document.getElementById('editar-empresa-modal').classList.remove('hidden');
}

function cerrarEditarEmpresaModal() {
    document.getElementById('editar-empresa-modal').classList.add('hidden');
}

async function guardarEmpresaEditada() {
    const id = document.getElementById('editar-empresa-id').value;
    const nombre = document.getElementById('editar-empresa-nombre').value.trim().toUpperCase();
    const justificacion = document.getElementById('editar-empresa-justificacion').value.trim();

    if (!nombre) return mostrarNotificacion('El nombre de la empresa es obligatorio.', 'error');
    if (!justificacion) return mostrarNotificacion('La justificación es obligatoria.', 'error');

    const saveButton = document.getElementById('btn-guardar-empresa-editada');

    try {
        if (saveButton) saveButton.disabled = true;

        const result = await apiRequest(`/api/companies/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: { nombre, justificacion }
        });
        const company = normalizarCompany(result?.company || result);

        const index = MOCK_COMPANIES.findIndex(item => sameRecordId(item.id, company.id));
        if (index >= 0) MOCK_COMPANIES[index] = company;

        populateDestinoDropdowns();
        renderGestionEmpresasLista();
        cerrarEditarEmpresaModal();
        mostrarNotificacion('Empresa actualizada.');
    } catch (error) {
        console.error('Error al editar empresa:', error);
        mostrarNotificacion(error.message || 'No se pudo editar la empresa.', 'error');
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}

function solicitarEliminarEmpresa(id) {
    abrirActionModal('delete_company', id);
}

async function eliminarEmpresaServidor(id, justificacion) {
    await apiRequest(`/api/companies/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });
    MOCK_COMPANIES = MOCK_COMPANIES.filter(company => !sameRecordId(company.id, id));
    populateDestinoDropdowns();
    renderGestionEmpresasLista();
}
