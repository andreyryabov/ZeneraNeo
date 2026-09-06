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

export interface VectorCache {
    /** the vector this text already has, if it has one */
    get(text: string): number[] | undefined;
    /** keeps a vector for next time */
    put(text: string, vector: number[]): void;
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

    get(text: string): number[] | undefined {
        const found = this.#store.get<number[]>(this.#key(text));
        return Array.isArray(found) && found.length > 0 ? found : undefined;
    }

    put(text: string, vector: number[]): void {
        if (vector.length > 0) {
            // A Float32Array would encode as `{"0":…}`; the store holds JSON.
            this.#store.put(this.#key(text), Array.from(vector));
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
            vectors[at] = Float32Array.from(hit);
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
                    cache.put(input[at + i]!, vector);
                }
            },
            onProgress: (done) => options.onProgress?.(known + done, texts.length),
        });
        for (const [i, vector] of response.vectors.entries()) {
            // `put` rewrites the same bytes, so what a slice already saved costs
            // nothing here. Not every embedder reports slices, and the cache
            // cannot depend on it.
            cache.put(input[i]!, vector);
            const shared = Float32Array.from(vector);
            for (const at of wanted.get(input[i]!)!) {
                vectors[at] = shared;
            }
        }
    }

    options.onProgress?.(texts.length, texts.length);
    return vectors;
}
