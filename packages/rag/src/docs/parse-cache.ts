import { Cache, cacheKey, type CacheStore } from '@zenera/cli/lib';
import { createHash } from 'node:crypto';
import type { ChunkOptions } from './chunk.ts';
import type { Parsed } from './pool.ts';

// ---------------------------------------------------------------------------
// Not parsing the same document twice
//
// Once vectors are cached, parsing is what a rebuild of an unchanged corpus
// spends all of its time on — the threads make it several times faster, and
// this makes it nothing at all. A document that has not changed produces
// exactly the chunks it produced last time, so the chunks are what is kept.
//
// The key is the file's bytes together with everything that decides how they
// are cut: change the document, the chunk settings or this module, and the
// entry is a miss rather than a wrong answer. It sits in the machine's shared
// cache next to the vectors, so a corpus indexed into two directories is read
// once, and it follows the same rule everything there does — every error is a
// miss and nothing else.
// ---------------------------------------------------------------------------

export const PARSE_KIND = 'docs-parse';

/** Bumped when chunking changes shape, which invalidates every entry. */
export const PARSE_VERSION = 1;

export interface ParseCache {
    get(key: string): Parsed | undefined;
    put(key: string, parsed: Parsed): void;
    commit(): void;
    readonly hits: number;
}

export const NO_PARSE_CACHE: ParseCache = {
    get: () => undefined,
    put: () => {},
    commit: () => {},
    hits: 0,
};

/**
 * What the chunks depend on, and nothing else. `tokenCount` is a function and
 * cannot be hashed; a caller that supplies one gets no cache rather than a key
 * that quietly ignores it.
 */
export function parseKey(bytes: Buffer, name: string, options: ChunkOptions): string | undefined {
    if (typeof options.tokenCount === 'function') {
        return undefined;
    }
    return cacheKey(
        PARSE_VERSION,
        name,
        options.chunkTokens,
        options.minChunkTokens,
        options.maxChunkTokens,
        options.tableSliceTokens,
        createHash('sha256').update(bytes).digest('hex'),
    );
}

export function openParseCache(dir?: string): ParseCache {
    return new StoredParses(new Cache(PARSE_KIND, { dir }));
}

class StoredParses implements ParseCache {
    readonly #store: CacheStore;

    constructor(store: CacheStore) {
        this.#store = store;
    }

    get hits(): number {
        return this.#store.hits;
    }

    get(key: string): Parsed | undefined {
        const found = this.#store.get<Parsed>(key);
        return found?.chunks && found.outline ? found : undefined;
    }

    put(key: string, parsed: Parsed): void {
        this.#store.put(key, { chunks: parsed.chunks, outline: parsed.outline });
    }

    commit(): void {
        this.#store.commit();
    }
}
