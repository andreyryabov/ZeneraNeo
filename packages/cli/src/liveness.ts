import { EXA_BASE_URL, ModelRegistry } from 'zenera-neo';
import {
    SHAPES,
    type KeyCheck,
    type KeyEntry,
    type KeyStore,
    type Provider,
    type Service,
} from './keys.ts';

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
    // OpenAI, Anthropic and the GenAI SDK all say `status`; OpenRouter's says
    // `statusCode`. Reading only the first would classify a revoked key as
    // *unknown*, which is the one confusion this module exists to prevent.
    const e = err as { status?: number; statusCode?: number };
    const status = e?.status ?? e?.statusCode;
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

// ---------------------------------------------------------------------------
// Deadline
//
// Every SDK here retries, and some of them retry a connection that will never
// be answered — a proxy that swallows packets, a VPN half up. Left alone that
// is a `zen key check` which never returns, and a command that hangs teaches
// nobody anything. The credential question is one round trip; if it has not
// been answered by now, the honest answer is *unknown*.
// ---------------------------------------------------------------------------

const DEADLINE_MS = 15_000;

class Deadline extends Error {}

async function within<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Deadline()), DEADLINE_MS);
                // The abandoned request must not keep the process alive.
                timer.unref?.();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

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
    if (shape.kind === 'service') {
        return probeService(entry.provider as Service, store.reveal(entry));
    }
    const previous = process.env[shape.env];
    process.env[shape.env] = store.reveal(entry);
    try {
        const registry = new ModelRegistry();
        registry.provider('probe', { kind: entry.provider as Provider });
        await within(authenticate(entry.provider as Provider, registry.client('probe')));
        return { state: 'live', at: new Date().toISOString() };
    } catch (err) {
        if (err instanceof Deadline) {
            return {
                state: 'unknown',
                at: new Date().toISOString(),
                detail: `no answer in ${DEADLINE_MS / 1000}s`,
            };
        }
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
 * A service has no model catalog to list, and its cheapest endpoint is one that
 * bills. So the question is asked with a request that cannot succeed: an empty
 * body. Authentication is checked before the body is, which makes the two
 * refusals say different things — a rejected key never gets far enough to be
 * told its body is wrong, and a good key is told nothing else.
 *
 *   401 INVALID_API_KEY     → dead
 *   400 INVALID_REQUEST_BODY → live, and free
 *
 * Anything else is left to `classify`, which already knows how to tell a
 * refusal from an unreachable host.
 */
async function probeService(service: Service, key: string): Promise<KeyCheck> {
    const at = new Date().toISOString();
    // One service so far, and a switch rather than an `if`, so the next one is
    // added where it belongs instead of alongside.
    const url = { exa: `${EXA_BASE_URL}/contents` }[service];
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key },
            body: '{}',
            signal: AbortSignal.timeout(DEADLINE_MS),
        });
        if (res.status === 401 || res.status === 403) {
            return { state: 'dead', at, detail: `${res.status} ${await said(res)}` };
        }
        // 402 is a key the vendor recognised and then declined to serve. It
        // authenticated; the account behind it is out of money, which is a
        // different problem and one no amount of rotating the key will fix.
        if (res.status === 402) {
            return { state: 'live', at, detail: await said(res) };
        }
        if (res.status === 400 || res.ok) {
            return { state: 'live', at };
        }
        return { state: 'unknown', at, detail: `${res.status} ${await said(res)}` };
    } catch (err) {
        return classify(err);
    }
}

/** The vendor's own sentence about a refusal, when the body carries one. */
async function said(res: Response): Promise<string> {
    try {
        const body = (await res.json()) as { error?: string };
        return firstLine(body.error ?? res.statusText);
    } catch {
        return res.statusText;
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

/** The one `apiKeys` call OpenRouter scopes to the key presenting it. */
interface DescribesKey {
    apiKeys: { getCurrentKeyMetadata(): Promise<unknown> };
}

async function authenticate(provider: Provider, client: unknown): Promise<void> {
    // OpenRouter's model catalog is *public*: it answers 200 to a request
    // carrying no key at all, so listing it would report every credential live,
    // including a revoked one. `/key` describes the key that asked and is the
    // only cheap call that actually looks at it.
    if (provider === 'openrouter') {
        await (client as DescribesKey).apiKeys.getCurrentKeyMetadata();
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
 * Probes many entries, one at a time. In flight together would be quicker, but
 * `probe` reaches the SDKs the only way they can be reached — through
 * `process.env` — and two probes sharing that variable would each read the
 * other's key. One at a time is also what makes progress reportable: there is
 * exactly one answer being waited on, and `onProbe` can name it.
 *
 * Pairs rather than a map, because the caller needs the entry itself to record
 * the result against, and a map keyed by a string would only have to be
 * un-joined again.
 */
export async function probeAll(
    store: KeyStore,
    entries: readonly KeyEntry[],
    onProbe?: (entry: KeyEntry, index: number, total: number) => void,
): Promise<[KeyEntry, KeyCheck][]> {
    const out: [KeyEntry, KeyCheck][] = [];
    for (const [index, entry] of entries.entries()) {
        onProbe?.(entry, index, entries.length);
        out.push([entry, await probe(store, entry)]);
    }
    return out;
}
