class ApiError extends Error {
    constructor(message, { status = 0, code = 'UNKNOWN_ERROR', details = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

async function apiRequest(path, {
    method = 'GET',
    body,
    timeoutMs = 10000,
    headers = {}
} = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new ApiError('La ruta solicitada no es válida.', { code: 'INVALID_PATH' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const hasBody = body !== undefined && body !== null;

    try {
        const response = await fetch(`${API_URL}${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                'X-API-Key': API_KEY,
                'X-Terminal-Id': TERMINAL_ID,
                ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
                ...headers
            },
            body: hasBody ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });

        // Any HTTP response at all — even a 4xx/5xx — proves the server was
        // reachable, which is what the connection indicator cares about.
        if (typeof setServerConnectionState === 'function') setServerConnectionState(true);

        if (response.status === 204) return null;

        const rawText = await response.text();
        let payload = null;

        if (rawText) {
            try {
                payload = JSON.parse(rawText);
            } catch (_) {
                payload = { message: rawText };
            }
        }

        if (!response.ok || payload?.ok === false) {
            throw new ApiError(
                payload?.error?.message || payload?.message || `Error HTTP ${response.status}`,
                {
                    status: response.status,
                    code: payload?.error?.code || 'HTTP_ERROR',
                    details: payload?.error?.details ?? null
                }
            );
        }

        return payload?.ok === true ? payload.data : payload;
    } catch (error) {
        if (error?.name === 'AbortError') {
            if (typeof setServerConnectionState === 'function') setServerConnectionState(false);
            throw new ApiError('El servidor tardó demasiado en responder.', {
                code: 'REQUEST_TIMEOUT'
            });
        }

        if (error instanceof ApiError) throw error;

        if (typeof setServerConnectionState === 'function') setServerConnectionState(false);
        throw new ApiError('No fue posible conectar con el servidor.', {
            code: 'NETWORK_ERROR',
            details: error?.message || String(error)
        });
    } finally {
        clearTimeout(timeoutId);
    }
}