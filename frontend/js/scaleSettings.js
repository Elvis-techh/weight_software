let cachedScaleSettings = null;

function hasScaleSettingsBridge() {
    return Boolean(
        window.electronAPI?.getScaleSettings &&
        window.electronAPI?.saveScaleSettings &&
        window.electronAPI?.listScalePorts &&
        window.electronAPI?.testScaleConnection
    );
}

function applySimulatorControlsVisibility(testModeEnabled) {
    const controls = document.getElementById('simulator-controls');
    if (!controls) return;
    controls.classList.toggle('hidden', !testModeEnabled);
    controls.classList.toggle('flex', Boolean(testModeEnabled));
}

async function initScaleSettings() {
    if (!hasScaleSettingsBridge()) return;

    try {
        cachedScaleSettings = await window.electronAPI.getScaleSettings();
        applySimulatorControlsVisibility(cachedScaleSettings?.testModeEnabled);
    } catch (error) {
        console.error('No se pudo obtener la configuración de báscula:', error);
    }
}

async function poblarPuertosScale(selectedPath) {
    const select = document.getElementById('scale-settings-com-port');
    if (!select) return;

    select.innerHTML = '';
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = 'Sin seleccionar';
    select.appendChild(emptyOption);

    if (!hasScaleSettingsBridge()) return;

    try {
        const ports = await window.electronAPI.listScalePorts();
        (Array.isArray(ports) ? ports : []).forEach(port => {
            const option = document.createElement('option');
            option.value = port.path;
            option.textContent = port.manufacturer ? `${port.path} (${port.manufacturer})` : port.path;
            select.appendChild(option);
        });
        if (selectedPath) select.value = selectedPath;
    } catch (error) {
        // listScalePorts() only rejects on a software failure (driver/native
        // binding problem) — an empty scale with no ports resolves fine with [].
        // Say so explicitly so a technician doing first-time setup doesn't read
        // an empty dropdown as "no scale connected" and start chasing cables.
        console.error('No se pudo listar los puertos seriales:', error);
        const errorOption = document.createElement('option');
        errorOption.value = '';
        errorOption.disabled = true;
        errorOption.textContent = 'Error al escanear puertos (falla de software, no de báscula)';
        select.appendChild(errorOption);
        mostrarNotificacion(
            `No se pudo escanear los puertos seriales: ${error.message || 'error desconocido'}. ` +
            'Esto es una falla de software (controlador/driver), no necesariamente un problema con la báscula.',
            'error'
        );
    }
}

async function refrescarPuertosScale() {
    const select = document.getElementById('scale-settings-com-port');
    await poblarPuertosScale(select?.value);
}

function readScaleSettingsForm() {
    return {
        comPort: document.getElementById('scale-settings-com-port')?.value || '',
        baudRate: Number(document.getElementById('scale-settings-baud-rate')?.value) || 9600,
        parsePattern: document.getElementById('scale-settings-parse-pattern')?.value || '',
        testModeEnabled: Boolean(document.getElementById('scale-settings-test-mode')?.checked)
    };
}

async function abrirScaleSettingsModal() {
    const modal = document.getElementById('scale-settings-modal');
    if (!modal) return;

    if (!hasScaleSettingsBridge()) {
        mostrarNotificacion('La configuración de báscula no está disponible fuera de la aplicación de escritorio.', 'error');
        return;
    }

    try {
        cachedScaleSettings = await window.electronAPI.getScaleSettings();
    } catch (error) {
        console.error('No se pudo obtener la configuración de báscula:', error);
        mostrarNotificacion('No se pudo cargar la configuración de báscula.', 'error');
        return;
    }

    await poblarPuertosScale(cachedScaleSettings?.comPort);
    document.getElementById('scale-settings-baud-rate').value = String(cachedScaleSettings?.baudRate || 9600);
    document.getElementById('scale-settings-parse-pattern').value = cachedScaleSettings?.parsePattern || '';
    document.getElementById('scale-settings-test-mode').checked = Boolean(cachedScaleSettings?.testModeEnabled);
    document.getElementById('scale-settings-test-result').textContent = 'Sin probar todavía.';

    modal.classList.remove('hidden');
}

function cerrarScaleSettingsModal() {
    document.getElementById('scale-settings-modal')?.classList.add('hidden');
}

async function probarConexionScale() {
    const resultDisplay = document.getElementById('scale-settings-test-result');
    if (!hasScaleSettingsBridge() || !resultDisplay) return;

    resultDisplay.textContent = 'Probando...';
    try {
        const result = await window.electronAPI.testScaleConnection(readScaleSettingsForm());
        if (result?.ok) {
            resultDisplay.textContent = `OK — línea recibida: "${result.rawLine}" → peso interpretado: ${result.parsedWeight}`;
        } else {
            resultDisplay.textContent = `Sin lectura válida${result?.rawLine ? ` (línea: "${result.rawLine}")` : ''}${result?.error ? ` — ${result.error}` : ''}.`;
        }
    } catch (error) {
        console.error('No se pudo probar la conexión de báscula:', error);
        resultDisplay.textContent = `Error: ${error.message || 'No se pudo probar la conexión.'}`;
    }
}

async function guardarScaleSettings() {
    if (!hasScaleSettingsBridge()) return;

    const formData = readScaleSettingsForm();
    // Without a port and outside test mode, this "saves" successfully but the
    // scale will never produce a reading — same success toast as a real,
    // working save, with nothing to tell them apart. Block it instead of
    // letting that look identical to a completed setup.
    if (!formData.testModeEnabled && !formData.comPort) {
        mostrarNotificacion(
            'Seleccione un puerto COM antes de guardar, o active el modo de prueba. Sin un puerto, la báscula nunca producirá lecturas.',
            'error'
        );
        return;
    }

    try {
        const saved = await window.electronAPI.saveScaleSettings(formData);
        cachedScaleSettings = saved;
        applySimulatorControlsVisibility(saved?.testModeEnabled);
        cerrarScaleSettingsModal();
        mostrarNotificacion('Configuración de báscula guardada.');
    } catch (error) {
        console.error('No se pudo guardar la configuración de báscula:', error);
        mostrarNotificacion(error.message || 'No se pudo guardar la configuración de báscula.', 'error');
    }
}
