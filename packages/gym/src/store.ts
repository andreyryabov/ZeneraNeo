import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// The world
//
// One SQLite file holds every entity the mock has ever answered with, keyed by
// collection and id. It is what makes `GET /messages/{id}` return the message
// `GET /messages` listed, and what makes a `POST` visible to the next `GET`.
//
// Several `zen gym serve` processes — mail on one port, calendar on another —
// open the same file. WAL mode and a busy timeout are the whole of the
// coordination: SQLite already knows how to share a file between processes,
// and anything cleverer would be a second, worse database.
//
// This module is loaded by the handler worker as well as the host, so it
// imports nothing but `node:` built-ins and uses only erasable TypeScript.
// ---------------------------------------------------------------------------

export interface CollectionSummary {
    name: string;
    count: number;
    sampleIds: string[];
}

export interface Collection<T = Record<string, unknown>> {
    readonly name: string;
    count(): number;
    all(): T[];
    get(id: string | number): T | undefined;
    has(id: string | number): boolean;
    find(predicate: (item: T) => boolean): T[];
    put(id: string | number, value: T): T;
    putMany(items: readonly { id: string | number; value: T }[]): number;
    delete(id: string | number): boolean;
    clear(): void;
}

const UPSERT = `
    INSERT INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`;

export class WorldStore {
    readonly path: string;
    readonly #db: DatabaseSync;

    constructor(path: string) {
        this.path = resolve(path);
        mkdirSync(dirname(this.path), { recursive: true });
        this.#db = new DatabaseSync(this.path);
        this.#db.exec(`
            PRAGMA busy_timeout = 10000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS records (
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (collection, id)
            );
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
    }

    collection<T = Record<string, unknown>>(name: string): Collection<T> {
        const db = this.#db;
        const col = name.trim();
        const parse = (text: string): T | undefined => {
            try {
                return JSON.parse(text) as T;
            } catch {
                return undefined;
            }
        };
        const all = (): T[] =>
            (
                db
                    .prepare('SELECT data FROM records WHERE collection = ? ORDER BY rowid')
                    .all(col) as { data: string }[]
            )
                .map((row) => parse(row.data))
                .filter((v): v is T => v !== undefined);

        return {
            name: col,
            count: () =>
                Number(
                    (
                        db
                            .prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ?')
                            .get(col) as { n: number }
                    ).n,
                ),
            all,
            get: (id) => {
                const row = db
                    .prepare('SELECT data FROM records WHERE collection = ? AND id = ?')
                    .get(col, String(id)) as { data: string } | undefined;
                return row ? parse(row.data) : undefined;
            },
            has: (id) =>
                db
                    .prepare('SELECT 1 FROM records WHERE collection = ? AND id = ?')
                    .get(col, String(id)) !== undefined,
            find: (predicate) => all().filter(predicate),
            put: (id, value) => {
                db.prepare(UPSERT).run(
                    col,
                    String(id),
                    JSON.stringify(value),
                    new Date().toISOString(),
                );
                return value;
            },
            putMany: (items) => {
                const stmt = db.prepare(UPSERT);
                const now = new Date().toISOString();
                db.exec('BEGIN IMMEDIATE');
                try {
                    for (const item of items) {
                        stmt.run(col, String(item.id), JSON.stringify(item.value), now);
                    }
                    db.exec('COMMIT');
                } catch (err) {
                    db.exec('ROLLBACK');
                    throw err;
                }
                return items.length;
            },
            delete: (id) =>
                Number(
                    db
                        .prepare('DELETE FROM records WHERE collection = ? AND id = ?')
                        .run(col, String(id)).changes,
                ) > 0,
            clear: () => {
                db.prepare('DELETE FROM records WHERE collection = ?').run(col);
            },
        };
    }

    collections(): CollectionSummary[] {
        const rows = db(this).prepare(
            'SELECT collection, COUNT(*) AS n FROM records GROUP BY collection ORDER BY collection',
        );
        return (rows.all() as { collection: string; n: number }[]).map((row) => ({
            name: row.collection,
            count: Number(row.n),
            sampleIds: (
                db(this)
                    .prepare('SELECT id FROM records WHERE collection = ? ORDER BY rowid LIMIT 5')
                    .all(row.collection) as { id: string }[]
            ).map((r) => r.id),
        }));
    }

    getMeta<T = unknown>(key: string): T | undefined {
        const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
            { value: string } | undefined;
        return row ? (JSON.parse(row.value) as T) : undefined;
    }

    setMeta(key: string, value: unknown): void {
        this.#db
            .prepare(
                'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            )
            .run(key, JSON.stringify(value));
    }

    /**
     * A consistent copy of the whole world, for judging a handler without
     * letting its test traffic leak into what real requests will see.
     */
    snapshot(to: string): string {
        const target = resolve(to);
        mkdirSync(dirname(target), { recursive: true });
        this.#db.prepare('VACUUM INTO ?').run(target);
        return target;
    }

    /**
     * Takes a lease, or says someone else holds it. A lease is a row in `meta`
     * claimed inside one immediate transaction, so two processes on the same
     * file cannot both win; it lapses when its time is up or its process is
     * gone, so a crash costs nobody a wait.
     */
    claim(key: string, owner: string, ttlMs: number): boolean {
        const name = `lease:${key}`;
        const now = Date.now();
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(name) as
                { value: string } | undefined;
            const held = row ? (JSON.parse(row.value) as Lease) : undefined;
            if (held && held.owner !== owner && held.until > now && alive(held.owner)) {
                this.#db.exec('COMMIT');
                return false;
            }
            this.#db
                .prepare(
                    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                )
                .run(name, JSON.stringify({ owner, until: now + ttlMs } satisfies Lease));
            this.#db.exec('COMMIT');
            return true;
        } catch (err) {
            this.#db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Gives a lease back, if it is still this owner's. */
    release(key: string, owner: string): void {
        const name = `lease:${key}`;
        const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(name) as
            { value: string } | undefined;
        if (row && (JSON.parse(row.value) as Lease).owner === owner) {
            this.#db.prepare('DELETE FROM meta WHERE key = ?').run(name);
        }
    }

    /** Throws away every entity, keeping the file and its schema. */
    reset(): void {
        this.#db.exec('DELETE FROM records; DELETE FROM meta;');
    }

    close(): void {
        try {
            this.#db.close();
        } catch {
            // already closed
        }
    }

    /** @internal */
    get raw(): DatabaseSync {
        return this.#db;
    }
}

const db = (store: WorldStore): DatabaseSync => store.raw;

interface Lease {
    /** `<pid>:<anything>`, so a lease outlives nobody's process */
    owner: string;
    /** epoch ms */
    until: number;
}

/** A lease owner `<pid>:…` whose process still runs; anything else is taken as alive. */
function alive(owner: string): boolean {
    const pid = Number(owner.split(':')[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
        return true;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** A lease owner for this process. */
export const leaseOwner = (): string => `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

/** A world named rather than given as a path: letters, digits, `.`, `_`, `-`. */
const WORLD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where the world lives. `--world` wins: a name is a file under
 * `<root>/worlds`, anything that looks like a path is that path. Otherwise the
 * story names its own world, keyed by what the story says, so two processes
 * handed the same story share one world without being told to; with neither,
 * there is one default world.
 */
export function worldPath(opts: {
    root: string;
    cwd: string;
    world?: string;
    storyDigest?: string;
}): string {
    const named = opts.world?.trim();
    if (named) {
        if (/[\\/]/.test(named) || /\.(sqlite|db)$/i.test(named)) {
            return resolve(opts.cwd, named);
        }
        if (!WORLD_NAME.test(named)) {
            throw new Error(
                `"${named}" is not a world name: use letters, digits, ".", "_" and "-", or a path`,
            );
        }
        return join(worldsDir(opts.root), `${named}.sqlite`);
    }
    const name = opts.storyDigest ? `story-${opts.storyDigest.slice(0, 16)}` : 'default';
    return join(worldsDir(opts.root), `${name}.sqlite`);
}

export const worldsDir = (root: string): string => join(root, 'worlds');

export interface WorldFile {
    name: string;
    path: string;
    bytes: number;
    usedAt: Date;
    collections: CollectionSummary[];
}

/** Every world under `<root>/worlds`, most recently used first. */
export function listWorlds(root: string): WorldFile[] {
    const dir = worldsDir(root);
    let names: string[];
    try {
        names = readdirSync(dir).filter((n) => n.endsWith('.sqlite'));
    } catch {
        return [];
    }
    return names
        .map((file): WorldFile => {
            const path = join(dir, file);
            const info = statSync(path);
            let collections: CollectionSummary[] = [];
            try {
                const store = new WorldStore(path);
                collections = store.collections();
                store.close();
            } catch {
                // unreadable: listed, with nothing in it
            }
            return {
                name: file.replace(/\.sqlite$/, ''),
                path,
                bytes: info.size,
                usedAt: info.mtime,
                collections,
            };
        })
        .sort((a, b) => b.usedAt.getTime() - a.usedAt.getTime());
}

/** Deletes a world and the journal files SQLite keeps beside it. */
export function removeWorld(path: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${path}${suffix}`, { force: true });
    }
}

export const digest = (text: string): string =>
    createHash('sha256').update(text).digest('hex').slice(0, 16);
