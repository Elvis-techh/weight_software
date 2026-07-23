class ApiError extends Error {
    constructor(message, { status = 0, code = 'UNKNOWN_ERROR', details = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

async function apiRequest(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${API_URL}${path}`, {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal
        });

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
                    details: payload?.error?.details || null
                }
            );
        }

        return payload?.ok === true ? payload.data : payload;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new ApiError('El servidor tardó demasiado en responder.', {
                code: 'REQUEST_TIMEOUT'
            });
        }

        if (error instanceof ApiError) throw error;

        throw new ApiError('No fue posible conectar con el servidor.', {
            code: 'NETWORK_ERROR',
            details: error.message
        });
    } finally {
        clearTimeout(timeoutId);
    }
}