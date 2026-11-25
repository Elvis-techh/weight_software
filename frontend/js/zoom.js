// The header's − 100 % + control. The zoom itself belongs to the main process
// (main.js). Ctrl +, Ctrl −, Ctrl 0 and the View menu change it too, and each
// change resizes the page, so the number is read again on every resize.

async function actualizarControlZoom(action) {
    try {
        const { percent, canZoomIn, canZoomOut } = await window.electronAPI.changeZoom(action);
        const resetButton = document.getElementById('zoom-reset-button');
        resetButton.textContent = `${percent} %`;
        resetButton.setAttribute('aria-label', `Tamaño ${percent} %. Volver al 100 %`);
        document.getElementById('zoom-in-button').disabled = !canZoomIn;
        document.getElementById('zoom-out-button').disabled = !canZoomOut;
    } catch (error) {
        console.error('No se pudo cambiar el tamaño de la pantalla:', error);
    }
}

function initZoomControl() {
    const control = document.getElementById('zoom-control');
    // Only the desktop app can zoom from the page; a browser has its own zoom.
    if (!control || !window.electronAPI?.changeZoom) return;

    [['zoom-out-button', 'out'], ['zoom-reset-button', 'reset'], ['zoom-in-button', 'in']]
        .forEach(([id, action]) => {
            document.getElementById(id).addEventListener('click', () => actualizarControlZoom(action));
        });
    window.addEventListener('resize', () => actualizarControlZoom());

    control.classList.replace('hidden', 'flex');
    // The level kept from the last run is already applied; this just shows it.
    actualizarControlZoom();
}

initZoomControl();
