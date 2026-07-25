let unsubscribeScaleData = null;
let browserScaleFallbackTimer = null;
let browserSimulationPreset = 'loaded';

const BROWSER_SCALE_PRESETS = Object.freeze({
    loaded: { weight: 20500, label: 'CARGADO' },
    empty: { weight: 8500, label: 'VACÍO' }
});

async function fetchClientes() {
    const records = await apiRequest('/api/clientes');
    MOCK_CLIENTES = Array.isArray(records) ? records.map(normalizarCliente) : [];
    renderClientesTab();
    populateClienteDropdown();
    renderQueue();
}

async function fetchCamionesEnPatio() {
    const records = await apiRequest('/api/camiones-patio');
    camionesEnPatio = Array.isArray(records) ? records.map(normalizarCamionPatio) : [];
    renderQueue();
}

async function fetchTransacciones() {
    const records = await apiRequest('/api/transacciones');
    transaccionesData = Array.isArray(records) ? records.map(normalizarTransaccion) : [];
    updateReportesTab();
}

async function fetchCorapsa() {
    const records = await apiRequest('/api/corapsa');
    corapsaData = Array.isArray(records) ? records.map(normalizarCorapsa) : [];
    renderCorapsaTab();
}

async function fetchGastos() {
    const records = await apiRequest('/api/gastos');
    gastosData = Array.isArray(records) ? records.map(normalizarGasto) : [];
    renderGastos();
}

async function fetchPlanilla() {
    const range = getPlanillaSelectedRange();
    if (!range) {
        planillaData = [];
        renderPlanilla();
        return;
    }

    const result = await apiRequest(
        `/api/planilla/resumen?inicio=${encodeURIComponent(range.start)}&fin=${encodeURIComponent(range.end)}`
    );
    const records = Array.isArray(result?.trabajadores) ? result.trabajadores : [];
    planillaData = records.map(normalizarTrabajador);
    renderPlanilla();
}

function getScaleSourceLabel(source) {
    if (source === 'simulator:empty' || source === 'browser-simulator:empty') {
        return 'PESO ESTABLE (SIMULADO - VACÍO)';
    }
    if (source === 'simulator:loaded' || source === 'browser-simulator:loaded') {
        return 'PESO ESTABLE (SIMULADO - CARGADO)';
    }
    return currentScaleStable ? 'PESO ESTABLE' : 'ESTABILIZANDO...';
}

function updateSimulatorButtons(activePreset) {
    ['loaded', 'empty'].forEach(preset => {
        const button = document.getElementById(`simulator-${preset}-button`);
        if (!button) return;
        const active = preset === activePreset;
        button.classList.toggle('bg-green-500', active);
        button.classList.toggle('text-white', active);
        button.classList.toggle('bg-gray-700', !active);
        button.classList.toggle('text-gray-200', !active);
    });
}

function renderScaleReading(data) {
    setLiveScaleData(data);

    const weightDisplay = document.getElementById('live-weight');
    const statusDisplay = document.getElementById('scale-status');
    const sourceDisplay = document.getElementById('scale-source-label');
    if (!weightDisplay || !statusDisplay) return;

    weightDisplay.textContent = currentLiveWeight
        .toLocaleString('en-US')
        .padStart(6, '0');

    weightDisplay.classList.toggle('text-green-400', currentScaleStable);
    weightDisplay.classList.toggle('text-green-500', !currentScaleStable);
    statusDisplay.textContent = getScaleSourceLabel(String(data?.source || ''));

    const preset = String(data?.preset || String(data?.source || '').split(':')[1] || '');
    if (preset) updateSimulatorButtons(preset);

    if (sourceDisplay) {
        sourceDisplay.textContent = String(data?.source || '').includes('simulator')
            ? 'SIMULADOR DE BÁSCULA'
            : 'LECTURA DE BÁSCULA';
    }
}

function emitBrowserSimulationReading() {
    const preset = BROWSER_SCALE_PRESETS[browserSimulationPreset];
    const jitter = Math.floor(Math.random() * 5) - 2;
    renderScaleReading({
        weight: preset.weight + jitter,
        stable: true,
        source: `browser-simulator:${browserSimulationPreset}`,
        preset: browserSimulationPreset
    });
}

function startBrowserScaleFallback() {
    stopBrowserScaleFallback();
    emitBrowserSimulationReading();
    browserScaleFallbackTimer = setInterval(emitBrowserSimulationReading, 500);
}

function stopBrowserScaleFallback() {
    if (!browserScaleFallbackTimer) return;
    clearInterval(browserScaleFallbackTimer);
    browserScaleFallbackTimer = null;
}

async function setScaleSimulatorPreset(preset) {
    if (!Object.hasOwn(BROWSER_SCALE_PRESETS, preset)) {
        return mostrarNotificacion('Preset de simulación inválido.', 'error');
    }

    try {
        browserSimulationPreset = preset;
        updateSimulatorButtons(preset);

        if (window.electronAPI?.setScaleSimulationPreset) {
            await window.electronAPI.setScaleSimulationPreset(preset);
        } else {
            emitBrowserSimulationReading();
        }

        mostrarNotificacion(
            preset === 'loaded'
                ? 'Simulador ajustado a camión cargado.'
                : 'Simulador ajustado a camión vacío.'
        );
    } catch (error) {
        console.error('No se pudo cambiar el simulador:', error);
        mostrarNotificacion(error.message || 'No se pudo cambiar el simulador.', 'error');
    }
}

function setupScaleListener() {
    if (window.electronAPI?.onScaleData) {
        unsubscribeScaleData = window.electronAPI.onScaleData(renderScaleReading);
        return;
    }

    console.warn('Electron IPC no está disponible. Se usará el simulador del navegador.');
    startBrowserScaleFallback();
}

function setDefaultDateFilters() {
    const today = getLocalIsoDate();
    [
        'filter-start',
        'filter-end',
        'corapsa-filter-start',
        'corapsa-filter-end',
        'gastos-filter-start',
        'gastos-filter-end'
    ].forEach(id => {
        const input = document.getElementById(id);
        if (input && !input.value) input.value = today;
    });

    const currentMonth = getCurrentMonthRange();
    const overviewStart = document.getElementById('overview-filter-start');
    const overviewEnd = document.getElementById('overview-filter-end');
    if (overviewStart && !overviewStart.value) overviewStart.value = currentMonth.start;
    if (overviewEnd && !overviewEnd.value) overviewEnd.value = currentMonth.end;

    const currentWeek = getCurrentWeekRange();
    const planillaStart = document.getElementById('planilla-filter-start');
    const planillaEnd = document.getElementById('planilla-filter-end');
    if (planillaStart && !planillaStart.value) planillaStart.value = currentWeek.start;
    if (planillaEnd && !planillaEnd.value) planillaEnd.value = currentWeek.end;
}

function renderInitialState() {
    renderClientesTab();
    populateClienteDropdown();
    renderCorapsaTab();
    renderGastos();
    renderPlanilla();
    renderOverview();
    renderQueue();
    updateReportesTab();
    updateSimulatorButtons('loaded');
}

async function initApp() {
    startClock();
    setupScaleListener();
    setDefaultDateFilters();
    renderInitialState();

    const loaders = [
        ['clientes', fetchClientes],
        ['camiones en patio', fetchCamionesEnPatio],
        ['transacciones', fetchTransacciones],
        ['Corapsa', fetchCorapsa],
        ['gastos', fetchGastos],
        ['planilla', fetchPlanilla],
        ['overview', fetchOverview]
    ];

    const results = await Promise.allSettled(loaders.map(([, loader]) => loader()));
    const failed = results
        .map((result, index) => ({ result, label: loaders[index][0] }))
        .filter(item => item.result.status === 'rejected');

    failed.forEach(item => {
        console.error(`No se pudo cargar ${item.label}:`, item.result.reason);
    });

    if (failed.length > 0) {
        mostrarNotificacion(
            `No se pudieron sincronizar ${failed.length} módulo(s). Revise el servidor.`,
            'error'
        );
    }
}

window.addEventListener('DOMContentLoaded', initApp, { once: true });
window.addEventListener('beforeunload', () => {
    unsubscribeScaleData?.();
    unsubscribeScaleData = null;
    stopBrowserScaleFallback();
});