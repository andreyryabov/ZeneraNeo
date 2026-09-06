import { Cache, cacheKey, type CacheStore } from '@zenera/cli/lib';
import type { Embedder } from '@zenera/neo';

// ---------------------------------------------------------------------------
// Not paying twice for the same vector
//
// Embedding is the whole cost of a build: the reading and the writing are
// seconds, the round trips are minutes and the only part anyone is billed for.
// And almost none of it is new work. Re-indexing a corpus after editing one
// paragraph re-embeds every other paragraph unchanged, and a build killed at
// 90% starts again from nothing.
//
// The vectors live in the machine's shared cache, so two indexes built from the
// same corpus — or one corpus indexed twice into different directories — pay
// for it once between them.
//
// The key is the *text*, together with the model that would embed it. Never the
// chunk's position: inserting a sentence at the top of a document shifts every
// later chunk's ordinal without changing a word of it, and an ordinal key would
// miss all of them. Two documents that happen to share a paragraph share its
// vector; a different model shares nothing, because it asks a different
// question and so has a different key. That is also why there is nothing here
// that invalidates anything.
//
// It is a cache, so every error is a miss, and the shared store guarantees that
// much on its own: nothing in this file can fail a build.
// ---------------------------------------------------------------------------

export const VECTOR_KIND = 'vectors';

/** Bumped only if what a key means changes; the model is already in the key. */
const VECTOR_VERSION = 'v1';

// ---------------------------------------------------------------------------
// How a vector is written down
//
// As base64 of its own bytes, not as a JSON array. `JSON.stringify(v, null, 2)`
// gives every component a line of its own — four spaces, seventeen digits, a
// comma — which is about 27 bytes to say what four bytes already said. At 3072
// dimensions that is 83 KB a vector, and a corpus of 200k of them is 16 GB of
// cache for 2.4 GB of numbers.
//
// Base64 costs a third on top of the bytes and nothing in CPU, so the same
// vector is 16 KB. Compression was the other candidate and is not worth it: the
// mantissa of a float from a model is 23 bits of noise, so DEFLATE finds only
// the sign and exponent and returns 5-10% for real time on every read.
//
// The encoding is not part of the key, because the key says what the vector
// *is* and this only says how it was spelled. An entry left in the old shape is
// therefore found, rejected for not being a string, and overwritten by the put
// that follows — the cache heals itself one entry at a time, and
// `scripts/vectors-base64.mjs` does the whole store at once for anyone who
// would rather not re-embed.
// ---------------------------------------------------------------------------

export interface VectorCache {
    /** the vector this text already has, if it has one */
    get(text: string): Float32Array | undefined;
    /** keeps a vector for next time */
    put(text: string, vector: Float32Array): void;
    /** says the entries this build read are still wanted, so age means unused */
    commit(): void;
    /** for a build that failed; entries land as they are paid for, so nothing unwinds */
    abandon(): void;
    readonly hits: number;
}

/** A cache that remembers nothing, for `--no-cache`. */
export const NO_CACHE: VectorCache = {
    get: () => undefined,
    put: () => {},
    commit: () => {},
    abandon: () => {},
    hits: 0,
};

export interface VectorCacheOptions {
    /** the reference as it was typed, which is part of what the vectors mean */
    ref: string;
    /** somewhere other than the shared store */
    dir?: string;
    /** when the caller asked for a width the model does not default to */
    dimensions?: number;
}

export function openCache(embedder: Embedder, options: VectorCacheOptions): VectorCache {
    return new StoredVectors(new Cache(VECTOR_KIND, { dir: options.dir }), embedder, options);
}

class StoredVectors implements VectorCache {
    readonly #store: CacheStore;
    readonly #prefix: readonly (string | number | undefined)[];

    constructor(store: CacheStore, embedder: Embedder, options: VectorCacheOptions) {
        this.#store = store;
        this.#prefix = [VECTOR_VERSION, options.ref, embedder.id, options.dimensions];
    }

    get hits(): number {
        return this.#store.hits;
    }

    /** Everything the vector is a function of, ending with the text itself. */
    #key(text: string): string {
        return cacheKey(...this.#prefix, text);
    }

    get(text: string): Float32Array | undefined {
        const found = this.#store.get<unknown>(this.#key(text));
        if (typeof found !== 'string' || found.length === 0) {
            return undefined;
        }
        const bytes = Buffer.from(found, 'base64');
        if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
            return undefined;
        }
        // Buffer.from can land at any offset in the shared pool, and a
        // Float32Array needs a multiple of four. Slicing copies to its own.
        return new Float32Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
    }

    put(text: string, vector: Float32Array): void {
        if (vector.length > 0) {
            const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
            this.#store.put(this.#key(text), Buffer.from(bytes).toString('base64'));
        }
    }

    commit(): void {
        this.#store.commit();
    }

    abandon(): void {}
}

export interface CachedEmbedOptions {
    embedder: Embedder;
    cache: VectorCache;
    texts: readonly string[];
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
}

/**
 * Embeds only what the cache does not already have, and hands each request's
 * answer to the cache as it lands rather than at the end, so a build killed
 * half way keeps the half it paid for.
 *
 * Identical texts are embedded once. A corpus repeats itself more than it looks
 * like it does — shared boilerplate, a table copied between two documents — and
 * a duplicate is a whole vector's worth of request for an answer already held.
 */
export async function embedCached(options: CachedEmbedOptions): Promise<Float32Array[]> {
    const { cache, texts } = options;
    const vectors = new Array<Float32Array>(texts.length);
    const wanted = new Map<string, number[]>();

    for (const [at, text] of texts.entries()) {
        const hit = cache.get(text);
        if (hit) {
            vectors[at] = hit;
            continue;
        }
        const waiting = wanted.get(text);
        if (waiting) {
            waiting.push(at);
        } else {
            wanted.set(text, [at]);
        }
    }

    const input = [...wanted.keys()];
    const known = texts.length - [...wanted.values()].reduce((n, at) => n + at.length, 0);

    if (input.length > 0) {
        const response = await options.embedder.embed({
            input,
            taskType: 'document',
            signal: options.signal,
            onSlice: (at, slice) => {
                for (const [i, vector] of slice.entries()) {
                    cache.put(input[at + i]!, Float32Array.from(vector));
                }
            },
            onProgress: (done) => options.onProgress?.(known + done, texts.length),
        });
        for (const [i, vector] of response.vectors.entries()) {
            const shared = Float32Array.from(vector);
            // `put` rewrites the same bytes, so what a slice already saved costs
            // nothing here. Not every embedder reports slices, and the cache
            // cannot depend on it.
            cache.put(input[i]!, shared);
            for (const at of wanted.get(input[i]!)!) {
                vectors[at] = shared;
            }
        }
    }

    options.onProgress?.(texts.length, texts.length);
    return vectors;
}

/**
 * How many records are embedded, written and let go of before the next are
 * looked at. At 3072 dimensions a window costs about 250 MB while it is in
 * flight, and the embedder still sees enough texts at once to keep every
 * request slot busy.
 */
const WINDOW = 4096;

export interface EmbedStreamOptions<R> {
    embedder: Embedder;
    cache: VectorCache;
    records: readonly R[];
    textOf: (record: R) => string;
    window?: number;
    signal?: AbortSignal;
    /** counted over every record, not over the window being worked on */
    onProgress?: (done: number, total: number) => void;
    onWindow: (records: readonly R[], vectors: readonly Float32Array[]) => Promise<void>;
}

/**
 * Embeds in windows and hands each one straight to whatever stores it, so that
 * peak memory is the window rather than the corpus. A corpus of 200k chunks at
 * 3072 dimensions held about 12 GB of vectors this way round; it now holds
 * whatever one window is, however large the corpus gets.
 *
 * Duplicate texts spanning two windows still cost one embedding, because the
 * first window has already written them to the cache by the time the second
 * asks. Under `--no-cache` they cost two, which is what `--no-cache` means.
 *
 * Returns the width the model answered with, for the manifest.
 */
export async function embedStream<R>(options: EmbedStreamOptions<R>): Promise<number> {
    const size = options.window ?? WINDOW;
    const total = options.records.length;
    let dimensions = 0;

    for (let at = 0; at < total; at += size) {
        const window = options.records.slice(at, at + size);
        const vectors = await embedCached({
            embedder: options.embedder,
            cache: options.cache,
            texts: window.map(options.textOf),
            signal: options.signal,
            onProgress: (done) => options.onProgress?.(at + done, total),
        });
        if (dimensions === 0) {
            dimensions = vectors[0]?.length ?? 0;
        }
        await options.onWindow(window, vectors);
    }
    return dimensions;
}
