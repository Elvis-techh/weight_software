const DESTINO_SELECT_IDS = ['corapsa-destino', 'overview-payment-destino'];
const DESTINO_OTRO_VALUE = '__otro__';

let otroDestinoTargetSelectId = null;

function populateDestinoDropdowns() {
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
    });
}

function handleDestinoSelect(selectEl) {
    if (selectEl.value !== DESTINO_OTRO_VALUE) return;

    otroDestinoTargetSelectId = selectEl.id;
    selectEl.value = '';

    document.getElementById('otro-destino-nombre').value = '';
    document.getElementById('otro-destino-modal').classList.remove('hidden');
}

function cerrarOtroDestinoModal() {
    document.getElementById('otro-destino-modal').classList.add('hidden');
    document.getElementById('otro-destino-nombre').value = '';
    otroDestinoTargetSelectId = null;
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

function applyDestinoToTargetSelect(nombre) {
    ensureDestinoOption(otroDestinoTargetSelectId, nombre);
    document.getElementById(otroDestinoTargetSelectId).value = nombre;
}

function guardarOtroDestinoTemporal() {
    const nombre = readOtroDestinoNombre();
    if (!nombre) return;

    applyDestinoToTargetSelect(nombre);
    cerrarOtroDestinoModal();
}

async function guardarOtroDestinoPermanente() {
    const nombre = readOtroDestinoNombre();
    if (!nombre) return;

    const saveButton = document.getElementById('btn-guardar-otro-destino-permanente');

    try {
        if (saveButton) saveButton.disabled = true;

        const result = await apiRequest('/api/companies', { method: 'POST', body: { nombre } });
        const company = result?.company || result;

        MOCK_COMPANIES.push(company);
        populateDestinoDropdowns();
        applyDestinoToTargetSelect(company.nombre);
        cerrarOtroDestinoModal();
        mostrarNotificacion('Empresa agregada.');
    } catch (error) {
        console.error('Error al guardar empresa:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar la empresa.', 'error');
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}
