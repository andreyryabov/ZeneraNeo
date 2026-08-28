import { ModelRegistry } from 'zenera-neo';
import { SHAPES, type KeyCheck, type KeyEntry, type KeyStore, type Provider } from './keys.ts';

// ---------------------------------------------------------------------------
// Liveness
//
// The distinction that matters in the output is *dead* — the provider looked at
// the credential and said no — versus *unknown* — we could not ask. Collapsing
// them into one red mark is the classic way to send someone hunting for the
// wrong bug: rotating a perfectly good key because the office wifi was down.
// ---------------------------------------------------------------------------

/** Words a provider uses when the credential itself is the problem. */
const REJECTED = [
    'invalid_api_key',
    'invalid api key',
    'incorrect api key',
    'authentication',
    'unauthenticated',
    'unauthorized',
    'permission_denied',
    'permission denied',
    'api key not valid',
    'could not load the default credentials',
];

/** Words that mean the question never arrived. */
const UNREACHED = [
    'enotfound',
    'econnrefused',
    'econnreset',
    'etimedout',
    'eai_again',
    'fetch failed',
    'network',
    'timeout',
    'socket hang up',
];

function classify(err: unknown): KeyCheck {
    const at = new Date().toISOString();
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : String(err);
    const haystack = `${status ?? ''} ${message}`.toLowerCase();

    if (status === 401 || status === 403) {
        return { state: 'dead', at, detail: `${status} ${firstLine(message)}` };
    }
    if (REJECTED.some((needle) => haystack.includes(needle))) {
        return { state: 'dead', at, detail: firstLine(message) };
    }
    if (UNREACHED.some((needle) => haystack.includes(needle))) {
        return { state: 'unknown', at, detail: 'could not reach the provider' };
    }
    // 429 means the credential authenticated and then got rate limited, which
    // is a live key having a bad day.
    if (status === 429) {
        return { state: 'live', at, detail: 'rate limited, but authenticated' };
    }
    return { state: 'unknown', at, detail: firstLine(message) };
}

const firstLine = (s: string): string => s.split('\n')[0].slice(0, 160);

/**
 * The cheapest authenticated call each SDK has. Nothing here reads a model or
 * spends a token: the question is only whether the credential is accepted.
 *
 * The client is built through the library's own registry rather than by
 * requiring the SDKs directly, so a missing optional dependency produces the
 * library's "run: npm i openai" message instead of a raw MODULE_NOT_FOUND.
 */
export async function probe(store: KeyStore, entry: KeyEntry): Promise<KeyCheck> {
    const shape = SHAPES[entry.provider];
    const previous = process.env[shape.env];
    process.env[shape.env] = store.reveal(entry);
    try {
        const registry = new ModelRegistry();
        registry.provider('probe', { kind: entry.provider });
        await authenticate(entry.provider, registry.client('probe'));
        return { state: 'live', at: new Date().toISOString() };
    } catch (err) {
        return classify(err);
    } finally {
        if (previous === undefined) {
            delete process.env[shape.env];
        } else {
            process.env[shape.env] = previous;
        }
    }
}

/**
 * Every vendor SDK here exposes `models.list`, but they disagree about the
 * argument and about what comes back, so the shapes are described structurally
 * rather than by importing sets of types the CLI otherwise has no use for.
 */
interface ListsModels {
    models: { list(args?: unknown): unknown };
}

/** The OpenAI client's escape hatch to a path the resource layer does not model. */
interface GetsPaths {
    get(path: string): Promise<unknown>;
}

async function authenticate(provider: Provider, client: unknown): Promise<void> {
    // OpenRouter's model catalog is *public*: it answers 200 to a request
    // carrying no key at all, so listing it would report every credential live,
    // including a revoked one. `/key` describes the key that asked and is the
    // only cheap call that actually looks at it.
    if (provider === 'openrouter') {
        await (client as GetsPaths).get('/key');
        return;
    }

    const args =
        provider === 'anthropic'
            ? { limit: 1 }
            : provider === 'google' || provider === 'vertex'
              ? { config: { pageSize: 1 } }
              : undefined;
    const result = await (client as ListsModels).models.list(args);
    // OpenAI and Anthropic resolve to a page; the GenAI SDK resolves to a lazy
    // pager whose first fetch has already happened by the time we get here.
    void result;
}

/**
 * Probes many entries at once — one round trip each, all in flight together.
 * Pairs rather than a map, because the caller needs the entry itself to record
 * the result against, and a map keyed by a string would only have to be
 * un-joined again.
 */
export async function probeAll(
    store: KeyStore,
    entries: readonly KeyEntry[],
): Promise<[KeyEntry, KeyCheck][]> {
    return Promise.all(
        entries.map(async (e) => [e, await probe(store, e)] as [KeyEntry, KeyCheck]),
    );
}
