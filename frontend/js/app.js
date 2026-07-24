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

// --- SIMULADOR DE BÁSCULA ---
function iniciarSimuladorBascula() {
    console.log("Simulador de báscula iniciado...");

    // Updates the weight every 1.5 seconds to mimic a fluctuating scale
    setInterval(() => {
        // Generates a random weight between 20,000 and 20,500 LBS
        const baseWeight = 20000;
        const fluctuation = Math.floor(Math.random() * 500);
        const simulatedWeight = baseWeight + fluctuation;

        // 1. Update the global variable that your Bruto/Tara buttons look for
        window.currentLiveWeight = simulatedWeight;

        // 2. Update the green UI display in the top right corner
        const weightDisplay = document.getElementById('live-weight');
        const statusDisplay = document.getElementById('scale-status');

        if (weightDisplay) {
            weightDisplay.innerText = simulatedWeight.toLocaleString('en-US').padStart(6, '0');
            weightDisplay.classList.add('text-green-400');
            weightDisplay.classList.remove('text-green-500');
        }
        if (statusDisplay) {
            statusDisplay.innerText = 'PESO ESTABLE (SIMULADO)';
        }
    }, 1500);
}

async function initApp() {
    startClock();
    setupScaleListener();

    iniciarSimuladorBascula();

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