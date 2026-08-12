// Shared "preview before printing" modal, used by both the single-receipt
// print (frontend/receipt/receipt.html) and the filtered-list print
// (frontend/receipt/listado.html). The iframe always loads the exact same
// file main.js prints from, so the preview and the printed page can never
// drift apart — this file only owns showing/hiding/scaling the modal and
// wiring Cancelar/Imprimir; each caller supplies its own printAction(), which
// does the real window.electronAPI.print*() call and its own result/error
// handling (pdf-fallback toast, pendingSync warning, etc).
const PRINT_PREVIEW_TEMPLATES = {
    receipt: { src: 'receipt/receipt.html', setter: 'setReceiptData', width: 794, height: 1123 },
    listado: { src: 'receipt/listado.html', setter: 'setListadoData', width: 1123, height: 794 }
};

let previewLoadedTemplateKey = null;
let previewLoadPromise = null;
let previewPrintAction = null;
let previewResizeHandler = null;

function getPreviewFrame() {
    return document.getElementById('print-preview-frame');
}

// Resolves once the iframe is showing the requested template, reusing the
// already-loaded document (and just re-invoking its setter) whenever the
// same template is previewed again back-to-back, instead of reloading it.
function ensureTemplateLoaded(templateKey) {
    const frame = getPreviewFrame();
    const config = PRINT_PREVIEW_TEMPLATES[templateKey];

    if (previewLoadedTemplateKey === templateKey && frame.contentWindow?.[config.setter]) {
        return Promise.resolve();
    }

    if (previewLoadPromise && previewLoadedTemplateKey === templateKey) {
        return previewLoadPromise;
    }

    previewLoadedTemplateKey = templateKey;
    previewLoadPromise = new Promise((resolve, reject) => {
        frame.onload = () => resolve();
        frame.onerror = () => reject(new Error('No se pudo cargar la vista previa.'));
        frame.src = config.src;
    });

    return previewLoadPromise;
}

function applyPreviewScale() {
    const frame = getPreviewFrame();
    const wrapper = document.getElementById('print-preview-scale-wrapper');
    const viewport = document.getElementById('print-preview-viewport');
    const config = PRINT_PREVIEW_TEMPLATES[previewLoadedTemplateKey];
    if (!config) return;

    frame.style.width = `${config.width}px`;
    frame.style.height = `${config.height}px`;

    const availableWidth = viewport.clientWidth - 32;
    const availableHeight = viewport.clientHeight - 32;
    const scale = Math.min(availableWidth / config.width, availableHeight / config.height, 1);

    frame.style.transform = `scale(${scale})`;
    frame.style.transformOrigin = 'top left';
    wrapper.style.width = `${config.width * scale}px`;
    wrapper.style.height = `${config.height * scale}px`;
}

function setPreviewConfirmBusy(busy) {
    const button = document.getElementById('print-preview-confirm');
    const label = document.getElementById('print-preview-confirm-label');
    button.disabled = busy;
    label.textContent = busy ? 'Imprimiendo...' : 'Imprimir';
}

// options: { template: 'receipt'|'listado', payload, title, printAction }
// printAction is an async () => {...} that performs the real print IPC call
// and any result/error notifications specific to that feature.
async function mostrarVistaPrevia({ template, payload, title, printAction }) {
    const config = PRINT_PREVIEW_TEMPLATES[template];
    if (!config) throw new Error(`Plantilla de vista previa desconocida: ${template}`);

    document.getElementById('print-preview-title').textContent = title || 'Vista previa';
    previewPrintAction = printAction;
    setPreviewConfirmBusy(false);
    document.getElementById('print-preview-modal').classList.remove('hidden');

    try {
        await ensureTemplateLoaded(template);
        getPreviewFrame().contentWindow[config.setter](payload);
        applyPreviewScale();
    } catch (error) {
        console.error('Error al preparar la vista previa:', error);
        mostrarNotificacion(error.message || 'No se pudo preparar la vista previa.', 'error');
        cerrarVistaPrevia();
        return;
    }

    if (!previewResizeHandler) {
        previewResizeHandler = () => applyPreviewScale();
        window.addEventListener('resize', previewResizeHandler);
    }
}

function cerrarVistaPrevia() {
    document.getElementById('print-preview-modal').classList.add('hidden');
    previewPrintAction = null;

    if (previewResizeHandler) {
        window.removeEventListener('resize', previewResizeHandler);
        previewResizeHandler = null;
    }
}

async function confirmarImpresionVistaPrevia() {
    if (typeof previewPrintAction !== 'function') return;

    const action = previewPrintAction;
    setPreviewConfirmBusy(true);
    try {
        await action();
        cerrarVistaPrevia();
    } catch (error) {
        console.error('Error al imprimir:', error);
        mostrarNotificacion(error.message || 'No se pudo imprimir el documento.', 'error');
    } finally {
        setPreviewConfirmBusy(false);
    }
}
