function initApp() {
    startClock();
    fetchClientes();
    renderClientesTab();
    populateClienteDropdown();

    async function fetchClientes() {
        try {
            const response = await fetch(`${API_URL}/api/clientes`);
            if (response.ok) {
                const clientesDelServidor = await response.json();
                MOCK_CLIENTES = clientesDelServidor;
                renderClientesTab();
                populateClienteDropdown();
                console.log("Datos de clientes sincronizados con el servidor.");
            } else {
                mostrarNotificacion("Error al obtener datos del servidor.", "error");
            }
        } catch (error) {
            console.error("Sin conexión a la nube:", error);
            mostrarNotificacion("Trabajando en modo local (Sin conexión).", "error");
        }
    }

    const today = getLocalIsoDate();
    document.getElementById('filter-start').value = today;
    document.getElementById('filter-end').value = today;

    // Preload Electron API Bridge Listeners
    if (window.electronAPI) {
        window.electronAPI.onScaleData((data) => {
            currentLiveWeight = data.weight;
            const weightDisplay = document.getElementById('live-weight');
            const statusDisplay = document.getElementById('scale-status');

            weightDisplay.innerText = currentLiveWeight.toLocaleString('en-US').padStart(6, '0');
            if (data.stable) {
                weightDisplay.classList.add('text-green-400');
                weightDisplay.classList.remove('text-green-500');
                statusDisplay.innerText = "PESO ESTABLE";
            } else {
                weightDisplay.classList.add('text-green-500');
                weightDisplay.classList.remove('text-green-400');
                statusDisplay.innerText = "ESTABILIZANDO...";
            }
        });
    }
}

window.onload = initApp;