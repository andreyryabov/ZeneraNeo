import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { paths, writeJson } from './home.ts';

// ---------------------------------------------------------------------------
// One place for work already done
//
// Embedding a paragraph, parsing a document, asking a provider what models it
// serves: all expensive, all perfectly repeatable, and all previously cached by
// a different hand-rolled file format sitting in a different directory. This is
// the one store they share, at `~/.zenera/neo/cache/<kind>/<ab>/<sha>.json`,
// one file per object.
//
// Three rules hold the whole thing up.
//
// **Nothing here throws.** A corrupt file, a full disk, an unreadable
// directory, a key that does not match: every one of them is a miss. A cache
// that cannot work costs time and must never cost correctness, so there is no
// error path for a caller to get wrong.
//
// **The key carries every input.** Not the text alone but the model, the
// dimensions, the version of whatever produced the value — all of it. That is
// why there is no invalidation step anywhere: change any input and you are
// asking a different question, which has no answer yet. Vectors from another
// model are not evicted, they are simply never found.
//
// **The key is written into the entry and checked on the way out.** The path is
// only a hash of it. Reading proves the file is the one that was asked for
// rather than trusting sha256 to be injective, and — much more likely to
// actually happen — it catches a key derivation that changed shape without
// anyone bumping a version.
// ---------------------------------------------------------------------------

/** Characters of the digest that name the subdirectory, so no one directory grows huge. */
const SHARD = 2;

/**
 * How stale a mtime has to be before reading an entry rewrites it.
 *
 * `commit` is what makes "older than 30 days" mean *unused* for 30 days rather
 * than *unwritten* for 30 days. Doing it on every read would be a write per
 * read; a day's granularity costs nothing and is far finer than any retention
 * anyone will ask for.
 */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

export interface CacheOptions {
    /** where the store lives; defaults to `~/.zenera/neo/cache` */
    dir?: string;
    /** file mode, 0600 unless the value is public */
    mode?: number;
}

export interface CacheEntry<T> {
    value: T;
    /** when it was written, for callers that have an opinion about freshness */
    storedAt: string;
}

/** What a `Cache` does, so that `NO_CACHE` can be one without being one. */
export interface CacheStore {
    readonly kind: string;
    readonly hits: number;
    readonly misses: number;
    entry<T>(key: string): CacheEntry<T> | undefined;
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
    delete(key: string): void;
    commit(): void;
}

interface Stored {
    kind: string;
    key: string;
    storedAt: string;
    value: unknown;
}

/** Joins the parts of a composite key. NUL cannot occur in any of them. */
export function cacheKey(...parts: readonly (string | number | undefined)[]): string {
    return parts.map((part) => part ?? '').join('\u0000');
}

export class Cache implements CacheStore {
    readonly kind: string;
    readonly #dir: string;
    readonly #mode: number | undefined;
    /** entries read this run, so `commit` can say they are still wanted */
    readonly #used = new Set<string>();
    #hits = 0;
    #misses = 0;

    constructor(kind: string, options: CacheOptions = {}) {
        this.kind = kind;
        this.#dir = join(options.dir ?? paths.cache(), kind);
        this.#mode = options.mode;
    }

    get hits(): number {
        return this.#hits;
    }

    get misses(): number {
        return this.#misses;
    }

    #path(key: string): string {
        const sha = createHash('sha256')
            .update(this.kind, 'utf8')
            .update('\u0000', 'utf8')
            .update(key, 'utf8')
            .digest('hex');
        return join(this.#dir, sha.slice(0, SHARD), `${sha}.json`);
    }

    entry<T>(key: string): CacheEntry<T> | undefined {
        const path = this.#path(key);
        let found: Stored;
        try {
            found = JSON.parse(readFileSync(path, 'utf8')) as Stored;
        } catch {
            this.#misses++;
            return undefined;
        }
        if (found?.kind !== this.kind || found.key !== key) {
            this.#misses++;
            return undefined;
        }
        this.#hits++;
        this.#used.add(path);
        return { value: found.value as T, storedAt: found.storedAt };
    }

    get<T>(key: string): T | undefined {
        return this.entry<T>(key)?.value;
    }

    put(key: string, value: unknown): void {
        const stored: Stored = {
            kind: this.kind,
            key,
            storedAt: new Date().toISOString(),
            value,
        };
        try {
            writeJson(this.#path(key), stored, this.#mode);
        } catch {
            // Out of disk, or the directory went away. Nothing depends on this.
        }
    }

    delete(key: string): void {
        try {
            rmSync(this.#path(key), { force: true });
        } catch {
            // Still cached, then. It will be pruned by age eventually.
        }
    }

    commit(): void {
        const now = new Date();
        for (const path of this.#used) {
            try {
                if (now.getTime() - statSync(path).mtimeMs > TOUCH_AFTER_MS) {
                    utimesSync(path, now, now);
                }
            } catch {
                // Gone, or read-only. Neither is worth a word.
            }
        }
        this.#used.clear();
    }
}

/** Remembers nothing, for `--no-cache` and for anywhere a store cannot be opened. */
export const NO_CACHE: CacheStore = {
    kind: 'none',
    hits: 0,
    misses: 0,
    entry: () => undefined,
    get: () => undefined,
    put: () => {},
    delete: () => {},
    commit: () => {},
};

// ---------------------------------------------------------------------------
// Looking at the store from outside
//
// What `zen cache` needs, and the only code that walks the tree. Everything
// below reads mtime as *last used*, which is what `Cache.commit` maintains.
// ---------------------------------------------------------------------------

export interface CacheKind {
    kind: string;
    entries: number;
    bytes: number;
    /** epoch ms of the least and most recently used entry; absent when empty */
    oldest?: number;
    newest?: number;
}

export interface CacheItem {
    kind: string;
    key: string;
    bytes: number;
    /** epoch ms, last used */
    usedAt: number;
    storedAt?: string;
    /** what was stored — the file is parsed anyway to recover the key */
    value?: unknown;
}

interface Found {
    kind: string;
    path: string;
    bytes: number;
    usedAt: number;
}

const dirents = (dir: string): readonly { name: string; dir: boolean; file: boolean }[] => {
    try {
        return readdirSync(dir, { withFileTypes: true }).map((e) => ({
            name: e.name,
            dir: e.isDirectory(),
            file: e.isFile(),
        }));
    } catch {
        return [];
    }
};

/** Every entry file, kind by kind. Half-written `.tmp` siblings are not entries. */
function* walk(dir: string, only?: string): Generator<Found> {
    for (const kind of dirents(dir)) {
        if (!kind.dir || (only !== undefined && kind.name !== only)) {
            continue;
        }
        const kindDir = join(dir, kind.name);
        for (const shard of dirents(kindDir)) {
            if (!shard.dir) {
                continue;
            }
            const shardDir = join(kindDir, shard.name);
            for (const file of dirents(shardDir)) {
                if (!file.file || !file.name.endsWith('.json')) {
                    continue;
                }
                const path = join(shardDir, file.name);
                try {
                    const info = statSync(path);
                    yield { kind: kind.name, path, bytes: info.size, usedAt: info.mtimeMs };
                } catch {
                    continue;
                }
            }
        }
    }
}

/** A row per kind, for `zen cache ls`. One stat walk; nothing is parsed. */
export function kinds(dir = paths.cache()): CacheKind[] {
    const rows = new Map<string, CacheKind>();
    for (const found of walk(dir)) {
        const row = rows.get(found.kind) ?? { kind: found.kind, entries: 0, bytes: 0 };
        row.entries++;
        row.bytes += found.bytes;
        row.oldest = Math.min(row.oldest ?? found.usedAt, found.usedAt);
        row.newest = Math.max(row.newest ?? found.usedAt, found.usedAt);
        rows.set(found.kind, row);
    }
    return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * The entries of one kind, most recently used first. Reading a key means
 * parsing the file, so the sort happens on stat data and only what will be
 * shown is opened.
 */
export function items(
    kind: string,
    options: { dir?: string; limit?: number } = {},
): { rows: CacheItem[]; found: number } {
    const all = [...walk(options.dir ?? paths.cache(), kind)].sort((a, b) => b.usedAt - a.usedAt);
    const take = options.limit === undefined ? all : all.slice(0, options.limit);
    const rows = take.map((found): CacheItem => {
        const row: CacheItem = {
            kind: found.kind,
            key: '',
            bytes: found.bytes,
            usedAt: found.usedAt,
        };
        try {
            const stored = JSON.parse(readFileSync(found.path, 'utf8')) as Stored;
            row.key = stored.key ?? '';
            row.storedAt = stored.storedAt;
            row.value = stored.value;
        } catch {
            // An unreadable entry is still an entry taking up room.
        }
        return row;
    });
    return { rows, found: all.length };
}

export interface SweepOptions {
    dir?: string;
    /** only this kind */
    kind?: string;
    /** anything unused for longer than this */
    olderThanMs?: number;
    /** a ceiling on what is left, met by removing the least recently used */
    maxBytes?: number;
}

export interface Swept {
    kind: string;
    removed: number;
    bytes: number;
}

/**
 * Removes what the options describe and reports what went, by kind.
 *
 * `maxBytes` applies to the whole selection rather than to each kind
 * separately: the disk is one thing, and least-recently-used across the store
 * is the only ordering that means anything on it.
 */
export function sweep(options: SweepOptions = {}): Swept[] {
    const dir = options.dir ?? paths.cache();
    const cutoff = options.olderThanMs === undefined ? undefined : Date.now() - options.olderThanMs;
    const kept: Found[] = [];
    const doomed: Found[] = [];

    for (const found of walk(dir, options.kind)) {
        (cutoff !== undefined && found.usedAt < cutoff ? doomed : kept).push(found);
    }
    if (options.maxBytes !== undefined) {
        kept.sort((a, b) => a.usedAt - b.usedAt);
        let total = kept.reduce((n, f) => n + f.bytes, 0);
        while (total > options.maxBytes && kept.length > 0) {
            const found = kept.shift()!;
            total -= found.bytes;
            doomed.push(found);
        }
    }

    const swept = new Map<string, Swept>();
    for (const found of doomed) {
        try {
            rmSync(found.path, { force: true });
        } catch {
            continue;
        }
        const row = swept.get(found.kind) ?? { kind: found.kind, removed: 0, bytes: 0 };
        row.removed++;
        row.bytes += found.bytes;
        swept.set(found.kind, row);
    }
    tidy(dir);
    return [...swept.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Everything, or one kind of everything. */
export function clear(options: { dir?: string; kind?: string } = {}): void {
    const dir = options.dir ?? paths.cache();
    try {
        rmSync(options.kind === undefined ? dir : join(dir, options.kind), {
            recursive: true,
            force: true,
        });
    } catch {
        // Whatever survived will be reported by the next `ls`.
    }
}

/** Drops the shard and kind directories a sweep emptied. */
function tidy(dir: string): void {
    for (const kind of dirents(dir)) {
        if (!kind.dir) {
            continue;
        }
        const kindDir = join(dir, kind.name);
        for (const shard of dirents(kindDir)) {
            if (shard.dir) {
                rmdir(join(kindDir, shard.name));
            }
        }
        rmdir(kindDir);
    }
}

function rmdir(dir: string): void {
    try {
        rmdirSync(dir);
    } catch {
        // Not empty, which is the usual answer.
    }
}
