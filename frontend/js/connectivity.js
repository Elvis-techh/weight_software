// Tracks whether the app can currently reach the backend, drives the header
// status pill, and periodically refreshes the patio queue so a terminal
// isn't left showing a stale list after another terminal changes it.
// Two things feed the "online" verdict: (1) every apiRequest() call, live,
// as the operator actually uses the app (see api.js), and (2) this poll,
// which keeps checking even when nobody is clicking anything so a lost or
// restored connection is caught within one interval either way.
const SERVER_POLL_INTERVAL_MS = 15000;

let serverOnline = true;
let serverPollTimer = null;
let pollInFlight = false;

function isConnectivityError(error) {
    return error?.code === 'NETWORK_ERROR' || error?.code === 'REQUEST_TIMEOUT';
}

function renderServerStatus() {
    const indicator = document.getElementById('server-status-indicator');
    if (!indicator) return;

    const dot = indicator.querySelector('[data-role="status-dot"]');
    const label = indicator.querySelector('[data-role="status-label"]');

    indicator.classList.toggle('bg-green-50', serverOnline);
    indicator.classList.toggle('text-green-700', serverOnline);
    indicator.classList.toggle('border-green-200', serverOnline);
    indicator.classList.toggle('bg-red-50', !serverOnline);
    indicator.classList.toggle('text-red-700', !serverOnline);
    indicator.classList.toggle('border-red-200', !serverOnline);

    if (dot) {
        dot.classList.toggle('bg-green-500', serverOnline);
        dot.classList.toggle('animate-pulse', serverOnline);
        dot.classList.toggle('bg-red-500', !serverOnline);
    }
    if (label) label.textContent = serverOnline ? 'Servidor Conectado' : 'Sin Conexión al Servidor';
}

// Called from api.js on every request's outcome, and from the poll below.
// Only actual transitions notify — a call that confirms the current state
// (e.g. another successful request while already online) stays silent.
function setServerConnectionState(online) {
    if (online === serverOnline) return;
    serverOnline = online;
    renderServerStatus();
    mostrarNotificacion(
        online
            ? 'Conexión con el servidor restablecida. Sincronizando...'
            : 'Sin conexión con el servidor. Los cambios no se están guardando.',
        online ? 'success' : 'error'
    );

    // Reconnect must drain any locally-queued operations (see offlineQueue.js)
    // BEFORE refreshing from the server — a plain refetch first would overwrite
    // not-yet-synced local rows with the server's (still incomplete) truth.
    if (online) {
        (async () => {
            try {
                await drainOfflineQueue?.();
            } catch (error) {
                console.error('No se pudo sincronizar la cola local tras reconectar:', error);
            }
            retryFailedInitialLoads?.().catch(error => console.error('No se pudo recuperar módulos pendientes tras reconectar:', error));
            fetchCamionesEnPatio?.().catch(error => console.error('No se pudo recargar la cola tras reconectar:', error));
        })();
    }
}

async function pollServerAndQueue() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
        // A dedicated, side-effect-free probe — deliberately not the queue
        // fetch itself, so connectivity is confirmed before anything queued
        // locally gets drained, and before a full refetch can clobber it.
        await apiRequest('/api/health');
    } catch (error) {
        setServerConnectionState(false);
        pollInFlight = false;
        return;
    }

    // Past this point the server is provably reachable, so a failure below is
    // about that specific call — not connectivity. Keeping these inside the
    // catch above meant any one of them failing flipped the header to "Sin
    // Conexión" and fired a false toast while the server was fine.
    setServerConnectionState(true);
    try {
        await drainOfflineQueue?.();
        await retryFailedInitialLoads?.();
        await fetchCamionesEnPatio();
    } catch (error) {
        console.error('Fallo al sincronizar tras confirmar la conexión:', error);
    } finally {
        pollInFlight = false;
    }
}

function startServerPolling() {
    stopServerPolling();
    pollServerAndQueue();
    serverPollTimer = setInterval(pollServerAndQueue, SERVER_POLL_INTERVAL_MS);
}

function stopServerPolling() {
    if (serverPollTimer) clearInterval(serverPollTimer);
    serverPollTimer = null;
}
