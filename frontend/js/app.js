async function fetchClientes() {
    try {
        const clientesDelServidor = await apiRequest('/api/clientes');
        MOCK_CLIENTES = Array.isArray(clientesDelServidor) ? clientesDelServidor : [];
        renderClientesTab();
        populateClienteDropdown();
        console.log('Datos de clientes sincronizados con el servidor.');
    } catch (error) {
        console.error('No se pudieron cargar los clientes:', error);
        mostrarNotificacion(error.message, 'error');
    }
}

async function fetchCamionesEnPatio() {
    try {
        const registros = await apiRequest('/api/camiones-patio');
        camionesEnPatio = Array.isArray(registros)
            ? registros.map(normalizarCamionPatio)
            : [];
        renderQueue();
        console.log('Camiones en patio sincronizados con el servidor.');
    } catch (error) {
        console.error('No se pudo cargar la cola del patio:', error);
        mostrarNotificacion('No se pudo recuperar la cola guardada.', 'error');
    }
}

function setupScaleListener() {
    if (!window.electronAPI) return;

    window.electronAPI.onScaleData((data) => {
        currentLiveWeight = data.weight;
        const weightDisplay = document.getElementById('live-weight');
        const statusDisplay = document.getElementById('scale-status');

        if (!weightDisplay || !statusDisplay) return;

        weightDisplay.innerText = currentLiveWeight.toLocaleString('en-US').padStart(6, '0');
        if (data.stable) {
            weightDisplay.classList.add('text-green-400');
            weightDisplay.classList.remove('text-green-500');
            statusDisplay.innerText = 'PESO ESTABLE';
        } else {
            weightDisplay.classList.add('text-green-500');
            weightDisplay.classList.remove('text-green-400');
            statusDisplay.innerText = 'ESTABILIZANDO...';
        }
    });
}

async function initApp() {
    startClock();
    setupScaleListener();

    const today = getLocalIsoDate();
    ['filter-start', 'filter-end', 'corapsa-filter-start', 'corapsa-filter-end'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = today;
    });

    renderClientesTab();
    populateClienteDropdown();
    renderCorapsaTab();
    renderGastos();
    renderPlanilla();
    renderQueue();
    await fetchTransacciones();

    await Promise.allSettled([
        fetchClientes(),
        fetchCamionesEnPatio()
    ]);

    renderQueue();
}

window.addEventListener('DOMContentLoaded', initApp);