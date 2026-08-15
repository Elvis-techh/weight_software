// Durable local outbox for the three mutating patio-queue operations
// (create truck, update BRUTO/TARA, finalizar) so a power/internet outage
// never loses a truck that's mid-weighing. Queued while offline; replayed
// in strict order once the connection returns — strict order matters both
// because a queued update/finalize can target a truck whose "real" id only
// exists after its create syncs, and because numero_boleta prediction below
// depends on finalizes landing on the server in the same order they were
// predicted locally. Persisted to disk via the main process
// (offlineQueueStore.js) so an app restart after a crash doesn't lose it.
//
// Safe ONLY because this app currently has a single active writer — one
// station, one running instance. The numero_boleta prediction in particular
// relies on nothing else ever inserting a transaction concurrently. The
// moment a second concurrently-writing station exists (multi-station /
// Postgres future), this whole approach needs to be revisited.

let offlineQueue = [];
let queueInitialized = false;

function generateLocalId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isLocalOnlyTruckId(id) {
    return /^truck-/.test(String(id ?? ''));
}

async function persistOfflineQueue() {
    if (typeof window.electronAPI?.saveOfflineQueue !== 'function') return;
    try {
        await window.electronAPI.saveOfflineQueue(offlineQueue);
    } catch (error) {
        console.error('No se pudo guardar la cola local en disco:', error);
    }
}

async function initOfflineQueue() {
    if (typeof window.electronAPI?.loadOfflineQueue !== 'function') {
        queueInitialized = true;
        return;
    }
    try {
        const saved = await window.electronAPI.loadOfflineQueue();
        offlineQueue = Array.isArray(saved) ? saved : [];
    } catch (error) {
        console.error('No se pudo leer la cola local desde disco:', error);
        offlineQueue = [];
    }
    queueInitialized = true;
    renderPendingSyncBadge();
}

function renderPendingSyncBadge() {
    const badge = document.getElementById('pending-sync-badge');
    if (!badge) return;
    const count = offlineQueue.length;
    const label = badge.querySelector('[data-role="pending-sync-label"]');
    if (label) {
        label.textContent = count === 1 ? '1 cambio sin sincronizar' : `${count} cambios sin sincronizar`;
    }
    badge.classList.toggle('hidden', count === 0);
    badge.classList.toggle('flex', count > 0);
}

async function enqueueOp(op) {
    offlineQueue.push(op);
    renderPendingSyncBadge();
    await persistOfflineQueue();
}

async function removeQueuedOpsForLocalTruck(localTruckId) {
    offlineQueue = offlineQueue.filter(op => op.localTruckId !== localTruckId);
    renderPendingSyncBadge();
    await persistOfflineQueue();
}

function getClienteIdentidadLocal(clienteId, casualSnapshot) {
    if (String(clienteId) === 'casual') return casualSnapshot?.identidad || '';
    const cliente = MOCK_CLIENTES.find(item => sameRecordId(item.id, clienteId));
    return cliente?.identidad || '';
}

// Highest numero_boleta issued so far, counting both server-confirmed
// transactions and any not-yet-synced finalizes already sitting in the
// queue — so two offline finalizes in the same outage still get distinct,
// correctly-ordered numbers instead of colliding.
function getNextPredictedBoletaNumber() {
    const confirmedMax = transaccionesData.reduce(
        (max, t) => Math.max(max, Number(t.numeroBoleta) || 0), 0
    );
    const queuedMax = offlineQueue.reduce((max, op) => {
        return op.type === 'finalize' && Number.isFinite(op.predictedNumeroBoleta)
            ? Math.max(max, op.predictedNumeroBoleta)
            : max;
    }, 0);
    return Math.max(confirmedMax, queuedMax) + 1;
}

// Re-creates the optimistic, not-yet-synced patio-queue rows and receipts
// from a queue loaded off disk — needed after a restart (e.g. the app was
// killed by the same outage that took the network down), since the data
// fetched from the server can't reflect operations it never received.
function rebuildOptimisticStateFromOfflineQueue() {
    offlineQueue.forEach(op => {
        if (op.type !== 'create') return;
        if (camionesEnPatio.some(truck => sameRecordId(truck.id, op.localTruckId))) return;

        const localTruck = normalizarCamionPatio({
            ...op.payload,
            id: op.localTruckId,
            identidadSnapshot: getClienteIdentidadLocal(op.payload.clienteId, op.payload.casualSnapshot)
        });
        localTruck.pendingSync = true;
        camionesEnPatio.push(localTruck);
    });

    offlineQueue.forEach(op => {
        if (op.type !== 'update') return;
        const index = camionesEnPatio.findIndex(truck => sameRecordId(truck.id, op.localTruckId));
        if (index < 0) return;
        camionesEnPatio[index] = { ...camionesEnPatio[index], ...op.payload, pendingSync: true };
    });

    offlineQueue.forEach(op => {
        if (op.type !== 'finalize' || !op.transactionSnapshot) return;
        if (transaccionesData.some(t => sameRecordId(t.id, op.localTransactionId))) return;
        transaccionesData.unshift({ ...op.transactionSnapshot });
    });
}

// Rewrites any still-queued op that targets `oldId` (a client-generated id)
// to target `newId` (the real id the server just assigned), so a PATCH or
// finalize queued behind a not-yet-synced create still lands on the right row.
function remapLocalTruckId(oldId, newId) {
    offlineQueue.forEach(op => {
        if (op.localTruckId === oldId) op.localTruckId = newId;
    });
}

async function warnOfflineSyncIssue(message, context) {
    console.error(message, context);
    mostrarNotificacion(message, 'error');
    if (typeof window.electronAPI?.warnOfflineSyncIssue === 'function') {
        try {
            await window.electronAPI.warnOfflineSyncIssue(message);
        } catch (error) {
            console.error('No se pudo mostrar la advertencia nativa:', error);
        }
    }
}

async function replayOp(op) {
    if (op.type === 'create') {
        const result = await apiRequest('/api/camiones-patio', { method: 'POST', body: { ...op.payload, clientOpId: op.opId } });
        const savedTruck = normalizarCamionPatio(result?.camion || result);
        remapLocalTruckId(op.localTruckId, savedTruck.id);

        const index = camionesEnPatio.findIndex(truck => sameRecordId(truck.id, op.localTruckId));
        if (index >= 0) camionesEnPatio[index] = { ...savedTruck, pendingSync: false };
        if (sameRecordId(activeTransaction.id, op.localTruckId)) {
            activeTransaction = { ...activeTransaction, ...savedTruck };
        }
        return;
    }

    if (op.type === 'update') {
        const result = await apiRequest(
            `/api/camiones-patio/${encodeURIComponent(op.localTruckId)}`,
            { method: 'PATCH', body: op.payload }
        );
        const updatedTruck = normalizarCamionPatio(result?.camion || result);

        const index = camionesEnPatio.findIndex(truck => sameRecordId(truck.id, updatedTruck.id));
        if (index >= 0) camionesEnPatio[index] = { ...updatedTruck, pendingSync: false };
        if (sameRecordId(activeTransaction.id, updatedTruck.id)) {
            activeTransaction = { ...activeTransaction, ...updatedTruck };
        }
        return;
    }

    if (op.type === 'finalize') {
        const result = await apiRequest(
            `/api/camiones-patio/${encodeURIComponent(op.localTruckId)}/finalizar`,
            { method: 'POST', body: { ...op.payload, clientOpId: op.opId } }
        );
        const confirmed = normalizarTransaccion(result?.transaccion || result);

        const index = transaccionesData.findIndex(t => sameRecordId(t.id, op.localTransactionId));
        if (index >= 0) transaccionesData[index] = confirmed;
        else transaccionesData.unshift(confirmed);

        if (Number.isFinite(op.predictedNumeroBoleta) && confirmed.numeroBoleta !== op.predictedNumeroBoleta) {
            await warnOfflineSyncIssue(
                `La boleta impresa localmente como #${op.predictedNumeroBoleta} fue registrada por el servidor como #${confirmed.numeroBoleta}. Verifique manualmente cuál número es el correcto antes de entregarla o archivarla.`,
                { op, confirmed }
            );
        }

        camionesEnPatio = camionesEnPatio.filter(truck => !sameRecordId(truck.id, op.localTruckId));
        if (sameRecordId(activeTransaction.id, op.localTruckId)) limpiarFormulario();
        return;
    }

    throw new Error(`Tipo de operación desconocido en la cola local: ${op.type}`);
}

// Strictly sequential: a queued update/finalize can depend on the real id a
// preceding create receives, so ops must replay — and persist — one at a time.
//
// Re-entrant-safe via a SHARED promise, not a boolean flag: apiRequest's
// success hook (api.js) calls setServerConnectionState synchronously as soon
// as the reconnect health-check responds, which fires an unawaited
// background drain — and pollServerAndQueue then calls drainOfflineQueue
// again right after. A boolean guard would make the second call no-op
// immediately (lock already held) and race ahead to fetchCamionesEnPatio()
// before anything actually synced, clobbering local pending state. Returning
// the SAME in-flight promise instead means every caller genuinely waits for
// the one real drain to finish before doing anything that depends on it.
let drainPromise = null;

async function runDrainLoop() {
    while (offlineQueue.length > 0) {
        const op = offlineQueue[0];
        try {
            await replayOp(op);
            offlineQueue.shift();
            await persistOfflineQueue();
            renderPendingSyncBadge();
            renderQueue();
            updateReportesTab();
        } catch (error) {
            if (isConnectivityError(error)) return;

            // A real (non-connectivity) rejection — e.g. the truck was deleted
            // server-side by a direct DB edit while offline. Don't let one
            // permanently-failing op block everything queued behind it; drop
            // it, but loudly, since silently discarding it would be worse.
            await warnOfflineSyncIssue(
                `No se pudo sincronizar un cambio guardado sin conexión (${op.type}). Motivo: ${error.message || 'error desconocido'}. Revise manualmente los datos del vehículo/transacción.`,
                { op, error }
            );
            offlineQueue.shift();
            await persistOfflineQueue();
            renderPendingSyncBadge();
        }
    }
}

function drainOfflineQueue() {
    if (drainPromise) return drainPromise;
    if (!queueInitialized) return Promise.resolve();

    // .finally() here (not a try/finally inside an async body) is deliberate:
    // when the queue is empty, runDrainLoop() resolves with no `await` ever
    // reached, so its cleanup would run synchronously — BEFORE the
    // `drainPromise = ...` assignment below finishes evaluating, letting the
    // assignment overwrite the just-reset null right back to a stale promise
    // that's already settled but never cleared. .finally()'s callback is
    // always a deferred microtask, so it's guaranteed to run after this
    // assignment completes, regardless of whether the loop awaited anything.
    drainPromise = runDrainLoop().finally(() => {
        drainPromise = null;
    });

    return drainPromise;
}
