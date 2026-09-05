// ---------------------------------------------------------------------------
// What a failed request means
//
// Four SDKs, four error shapes, one question: may this be sent again, and does
// the provider want to be called less often. Everything below is structural —
// no SDK type is imported, because three of the four are optional peers and an
// error that arrives from a gateway is not an instance of anything anyway.
//
// The one difference worth naming out loud is the status field. OpenAI,
// Anthropic and @google/genai put it on `status`; the OpenRouter client, being
// generated, calls it `statusCode`. Reading only one of them reports a revoked
// key or an exhausted quota as an unknown failure, which is the same trap the
// CLI's liveness probe already documents.
// ---------------------------------------------------------------------------

/**
 * Three answers, because a limiter can only do three things: send it again
 * later and slow down, send it again later, or give up.
 */
export type Failure = 'rate-limit' | 'transient' | 'fatal';

/** The provider is asking to be called less often, not saying the call was wrong. */
const RATE_LIMITED = new Set([429, 503]);

/** Worth another attempt, but says nothing about the rate. */
const TRANSIENT = new Set([408, 409, 500, 502, 504]);

/** Undici's words for a connection that never produced a response. */
const NETWORK = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ERR_STREAM_PREMATURE_CLOSE',
]);

interface Shaped {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    headers?: unknown;
    cause?: unknown;
}

/** The error and everything it blames, guarded against a self-referential cause. */
function* chain(err: unknown): Generator<Shaped> {
    const seen = new Set<unknown>();
    for (let at = err; at && typeof at === 'object' && !seen.has(at); at = (at as Shaped).cause) {
        seen.add(at);
        yield at as Shaped;
    }
}

/** The HTTP status, wherever this vendor's SDK decided to keep it. */
export function statusOf(err: unknown): number | undefined {
    for (const link of chain(err)) {
        const raw = link.status ?? link.statusCode;
        const status = typeof raw === 'string' ? Number(raw) : raw;
        if (typeof status === 'number' && Number.isFinite(status)) {
            return status;
        }
    }
    return undefined;
}

export function classify(err: unknown): Failure {
    // An abort is the caller changing its mind, so it is never retried.
    if (isAbort(err)) {
        return 'fatal';
    }
    const status = statusOf(err);
    if (status !== undefined) {
        if (RATE_LIMITED.has(status)) {
            return 'rate-limit';
        }
        return TRANSIENT.has(status) || status >= 500 ? 'transient' : 'fatal';
    }
    for (const link of chain(err)) {
        if (typeof link.code === 'string' && NETWORK.has(link.code)) {
            return 'transient';
        }
    }
    return 'fatal';
}

export function isAbort(err: unknown): boolean {
    for (const link of chain(err)) {
        if (link.name === 'AbortError' || link.code === 'ABORT_ERR') {
            return true;
        }
    }
    return false;
}

/**
 * How long the provider asked to be left alone. Absent far more often than
 * not — only some vendors send it, and only on some of their limits — so the
 * limiter has to have a schedule of its own regardless.
 */
export function retryAfterMs(err: unknown): number | undefined {
    for (const link of chain(err)) {
        const headers = link.headers;
        if (!headers) {
            continue;
        }
        // OpenAI's own, and the more precise of the two when both are sent.
        const ms = header(headers, 'retry-after-ms');
        if (ms !== undefined) {
            const value = Number(ms);
            if (Number.isFinite(value) && value >= 0) {
                return value;
            }
        }
        const after = header(headers, 'retry-after');
        if (after === undefined) {
            continue;
        }
        // Seconds, or an HTTP date. The date form is rare but legal.
        const seconds = Number(after);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return seconds * 1000;
        }
        const at = Date.parse(after);
        if (Number.isFinite(at)) {
            return Math.max(0, at - Date.now());
        }
    }
    return undefined;
}

/** Headers arrive as a `Headers` instance from one SDK and a plain object from another. */
function header(headers: unknown, name: string): string | undefined {
    if (typeof headers !== 'object' || headers === null) {
        return undefined;
    }
    const get = (headers as { get?: unknown }).get;
    if (typeof get === 'function') {
        const value: unknown = get.call(headers, name);
        return typeof value === 'string' ? value : undefined;
    }
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === name && typeof value === 'string') {
            return value;
        }
    }
    return undefined;
}
