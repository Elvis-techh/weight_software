const QUINTALES_PER_TON = Number(APP_CONFIG.quintalesPerTon || 22.04);

function roundToNearestTenth(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return NaN;
    return Math.round((number + Number.EPSILON) * 10) / 10;
}

function roundToCurrency(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return NaN;
    return Math.round((number + Number.EPSILON) * 100) / 100;
}

function pricePerQuintalFromTon(priceInTon) {
    const price = Number(priceInTon);
    if (!Number.isFinite(price)) return NaN;
    return Math.round(price / QUINTALES_PER_TON);
}

function recoverTonPrice(unitPrice, unit) {
    const price = toFiniteNumber(unitPrice);
    return unit === 'quintal'
        ? roundToCurrency(price * QUINTALES_PER_TON)
        : price;
}

function normalizarCliente(record = {}) {
    const unidad = record.unidad === 'quintal' ? 'quintal' : 'tonelada';
    const precioFletePropio = toFiniteNumber(record.precioFletePropio ?? record.precio_flete_propio);
    const precioFleteCliente = toFiniteNumber(record.precioFleteCliente ?? record.precio_flete_cliente);

    const tonPropioRaw = parseFormattedNumber(
        record.precioToneladaPropio ?? record.precio_tonelada_propio
    );
    const tonClienteRaw = parseFormattedNumber(
        record.precioToneladaCliente ?? record.precio_tonelada_cliente
    );

    return {
        id: record.id,
        nombre: String(record.nombre || '').trim(),
        apellido: String(record.apellido || '').trim(),
        telefono: String(record.telefono || '').trim(),
        ubicacion: String(record.ubicacion || '').trim(),
        precioFletePropio,
        precioFleteCliente,
        precioToneladaPropio: Number.isFinite(tonPropioRaw)
            ? tonPropioRaw
            : recoverTonPrice(precioFletePropio, unidad),
        precioToneladaCliente: Number.isFinite(tonClienteRaw)
            ? tonClienteRaw
            : recoverTonPrice(precioFleteCliente, unidad),
        unidad
    };
}

function formatClientUnitPrice(value, unit) {
    return toFiniteNumber(value).toLocaleString('en-US', {
        minimumFractionDigits: unit === 'quintal' ? 1 : 2,
        maximumFractionDigits: unit === 'quintal' ? 1 : 2
    });
}

function renderClientPrice(price, tonPrice, unit, textClass) {
    const baseTon = unit === 'quintal'
        ? `<div class="mt-1 text-[10px] font-sans font-semibold text-gray-400">Base Ton: L ${formatMoney(tonPrice)}</div>`
        : '';

    return `
        <td class="p-3 text-sm font-mono font-bold ${textClass}">
            L ${formatClientUnitPrice(price, unit)}
            ${baseTon}
        </td>
    `;
}

function renderClientesTab() {
    const tbody = document.getElementById('clients-table-body');
    if (!tbody) return;

    const searchTerm = (document.getElementById('buscar-cliente')?.value || '')
        .trim()
        .toLocaleLowerCase('es');
    const sortValue = document.getElementById('ordenar-cliente')?.value || 'recientes';

    const clientesFiltrados = MOCK_CLIENTES
        .filter(cliente => {
            const searchable = [
                cliente.nombre,
                cliente.apellido,
                cliente.telefono,
                cliente.ubicacion
            ].join(' ').toLocaleLowerCase('es');

            return searchable.includes(searchTerm);
        })
        .sort((a, b) => {
            switch (sortValue) {
                case 'a-z':
                    return `${a.nombre} ${a.apellido}`.localeCompare(`${b.nombre} ${b.apellido}`, 'es');
                case 'z-a':
                    return `${b.nombre} ${b.apellido}`.localeCompare(`${a.nombre} ${a.apellido}`, 'es');
                case 'propio-asc':
                    return a.precioFletePropio - b.precioFletePropio;
                case 'propio-desc':
                    return b.precioFletePropio - a.precioFletePropio;
                case 'cliente-asc':
                    return a.precioFleteCliente - b.precioFleteCliente;
                case 'cliente-desc':
                    return b.precioFleteCliente - a.precioFleteCliente;
                default:
                    return toFiniteNumber(b.id) - toFiniteNumber(a.id);
            }
        });

    if (clientesFiltrados.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="p-6 text-center text-gray-500">No se encontraron clientes.</td></tr>';
        return;
    }

    tbody.innerHTML = clientesFiltrados.map(cliente => `
        <tr class="hover:bg-blue-50 border-b border-gray-100 last:border-0 transition-colors">
            <td class="p-3 text-sm text-gray-500 font-mono">#${escapeHtml(cliente.id)}</td>
            <td class="p-3 text-sm font-bold text-gray-800">${escapeHtml(`${cliente.nombre} ${cliente.apellido}`.trim())}</td>
            <td class="p-3 text-sm text-gray-600">${escapeHtml(cliente.telefono || '-')}</td>
            <td class="p-3 text-sm text-gray-600">${escapeHtml(cliente.ubicacion || '-')}</td>
            ${renderClientPrice(cliente.precioFletePropio, cliente.precioToneladaPropio, cliente.unidad, 'text-blue-700')}
            ${renderClientPrice(cliente.precioFleteCliente, cliente.precioToneladaCliente, cliente.unidad, 'text-teal-700')}
            <td class="p-3 text-center text-sm font-bold text-gray-600 uppercase">${cliente.unidad === 'quintal' ? 'QQ' : 'TON'}</td>
            <td class="p-3 text-center">
                <div class="flex justify-center gap-2">
                    <button type="button" onclick="abrirModalCliente('${escapeHtml(cliente.id)}')" class="text-blue-500 hover:text-blue-700 transition-colors" aria-label="Editar cliente">
                        <span class="material-icons text-[18px]">edit</span>
                    </button>
                    <button type="button" onclick="solicitarEliminarCliente('${escapeHtml(cliente.id)}')" class="text-red-500 hover:text-red-700 transition-colors" aria-label="Eliminar cliente">
                        <span class="material-icons text-[18px]">delete</span>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function populateClienteDropdown() {
    const select = document.getElementById('cliente-select');
    const dataList = document.getElementById('corapsa-clientes-list');
    if (!select) return;

    const previousValue = select.value;
    const fragment = document.createDocumentFragment();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.textContent = 'Seleccione un cliente...';
    fragment.appendChild(placeholder);

    const casualOption = document.createElement('option');
    casualOption.value = 'casual';
    casualOption.className = 'font-bold text-blue-600';
    casualOption.textContent = MOCK_CASUAL.nombre
        ? `👤 Casual: ${MOCK_CASUAL.nombre}`
        : '👤 Cliente Casual / Rápido';
    fragment.appendChild(casualOption);

    if (dataList) dataList.replaceChildren();

    MOCK_CLIENTES.forEach(cliente => {
        const fullName = `${cliente.nombre} ${cliente.apellido}`.trim();
        const option = document.createElement('option');
        option.value = String(cliente.id);
        option.textContent = fullName;
        fragment.appendChild(option);

        if (dataList) {
            const item = document.createElement('option');
            item.value = fullName;
            dataList.appendChild(item);
        }
    });

    select.replaceChildren(fragment);

    const canRestore = Array.from(select.options).some(option => option.value === previousValue);
    select.value = canRestore ? previousValue : '';
}

function handleClienteSelect() {
    const select = document.getElementById('cliente-select');
    if (!select) return;

    if (select.value === 'casual') {
        document.getElementById('casual-nombre').value = MOCK_CASUAL.nombre || '';
        document.getElementById('casual-precio').value = MOCK_CASUAL.precioFletePropio
            ? formatNumberForInput(MOCK_CASUAL.precioFletePropio, 2)
            : '';
        document.getElementById('casual-unidad').value = MOCK_CASUAL.unidad || 'tonelada';
        document.getElementById('casual-modal').classList.remove('hidden');
        return;
    }

    mostrarInfoCliente();
}

function cerrarCasualModal() {
    document.getElementById('casual-modal').classList.add('hidden');
    document.getElementById('cliente-select').value = '';
    mostrarInfoCliente();
}

function guardarCasual() {
    const nombre = document.getElementById('casual-nombre').value.trim();
    const precio = parseFormattedNumber(document.getElementById('casual-precio').value);
    const unidad = document.getElementById('casual-unidad').value;

    if (!nombre) return mostrarNotificacion('El nombre del cliente casual es obligatorio.', 'error');
    if (!Number.isFinite(precio) || precio < 0) return mostrarNotificacion('Ingrese un precio válido.', 'error');
    if (!['tonelada', 'quintal'].includes(unidad)) return mostrarNotificacion('La unidad seleccionada no es válida.', 'error');

    MOCK_CASUAL = {
        ...createDefaultCasualClient(),
        nombre,
        precioFletePropio: precio,
        precioFleteCliente: precio,
        unidad
    };

    populateClienteDropdown();
    document.getElementById('cliente-select').value = 'casual';
    document.getElementById('casual-modal').classList.add('hidden');
    mostrarInfoCliente();
    mostrarNotificacion('Cliente casual configurado.');
}

function setDerivedPriceInputState(input, isDerived) {
    input.readOnly = isDerived;
    input.classList.toggle('bg-gray-100', isDerived);
    input.classList.toggle('text-gray-600', isDerived);
    input.classList.toggle('cursor-not-allowed', isDerived);
}

function recalculateQuintalPrices() {
    const unidad = document.getElementById('modal-unidad')?.value;
    if (unidad !== 'quintal') return;

    const pairs = [
        ['modal-precio-ton-propio', 'modal-precio-propio'],
        ['modal-precio-ton-cliente', 'modal-precio-cliente']
    ];

    pairs.forEach(([tonInputId, quintalInputId]) => {
        const priceInTon = parseFormattedNumber(document.getElementById(tonInputId)?.value);
        const target = document.getElementById(quintalInputId);
        if (!target) return;

        const calculated = pricePerQuintalFromTon(priceInTon);
        target.value = Number.isFinite(calculated)
            ? formatNumberForInput(calculated, 1)
            : '';
    });
}

function applyClientUnitFieldState() {
    const unitSelect = document.getElementById('modal-unidad');
    const tonContainer = document.getElementById('modal-precios-tonelada-container');
    const ownPriceInput = document.getElementById('modal-precio-propio');
    const clientPriceInput = document.getElementById('modal-precio-cliente');
    const ownTonInput = document.getElementById('modal-precio-ton-propio');
    const clientTonInput = document.getElementById('modal-precio-ton-cliente');
    const ownLabel = document.getElementById('modal-precio-propio-label');
    const clientLabel = document.getElementById('modal-precio-cliente-label');

    if (!unitSelect || !tonContainer || !ownPriceInput || !clientPriceInput || !ownTonInput || !clientTonInput) return;

    const isQuintal = unitSelect.value === 'quintal';
    tonContainer.classList.toggle('hidden', !isQuintal);
    ownTonInput.required = isQuintal;
    clientTonInput.required = isQuintal;
    setDerivedPriceInputState(ownPriceInput, isQuintal);
    setDerivedPriceInputState(clientPriceInput, isQuintal);

    if (ownLabel) ownLabel.textContent = isQuintal ? 'Flete NUESTRO calculado (HNL / QQ) *' : 'Flete NUESTRO (HNL / Ton) *';
    if (clientLabel) clientLabel.textContent = isQuintal ? 'Flete CLIENTE calculado (HNL / QQ) *' : 'Flete CLIENTE (HNL / Ton) *';

    if (isQuintal) recalculateQuintalPrices();
}

function handleClientUnitChange() {
    const unitSelect = document.getElementById('modal-unidad');
    if (!unitSelect) return;

    const previousUnit = unitSelect.dataset.previousUnit || 'tonelada';
    const nextUnit = unitSelect.value;
    const ownVisible = document.getElementById('modal-precio-propio');
    const clientVisible = document.getElementById('modal-precio-cliente');
    const ownTon = document.getElementById('modal-precio-ton-propio');
    const clientTon = document.getElementById('modal-precio-ton-cliente');

    if (previousUnit !== nextUnit && nextUnit === 'quintal') {
        if (!ownTon.value.trim()) ownTon.value = ownVisible.value;
        if (!clientTon.value.trim()) clientTon.value = clientVisible.value;
    } else if (previousUnit !== nextUnit && nextUnit === 'tonelada') {
        if (ownTon.value.trim()) ownVisible.value = ownTon.value;
        if (clientTon.value.trim()) clientVisible.value = clientTon.value;
    }

    unitSelect.dataset.previousUnit = nextUnit;
    applyClientUnitFieldState();
}

function abrirModalCliente(id = null) {
    const modal = document.getElementById('client-modal');
    const form = document.getElementById('client-form');
    const justificationContainer = document.getElementById('modal-justificacion-container');
    const unitSelect = document.getElementById('modal-unidad');

    form.reset();

    if (id !== null) {
        const cliente = MOCK_CLIENTES.find(item => sameRecordId(item.id, id));
        if (!cliente) return mostrarNotificacion('Cliente no encontrado.', 'error');

        document.getElementById('modal-title').textContent = 'Editar Cliente';
        document.getElementById('modal-client-id').value = cliente.id;
        document.getElementById('modal-nombre').value = cliente.nombre;
        document.getElementById('modal-apellido').value = cliente.apellido;
        document.getElementById('modal-telefono').value = cliente.telefono;
        document.getElementById('modal-ubicacion').value = cliente.ubicacion;
        unitSelect.value = cliente.unidad;
        unitSelect.dataset.previousUnit = cliente.unidad;
        document.getElementById('modal-precio-propio').value = formatNumberForInput(cliente.precioFletePropio, cliente.unidad === 'quintal' ? 1 : 2);
        document.getElementById('modal-precio-cliente').value = formatNumberForInput(cliente.precioFleteCliente, cliente.unidad === 'quintal' ? 1 : 2);
        document.getElementById('modal-precio-ton-propio').value = formatNumberForInput(cliente.precioToneladaPropio, 2);
        document.getElementById('modal-precio-ton-cliente').value = formatNumberForInput(cliente.precioToneladaCliente, 2);
        document.getElementById('modal-justificacion').value = '';
        justificationContainer.classList.remove('hidden');
        justificationContainer.classList.add('flex');
    } else {
        document.getElementById('modal-title').textContent = 'Nuevo Cliente';
        document.getElementById('modal-client-id').value = '';
        unitSelect.value = 'tonelada';
        unitSelect.dataset.previousUnit = 'tonelada';
        justificationContainer.classList.add('hidden');
        justificationContainer.classList.remove('flex');
    }

    applyClientUnitFieldState();
    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('modal-nombre')?.focus(), 0);
}

function cerrarModalCliente() {
    document.getElementById('client-modal').classList.add('hidden');
    document.getElementById('client-form')?.reset();
    const unitSelect = document.getElementById('modal-unidad');
    if (unitSelect) unitSelect.dataset.previousUnit = 'tonelada';
}

function getRequiredElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`No se encontró el elemento HTML #${id}`);
    return element;
}

async function guardarCliente(event) {
    event?.preventDefault?.();

    const saveButton = event?.submitter || document.getElementById('btn-guardar-cliente');
    const clientId = getRequiredElement('modal-client-id').value;
    const justificacion = getRequiredElement('modal-justificacion').value.trim();
    const unidad = getRequiredElement('modal-unidad').value;

    let precioFletePropio = parseFormattedNumber(getRequiredElement('modal-precio-propio').value);
    let precioFleteCliente = parseFormattedNumber(getRequiredElement('modal-precio-cliente').value);
    let precioToneladaPropio = precioFletePropio;
    let precioToneladaCliente = precioFleteCliente;

    if (unidad === 'quintal') {
        precioToneladaPropio = parseFormattedNumber(getRequiredElement('modal-precio-ton-propio').value);
        precioToneladaCliente = parseFormattedNumber(getRequiredElement('modal-precio-ton-cliente').value);
        precioFletePropio = pricePerQuintalFromTon(precioToneladaPropio);
        precioFleteCliente = pricePerQuintalFromTon(precioToneladaCliente);
    }

    const clienteData = {
        nombre: getRequiredElement('modal-nombre').value.trim().replace(/\s+/g, ' '),
        apellido: getRequiredElement('modal-apellido').value.trim().replace(/\s+/g, ' '),
        telefono: getRequiredElement('modal-telefono').value.trim(),
        ubicacion: getRequiredElement('modal-ubicacion').value.trim(),
        precioFletePropio,
        precioFleteCliente,
        precioToneladaPropio,
        precioToneladaCliente,
        unidad,
        justificacion
    };

    if (!clienteData.nombre) return mostrarNotificacion('El nombre es obligatorio.', 'error');
    if (!['tonelada', 'quintal'].includes(clienteData.unidad)) {
        return mostrarNotificacion('La unidad seleccionada no es válida.', 'error');
    }
    if (!Number.isFinite(clienteData.precioToneladaPropio) || clienteData.precioToneladaPropio < 0) {
        return mostrarNotificacion('Precio en tonelada de flete nuestro inválido.', 'error');
    }
    if (!Number.isFinite(clienteData.precioToneladaCliente) || clienteData.precioToneladaCliente < 0) {
        return mostrarNotificacion('Precio en tonelada de flete cliente inválido.', 'error');
    }
    if (!Number.isFinite(clienteData.precioFletePropio) || clienteData.precioFletePropio < 0) {
        return mostrarNotificacion('Precio de flete nuestro inválido.', 'error');
    }
    if (!Number.isFinite(clienteData.precioFleteCliente) || clienteData.precioFleteCliente < 0) {
        return mostrarNotificacion('Precio de flete del cliente inválido.', 'error');
    }
    if (clientId && !justificacion) {
        return mostrarNotificacion('Debe ingresar una justificación para editar el cliente.', 'error');
    }

    try {
        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = 'Guardando...';
        }

        const result = clientId
            ? await apiRequest(`/api/clientes/${encodeURIComponent(clientId)}`, { method: 'PUT', body: clienteData })
            : await apiRequest('/api/clientes', { method: 'POST', body: clienteData });

        const savedClient = normalizarCliente(result?.cliente || result);
        const index = MOCK_CLIENTES.findIndex(cliente => sameRecordId(cliente.id, savedClient.id));

        if (index >= 0) MOCK_CLIENTES[index] = savedClient;
        else MOCK_CLIENTES.push(savedClient);

        renderClientesTab();
        populateClienteDropdown();
        cerrarModalCliente();
        mostrarNotificacion(clientId ? 'Cliente actualizado exitosamente.' : 'Cliente guardado exitosamente.');
    } catch (error) {
        console.error('Error al guardar cliente:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el cliente.', 'error');
    } finally {
        if (saveButton) {
            saveButton.disabled = false;
            saveButton.textContent = 'Guardar';
        }
    }
}

function solicitarEliminarCliente(id) {
    abrirActionModal('delete_cliente', id);
}

async function eliminarClienteServidor(id, justificacion) {
    await apiRequest(`/api/clientes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { justificacion }
    });

    MOCK_CLIENTES = MOCK_CLIENTES.filter(cliente => !sameRecordId(cliente.id, id));
    renderClientesTab();
    populateClienteDropdown();
}

function abrirAjusteGlobal() {
    document.getElementById('ajuste-monto').value = '';
    document.getElementById('ajuste-razon').value = '';
    document.getElementById('global-price-modal').classList.remove('hidden');
}

function cerrarAjusteGlobal() {
    document.getElementById('global-price-modal').classList.add('hidden');
}

async function aplicarAjusteGlobalForm() {
    const accion = document.getElementById('ajuste-accion').value;
    const montoBase = parseFormattedNumber(document.getElementById('ajuste-monto').value);
    const razon = document.getElementById('ajuste-razon').value.trim();

    if (!Number.isFinite(montoBase) || montoBase <= 0) {
        return mostrarNotificacion('Ingrese un monto mayor que cero.', 'error');
    }
    if (!razon) return mostrarNotificacion('Debe ingresar una justificación.', 'error');

    const montoTonelada = accion === 'disminuir' ? -montoBase : montoBase;
    const invalidClient = MOCK_CLIENTES.find(cliente =>
        cliente.precioToneladaPropio + montoTonelada < 0 ||
        cliente.precioToneladaCliente + montoTonelada < 0
    );

    if (invalidClient) {
        return mostrarNotificacion(
            `El ajuste dejaría un precio negativo para ${invalidClient.nombre}.`,
            'error'
        );
    }

    try {
        const result = await apiRequest('/api/clientes/ajuste-global', {
            method: 'POST',
            body: { montoTonelada, monto: montoTonelada, razon }
        });

        if (Array.isArray(result?.clientes)) {
            MOCK_CLIENTES = result.clientes.map(normalizarCliente);
        } else {
            MOCK_CLIENTES = MOCK_CLIENTES.map(cliente => {
                const precioToneladaPropio = roundToCurrency(cliente.precioToneladaPropio + montoTonelada);
                const precioToneladaCliente = roundToCurrency(cliente.precioToneladaCliente + montoTonelada);
                return {
                    ...cliente,
                    precioToneladaPropio,
                    precioToneladaCliente,
                    precioFletePropio: cliente.unidad === 'quintal'
                        ? pricePerQuintalFromTon(precioToneladaPropio)
                        : precioToneladaPropio,
                    precioFleteCliente: cliente.unidad === 'quintal'
                        ? pricePerQuintalFromTon(precioToneladaCliente)
                        : precioToneladaCliente
                };
            });
        }

        renderClientesTab();
        populateClienteDropdown();
        cerrarAjusteGlobal();
        mostrarNotificacion('Precios actualizados y clientes en quintales recalculados.');
    } catch (error) {
        console.error('Error al aplicar ajuste global:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar el ajuste.', 'error');
    }
}

function toggleSearchBar() {
    const searchInput = document.getElementById('buscar-cliente');
    if (!searchInput) return;

    const opening = searchInput.classList.contains('w-0');
    searchInput.classList.toggle('w-0', !opening);
    searchInput.classList.toggle('opacity-0', !opening);
    searchInput.classList.toggle('border-0', !opening);
    searchInput.classList.toggle('px-0', !opening);
    searchInput.classList.toggle('w-64', opening);
    searchInput.classList.toggle('opacity-100', opening);
    searchInput.classList.toggle('border', opening);
    searchInput.classList.toggle('border-gray-200', opening);
    searchInput.classList.toggle('px-4', opening);

    if (opening) {
        searchInput.focus();
    } else {
        searchInput.value = '';
        renderClientesTab();
    }
}

function toggleSortMenu() {
    const sortMenu = document.getElementById('sort-menu');
    if (!sortMenu) return;

    const opening = sortMenu.classList.contains('opacity-0');
    sortMenu.classList.toggle('opacity-0', !opening);
    sortMenu.classList.toggle('scale-95', !opening);
    sortMenu.classList.toggle('pointer-events-none', !opening);
    sortMenu.classList.toggle('opacity-100', opening);
    sortMenu.classList.toggle('scale-100', opening);
    sortMenu.classList.toggle('pointer-events-auto', opening);
}

document.addEventListener('click', event => {
    const sortMenu = document.getElementById('sort-menu');
    if (!sortMenu) return;

    const sortButton = sortMenu.previousElementSibling;
    if (!sortMenu.contains(event.target) && !sortButton?.contains(event.target)) {
        sortMenu.classList.add('opacity-0', 'scale-95', 'pointer-events-none');
        sortMenu.classList.remove('opacity-100', 'scale-100', 'pointer-events-auto');
    }
});