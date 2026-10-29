import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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

/**
 * Where the world lives. `--state` wins; otherwise a story names its own file,
 * keyed by what the story says, so two processes handed the same story share
 * one world without being told to; with neither, there is one default world.
 */
export function statePath(opts: { root: string; state?: string; storyDigest?: string }): string {
    if (opts.state) {
        return resolve(opts.state);
    }
    const name = opts.storyDigest ? `story-${opts.storyDigest.slice(0, 16)}` : 'default';
    return join(opts.root, 'worlds', `${name}.sqlite`);
}

export const digest = (text: string): string =>
    createHash('sha256').update(text).digest('hex').slice(0, 16);
