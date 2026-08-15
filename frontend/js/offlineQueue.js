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

// One-shot until a save succeeds again, so a persistent disk-full/permissions
// problem doesn't spam a toast on every single enqueue/replay while it lasts.
let queuePersistFailureNotified = false;

async function persistOfflineQueue() {
    if (typeof window.electronAPI?.saveOfflineQueue !== 'function') return;
    try {
        await window.electronAPI.saveOfflineQueue(offlineQueue);
        queuePersistFailureNotified = false;
    } catch (error) {
        console.error('No se pudo guardar la cola local en disco:', error);
        // Console-only was invisible on a kiosk with no DevTools open. Paired
        // with a crash right after, that silently loses whatever was queued
        // with no warning to anyone — surface it where an operator can see it.
        if (!queuePersistFailureNotified) {
            queuePersistFailureNotified = true;
            mostrarNotificacion(
                'No se pudo guardar en disco la cola de cambios sin sincronizar (¿espacio insuficiente o permisos?). ' +
                'Si la aplicación se cierra ahora, esos cambios podrían perderse.',
                'error'
            );
        }
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

// A 5xx is the server's own admission that something on its end went wrong —
// exactly as retryable as a network drop or client-side timeout, not a
// permanent rejection. Treating it as permanent (the old behavior) meant an
// ordinary transient 500 during replay got silently dropped instead of tried
// again.
function isRetryableSyncError(error) {
    if (isConnectivityError(error)) return true;
    const status = Number(error?.status);
    return Number.isFinite(status) && status >= 500;
}

function isMissingTargetError(error) {
    return Number(error?.status) === 404 || error?.code === 'NOT_FOUND';
}

// A 404 replaying 'finalize' is ambiguous: either it genuinely failed (the
// truck was deleted out-of-band), or an earlier attempt of this SAME op
// already succeeded server-side before the client's own request timed out
// waiting for the response. finalize's whole job is removing the truck from
// camiones_en_patio, so its absence — confirmed against fresh server truth,
// not the stale local state that produced the timeout — is strong evidence
// this op already went through. ('update' 404s don't get this treatment: the
// truck being gone doesn't tell us whether ITS weight value made it in
// before something else finalized the truck, so that case still needs a
// human look — see runDrainLoop.)
async function finalizeAlreadyApplied(op) {
    try {
        await fetchCamionesEnPatio();
    } catch (_) {
        return false;
    }
    if (camionesEnPatio.some(truck => sameRecordId(truck.id, op.localTruckId))) return false;

    // Truck confirmed gone — pull the real transaction list so the local
    // optimistic entry (added with pendingSync:true and a locally-predicted
    // numero_boleta) gets replaced by the server's authoritative record
    // instead of sitting there forever looking unsynced.
    try {
        await fetchTransacciones();
    } catch (error) {
        console.error('No se pudo confirmar la transacción tras un 404 en la cola:', error);
    }
    return true;
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
        let refreshViews = false;
        try {
            await replayOp(op);
            refreshViews = true;
        } catch (error) {
            if (isRetryableSyncError(error)) return;

            if (op.type === 'finalize' && isMissingTargetError(error) && await finalizeAlreadyApplied(op)) {
                // Already reconciled from server truth inside finalizeAlreadyApplied()
                // (including its own re-renders) — nothing more to do for this op.
            } else {
                // A real, non-retryable failure — e.g. the truck was deleted
                // server-side by a direct DB edit while offline. Don't let one
                // permanently-failing op block everything queued behind it;
                // drop it, but loudly, since silently discarding it would be worse.
                await warnOfflineSyncIssue(
                    `No se pudo sincronizar un cambio guardado sin conexión (${op.type}). Motivo: ${error.message || 'error desconocido'}. Revise manualmente los datos del vehículo/transacción.`,
                    { op, error }
                );
            }
        }

        // Re-render calls live outside the try/catch on purpose: if one of
        // them ever threw, the catch above would misattribute the failure to
        // `op` — including dropping it — even though `op` itself already
        // synced fine (or was never even attempted).
        offlineQueue.shift();
        await persistOfflineQueue();
        renderPendingSyncBadge();
        if (refreshViews) {
            renderQueue();
            updateReportesTab();
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
