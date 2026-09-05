import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from '../common/cache.ts';
import type { Chunk, ChunkOptions } from './chunk.ts';
import type { FileOutline } from './files.ts';
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
// entry is a miss rather than a wrong answer. It sits next to the vectors in
// `<out>/.cache/`, hidden from the walker that finds documents, and follows the
// same rules — appended as each document is read, compacted at the end to what
// the build used, and every error in it is a miss and nothing else.
// ---------------------------------------------------------------------------

export const PARSE_FILE = 'parse.ndjson';

/** Bumped when chunking changes shape, which invalidates every entry. */
export const PARSE_VERSION = 1;

interface Entry {
    key: string;
    chunks: Chunk[];
    outline: FileOutline;
}

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
    const shape = [
        PARSE_VERSION,
        name,
        options.chunkTokens ?? '',
        options.minChunkTokens ?? '',
        options.maxChunkTokens ?? '',
        options.tableSliceTokens ?? '',
    ].join('\u0000');
    return createHash('sha256').update(bytes).update(shape, 'utf8').digest('hex');
}

export function openParseCache(dir: string): ParseCache {
    try {
        return new FileParseCache(join(dir, CACHE_DIR));
    } catch {
        return NO_PARSE_CACHE;
    }
}

class FileParseCache implements ParseCache {
    readonly #path: string;
    readonly #known = new Map<string, Entry>();
    readonly #used = new Set<string>();
    #added = 0;
    #hits = 0;
    #dead = false;

    constructor(dir: string) {
        mkdirSync(dir, { recursive: true });
        this.#path = join(dir, PARSE_FILE);
        this.#read();
    }

    get hits(): number {
        return this.#hits;
    }

    /**
     * One entry per line. A kill during an append leaves a last line that is
     * not whole JSON, so a line that will not parse ends the file rather than
     * failing the build — everything before it is still good.
     */
    #read(): void {
        let body = '';
        try {
            body = readFileSync(this.#path, 'utf8');
        } catch {
            return;
        }
        for (const line of body.split('\n')) {
            if (!line) {
                continue;
            }
            try {
                const entry = JSON.parse(line) as Entry;
                if (entry.key && entry.chunks && entry.outline) {
                    this.#known.set(entry.key, entry);
                }
            } catch {
                break;
            }
        }
    }

    get(key: string): Parsed | undefined {
        const entry = this.#known.get(key);
        if (!entry) {
            return undefined;
        }
        this.#used.add(key);
        this.#hits++;
        return { chunks: entry.chunks, outline: entry.outline };
    }

    put(key: string, parsed: Parsed): void {
        if (this.#dead || this.#known.has(key)) {
            return;
        }
        const entry: Entry = { key, chunks: parsed.chunks, outline: parsed.outline };
        try {
            appendFileSync(this.#path, `${JSON.stringify(entry)}\n`);
        } catch {
            this.#dead = true;
            return;
        }
        this.#known.set(key, entry);
        this.#used.add(key);
        this.#added++;
    }

    commit(): void {
        if (this.#dead || (this.#added === 0 && this.#used.size === this.#known.size)) {
            return;
        }
        try {
            const keep = [...this.#used]
                .map((key) => this.#known.get(key))
                .filter((entry) => entry !== undefined)
                .map((entry) => `${JSON.stringify(entry)}\n`)
                .join('');
            const temp = `${this.#path}.tmp`;
            writeFileSync(temp, keep);
            renameSync(temp, this.#path);
        } catch {
            // A cache that could not be compacted is still a correct cache.
        }
    }
}
