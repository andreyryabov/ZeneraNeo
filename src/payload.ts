import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Payloads — every non-trivial string in a trajectory is a reference
// ---------------------------------------------------------------------------

/**
 * A content-addressed reference. Uniform (never inline) so a state stays
 * O(number of nodes) in size no matter how much data flowed through the run,
 * which is what makes checkpointing every step affordable.
 */
export interface Payload {
    /** store id, e.g. 's3://bucket' or 'mem' */
    store: string;
    /** content address — also the key */
    sha256: string;
    /** bytes, for budgeting without fetching */
    size: number;
    /** first ~200 chars, for logs, UIs and debugging */
    preview?: string;
}

export const PREVIEW_LEN = 200;

export function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function previewOf(value: string): string | undefined {
    return value ? value.slice(0, PREVIEW_LEN) : undefined;
}

export function isPayload(v: unknown): v is Payload {
    if (v === null || typeof v !== 'object') {
        return false;
    }
    const p = v as Partial<Payload>;
    return typeof p.store === 'string' && typeof p.sha256 === 'string' && typeof p.size === 'number';
}

export interface PayloadStore {
    readonly id: string;
    put(value: string): Promise<Payload>;
    get(p: Payload): Promise<string>;
    /** one round trip for a whole projection */
    getMany(ps: Payload[]): Promise<string[]>;
}

/**
 * Fans a projection out over the stores it references and caches results.
 * Because payloads are content-addressed, a growing trajectory re-projects its
 * unchanged prefix with exact cache hits — repeated projection is cheap.
 */
export class PayloadResolver {
    readonly #stores = new Map<string, PayloadStore>();
    readonly #cache = new Map<string, string>();
    readonly #maxCacheBytes: number;
    #cacheBytes = 0;
    #default: PayloadStore;

    constructor(def: PayloadStore, maxCacheBytes = 8 << 20) {
        this.#default = def;
        this.#maxCacheBytes = maxCacheBytes;
        this.register(def);
    }

    register(store: PayloadStore): this {
        this.#stores.set(store.id, store);
        return this;
    }

    get defaultStore(): PayloadStore {
        return this.#default;
    }

    store(id: string): PayloadStore {
        const s = this.#stores.get(id);
        if (!s) {
            throw new Error(`unknown payload store: ${id} (known: ${[...this.#stores.keys()]})`);
        }
        return s;
    }

    async put(value: string, store: PayloadStore = this.#default): Promise<Payload> {
        const p = await store.put(value);
        this.#remember(p.sha256, value);
        return p;
    }

    async get(p: Payload): Promise<string> {
        const cached = this.#cache.get(p.sha256);
        if (cached !== undefined) {
            return cached;
        }
        const value = await this.store(p.store).get(p);
        this.#remember(p.sha256, value);
        return value;
    }

    /**
     * Batched resolution keyed by content address: duplicates collapse, and one
     * store round trip covers a whole projection.
     */
    async getMany(ps: Payload[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        const missing = new Map<string, Payload[]>();
        for (const p of ps) {
            if (out.has(p.sha256)) {
                continue;
            }
            const cached = this.#cache.get(p.sha256);
            if (cached !== undefined) {
                out.set(p.sha256, cached);
                continue;
            }
            const byStore = missing.get(p.store) ?? [];
            if (!byStore.some((q) => q.sha256 === p.sha256)) {
                byStore.push(p);
            }
            missing.set(p.store, byStore);
        }
        await Promise.all(
            [...missing].map(async ([storeId, refs]) => {
                const values = await this.store(storeId).getMany(refs);
                refs.forEach((ref, i) => {
                    const value = values[i] ?? '';
                    out.set(ref.sha256, value);
                    this.#remember(ref.sha256, value);
                });
            }),
        );
        return out;
    }

    #remember(sha256: string, value: string): void {
        if (this.#cache.has(sha256)) {
            return;
        }
        this.#cache.set(sha256, value);
        this.#cacheBytes += value.length;
        // Insertion-ordered Map == FIFO eviction, good enough for a prefix-heavy
        // access pattern where the hot entries are re-inserted on every miss.
        for (const [key, val] of this.#cache) {
            if (this.#cacheBytes <= this.#maxCacheBytes) {
                break;
            }
            if (key === sha256) {
                continue;
            }
            this.#cache.delete(key);
            this.#cacheBytes -= val.length;
        }
    }
}

// ---------------------------------------------------------------------------
// Deep payload traversal — export/import and GC accounting
// ---------------------------------------------------------------------------

/** Every payload reachable from an arbitrary JSON value, deduped by address. */
export function collectPayloads(value: unknown, into = new Map<string, Payload>()): Payload[] {
    if (Array.isArray(value)) {
        for (const v of value) {
            collectPayloads(v, into);
        }
    } else if (value !== null && typeof value === 'object') {
        if (isPayload(value)) {
            into.set(value.sha256, value);
            return [...into.values()];
        }
        for (const v of Object.values(value)) {
            collectPayloads(v, into);
        }
    }
    return [...into.values()];
}

/**
 * A run made whole: a state plus every blob it points at.
 *
 * On its own an `AgentState` is a graph of references — meaningless without
 * the stores those references name, which may be a bucket the reader cannot
 * reach or an in-memory store that died with its process. A bundle closes
 * that gap, so it is the unit for anything crossing a machine, a process or a
 * trust boundary: test fixtures, bug reports, archival, handing a run to
 * another service.
 *
 * Plain JSON by design — `JSON.stringify` it, and `importRun` rehydrates it
 * against whatever store the reader has. Note the two halves are indexed
 * differently on purpose: `state` keeps full `Payload` refs (store id, size,
 * preview) because it is still a working state, while `blobs` is keyed by
 * content address alone, which both drops the origin store (an imported run
 * belongs to its new one) and dedupes for free — content repeated across
 * steps or fork branches is carried once.
 */
export interface RunBundle {
    /** typically an `AgentState`, but any payload-bearing JSON works */
    state: unknown;
    /** sha256 → content; deduped by construction */
    blobs: Record<string, string>;
}

/**
 * Self-containment on demand: one portable artifact for tests, bug reports and
 * archival. A fork tree needs no special handling — branch nodes live in the
 * one trajectory, so their payloads are already reachable.
 */
export async function exportRun(state: unknown, payloads: PayloadResolver): Promise<RunBundle> {
    const refs = collectPayloads(state);
    const values = await payloads.getMany(refs);
    const blobs: Record<string, string> = {};
    for (const p of refs) {
        blobs[p.sha256] = values.get(p.sha256) ?? '';
    }
    return { state, blobs };
}

/** Bounded fan-out: a bundle can hold thousands of blobs, a store has limits. */
const IMPORT_CONCURRENCY = 32;

/**
 * Writes a bundle's blobs into the target store and rewrites every reference
 * to point at it, so an imported run resolves locally.
 *
 * It re-`put`s rather than inserting under the bundle's keys, which keeps the
 * contract at `PayloadStore` (any backend works, not just the in-memory one)
 * and means nothing has to trust those keys: the store re-derives the address
 * from the bytes, so a tampered blob lands under its true address and leaves a
 * dangling reference that fails loudly instead of poisoning the store.
 */
export async function importRun<T>(bundle: RunBundle, store: PayloadStore): Promise<T> {
    const values = Object.values(bundle.blobs);
    for (let i = 0; i < values.length; i += IMPORT_CONCURRENCY) {
        await Promise.all(values.slice(i, i + IMPORT_CONCURRENCY).map((v) => store.put(v)));
    }
    return rewriteStore(structuredClone(bundle.state), store.id) as T;
}

function rewriteStore(value: unknown, storeId: string): unknown {
    if (Array.isArray(value)) {
        value.forEach((v) => rewriteStore(v, storeId));
    } else if (value !== null && typeof value === 'object') {
        if (isPayload(value)) {
            (value as Payload).store = storeId;
            return value;
        }
        for (const v of Object.values(value)) {
            rewriteStore(v, storeId);
        }
    }
    return value;
}
