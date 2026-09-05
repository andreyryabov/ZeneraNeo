import type { Embedder } from '@zenera/neo';
import { createHash } from 'node:crypto';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    truncateSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Not paying twice for the same vector
//
// Embedding is the whole cost of a build: the reading and the writing are
// seconds, the round trips are minutes and the only part anyone is billed for.
// And almost none of it is new work. Re-indexing a corpus after editing one
// paragraph re-embeds every other paragraph unchanged, and a build killed at
// 90% starts again from nothing.
//
// So the vectors are kept beside the index, in `<out>/.cache/`, keyed by a hash
// of the exact text that produced them. The key is the *text*, never the chunk's
// position: inserting a sentence at the top of a document shifts every later
// chunk's ordinal without changing a word of it, and an ordinal key would miss
// all of them. Two documents that happen to share a paragraph share its vector.
//
// The file is append-only while a build runs, so a kill loses at most the one
// request in flight, and is compacted at the end to exactly what this build
// used, so a corpus that churns cannot grow it without bound.
//
// It is a cache, so every error here is a miss. A corrupt file, an unreadable
// directory or a half-written record costs the build the vectors it could have
// reused, and nothing else. Nothing in this file may throw.
// ---------------------------------------------------------------------------

export const CACHE_DIR = '.cache';
export const VECTORS_FILE = 'vectors.bin';
export const CACHE_META = 'meta.json';

/** Bumped when the record layout changes, which drops every existing file. */
export const CACHE_VERSION = 1;

const KEY_BYTES = 32;
/** key, then the width, then that many little-endian float32. */
const HEAD_BYTES = KEY_BYTES + 2;

interface Meta {
    version: number;
    /** the embedder that made these, as it was typed and as it resolved */
    ref: string;
    id: string;
}

export interface VectorCache {
    /** the vector this text already has, if it has one */
    get(text: string): number[] | undefined;
    /** keeps a vector for next time; a repeat of a known text is ignored */
    put(text: string, vector: number[]): void;
    /** drops everything this build did not touch, and closes the file */
    commit(): void;
    /** closes without rewriting, for a build that failed */
    abandon(): void;
    readonly hits: number;
}

/** A cache that remembers nothing, for `--no-cache` and for every failure path. */
export const NO_CACHE: VectorCache = {
    get: () => undefined,
    put: () => {},
    commit: () => {},
    abandon: () => {},
    hits: 0,
};

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Opens the cache beside an index, discarding one that a different model wrote.
 * The directory is hidden, and `walk` skips dot-entries, so an index built into
 * a directory that is itself being indexed cannot pick this up as a document.
 */
export function openCache(dir: string, embedder: Embedder, ref: string): VectorCache {
    try {
        return new FileCache(join(dir, CACHE_DIR), {
            version: CACHE_VERSION,
            ref,
            id: embedder.id,
        });
    } catch {
        return NO_CACHE;
    }
}

class FileCache implements VectorCache {
    readonly #dir: string;
    readonly #path: string;
    /** hex key to where its floats start in `#buf` */
    readonly #known = new Map<string, number>();
    /** every key this build asked for or added, which is what survives commit */
    readonly #used = new Set<string>();
    /** appended by this build; `#known` cannot hold them, its offsets index `#buf` */
    readonly #fresh = new Set<string>();
    #buf: Buffer;
    #fd: number | undefined;
    #added = 0;
    #hits = 0;
    #dead = false;

    constructor(dir: string, meta: Meta) {
        this.#dir = dir;
        this.#path = join(dir, VECTORS_FILE);
        mkdirSync(dir, { recursive: true });
        this.#buf = matches(dir, meta) ? read(this.#path) : reset(dir, meta);
        this.#index();
    }

    get hits(): number {
        return this.#hits;
    }

    /**
     * Walks the records, stopping at the first one that does not fit. A build
     * killed mid-write leaves a partial record, and everything before it is
     * still good; the file is cut back to there so the next append lands on a
     * record boundary rather than inside one.
     */
    #index(): void {
        let at = 0;
        while (at + HEAD_BYTES <= this.#buf.length) {
            const dims = this.#buf.readUInt16LE(at + KEY_BYTES);
            const end = at + HEAD_BYTES + dims * 4;
            if (dims === 0 || end > this.#buf.length) {
                break;
            }
            this.#known.set(this.#buf.toString('hex', at, at + KEY_BYTES), at + HEAD_BYTES);
            at = end;
        }
        if (at < this.#buf.length) {
            truncateSync(this.#path, at);
            this.#buf = this.#buf.subarray(0, at);
        }
    }

    get(text: string): number[] | undefined {
        if (this.#dead) {
            return undefined;
        }
        const key = digest(text);
        const at = this.#known.get(key);
        if (at === undefined) {
            return undefined;
        }
        this.#used.add(key);
        this.#hits++;
        const dims = this.#buf.readUInt16LE(at - 2);
        const vector = new Array<number>(dims);
        for (let i = 0; i < dims; i++) {
            vector[i] = this.#buf.readFloatLE(at + i * 4);
        }
        return vector;
    }

    put(text: string, vector: number[]): void {
        const key = digest(text);
        // uint16 holds every width any model returns; a wider one is not cached.
        if (
            this.#dead ||
            this.#known.has(key) ||
            this.#fresh.has(key) ||
            vector.length === 0 ||
            vector.length > 0xffff
        ) {
            return;
        }
        const record = Buffer.allocUnsafe(HEAD_BYTES + vector.length * 4);
        record.write(key, 0, 'hex');
        record.writeUInt16LE(vector.length, KEY_BYTES);
        for (const [i, x] of vector.entries()) {
            record.writeFloatLE(x, HEAD_BYTES + i * 4);
        }
        try {
            this.#fd ??= openSync(this.#path, 'a');
            writeSync(this.#fd, record);
        } catch {
            // Out of disk, or the directory went away. The build does not care.
            this.#dead = true;
            return;
        }
        // Not added to `#known`, whose offsets index `#buf`; `#used` is what commit reads.
        this.#used.add(key);
        this.#fresh.add(key);
        this.#added++;
    }

    commit(): void {
        this.#close();
        if (this.#dead || (this.#added === 0 && this.#used.size === this.#known.size)) {
            return;
        }
        try {
            const whole = read(this.#path);
            const keep: Buffer[] = [];
            let at = 0;
            while (at + HEAD_BYTES <= whole.length) {
                const dims = whole.readUInt16LE(at + KEY_BYTES);
                const end = at + HEAD_BYTES + dims * 4;
                if (dims === 0 || end > whole.length) {
                    break;
                }
                if (this.#used.has(whole.toString('hex', at, at + KEY_BYTES))) {
                    keep.push(whole.subarray(at, end));
                }
                at = end;
            }
            const temp = `${this.#path}.tmp`;
            writeFileSync(temp, Buffer.concat(keep));
            renameSync(temp, this.#path);
        } catch {
            // A cache that could not be compacted is still a correct cache.
        }
    }

    abandon(): void {
        this.#close();
    }

    #close(): void {
        if (this.#fd !== undefined) {
            try {
                closeSync(this.#fd);
            } catch {
                // Nothing left to do with it either way.
            }
            this.#fd = undefined;
        }
    }
}

/** True when the file beside this meta was written by the same model. */
function matches(dir: string, meta: Meta): boolean {
    try {
        const found = JSON.parse(readFileSync(join(dir, CACHE_META), 'utf8')) as Partial<Meta>;
        return found.version === meta.version && found.ref === meta.ref && found.id === meta.id;
    } catch {
        return false;
    }
}

/** Starts over, because vectors from another model cannot be compared to these. */
function reset(dir: string, meta: Meta): Buffer {
    rmSync(join(dir, VECTORS_FILE), { force: true });
    writeFileSync(join(dir, CACHE_META), `${JSON.stringify(meta, null, 4)}\n`);
    return Buffer.alloc(0);
}

function read(path: string): Buffer {
    return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
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
            // `put` is idempotent, so what a slice already saved costs nothing here.
            // Not every embedder reports slices, and the cache cannot depend on it.
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
