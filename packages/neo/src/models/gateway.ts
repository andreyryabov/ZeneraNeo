import type { ProviderKind } from './factory.ts';

// ---------------------------------------------------------------------------
// Gateway mode
//
// With `BIFROST_BASE_URL` set, every provider is reached through one Bifrost
// gateway and one virtual key, and `agents.yaml` does not change: a
// `vertex:gemini-3.5-flash` still goes out through the GenAI SDK, in Gemini's
// own wire format, only to Bifrost's `/genai` drop-in endpoint instead of to
// Google. Keeping each vendor's protocol is the point — Bifrost's unified
// chat-completions endpoint would cost the thinking budgets, thought signatures
// and cache accounting the native adapters exist for.
//
// The switch is the environment rather than the config because it describes the
// machine, not the project: the same project runs direct on a laptop with
// vendor keys and through the gateway on a machine that only holds a virtual
// key.
// ---------------------------------------------------------------------------

export const GATEWAY_NAME = 'bifrost';
export const GATEWAY_URL_ENV = 'BIFROST_BASE_URL';
export const GATEWAY_KEY_ENV = 'BIFROST_API_KEY';

/** Bifrost's own virtual-key header: still read when `Authorization` is taken by gateway login. */
export const GATEWAY_KEY_HEADER = 'x-bf-vk';

export interface Gateway {
    /** no trailing slash */
    baseURL: string;
    /** the virtual key; absent for a gateway that enforces none */
    apiKey?: string;
}

/** The gateway this process is configured for, or undefined when vendors are called directly. */
export function gatewayOf(): Gateway | undefined {
    const url = process.env[GATEWAY_URL_ENV]?.trim();
    if (!url) {
        return undefined;
    }
    const apiKey = process.env[GATEWAY_KEY_ENV]?.trim();
    return { baseURL: url.replace(/\/+$/, ''), ...(apiKey ? { apiKey } : {}) };
}

/** The wire formats Bifrost has a drop-in endpoint for. */
export type GatewayProtocol = 'openai' | 'anthropic' | 'gemini';

export const GATEWAY_PATHS: Record<GatewayProtocol, string> = {
    openai: '/openai',
    anthropic: '/anthropic',
    gemini: '/genai',
};

/** Bifrost's name for the upstream each kind reaches; it routes on `<upstream>/<model>`. */
export const GATEWAY_UPSTREAMS: Record<ProviderKind, string> = {
    openai: 'openai',
    'openai-compatible': 'openai',
    anthropic: 'anthropic',
    google: 'gemini',
    vertex: 'vertex',
    openrouter: 'openrouter',
};

const MODEL_PATH = /\/models\/([^/:?]+):(\w+)/;

/**
 * Qualifies the model id on the wire only. A `Model`'s or `Embedder`'s id stays
 * the one the config names, because a memory or an index records the embedder
 * id and refuses a different one — flipping gateway mode must not orphan them.
 *
 * Gemini names its model in the url; the other two in the body. `inner` is
 * resolved per call so a stubbed global `fetch` is honoured.
 */
export function upstreamFetch(
    upstream: string,
    protocol: GatewayProtocol,
    inner?: typeof fetch,
): typeof fetch {
    const prefix = `${upstream}/`;
    const qualify = (id: string): string => (id.startsWith(prefix) ? id : prefix + id);
    return async (input, init) => {
        const send = inner ?? fetch;
        const body =
            typeof init?.body === 'string' ? qualifyBody(init.body, protocol, qualify) : init?.body;
        if (protocol !== 'gemini') {
            return send(input, body === init?.body ? init : { ...init, body });
        }
        const url = input instanceof Request ? input.url : String(input);
        const routed = url.replace(
            MODEL_PATH,
            (_match, id: string, verb: string) => `/models/${qualify(id)}:${verb}`,
        );
        return send(routed, { ...init, body });
    };
}

function qualifyBody(body: string, protocol: GatewayProtocol, qualify: (id: string) => string) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return body;
    }
    if (!parsed || typeof parsed !== 'object') {
        return body;
    }
    const doc = parsed as { model?: unknown; requests?: unknown };
    if (protocol !== 'gemini') {
        if (typeof doc.model !== 'string') {
            return body;
        }
        doc.model = qualify(doc.model);
        return JSON.stringify(doc);
    }
    // batchEmbedContents repeats the model per request, as `models/<id>`.
    if (!Array.isArray(doc.requests)) {
        return body;
    }
    for (const request of doc.requests as { model?: unknown }[]) {
        const id = typeof request?.model === 'string' ? /^models\/(.+)$/.exec(request.model) : null;
        if (id) {
            request.model = `models/${qualify(id[1]!)}`;
        }
    }
    return JSON.stringify(doc);
}
