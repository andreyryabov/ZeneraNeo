import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
    rankMemories,
    type MemoryDraft,
    type MemoryHit,
    type MemoryPatch,
    type MemoryQuery,
    type MemoryRecord,
    type MemoryStore,
} from '../memory.ts';

// ---------------------------------------------------------------------------
// Filesystem-backed memory store
// ---------------------------------------------------------------------------

/**
 * Record ids and op ids reach this store from model-authored tool arguments
 * (`memory_update`, `memory_delete`), so they are validated before becoming
 * path segments. Dots are excluded outright, which makes `.` and `..`
 * unrepresentable.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface FileMemoryStoreOptions {
    /** root directory; created on demand */
    dir: string;
    /** logical store id agents bind to; defaults to `file` */
    id?: string;
}

/**
 * One JSON file per record, under one directory per scope:
 *
 * ```
 * <dir>/<scope>/scope.json        the unescaped scope name, for humans
 * <dir>/<scope>/records/<id>.json
 * <dir>/<scope>/ops/<opId>.json   idempotency ledger
 * ```
 *
 * A file per record (rather than one appended log) keeps writes atomic and
 * deletes cheap without a compaction step. Search reads the whole scope and
 * ranks in process, which is exactly the trade this backend makes: no server,
 * no index, fine up to a few thousand records per scope.
 *
 * There is no cross-process lock. Concurrent writers to the *same* record can
 * lose an update; `expectedRevision` narrows that window, and a deployment
 * that needs real isolation should use a database-backed store.
 */
export class FileMemoryStore implements MemoryStore {
    readonly id: string;
    readonly #dir: string;

    constructor(opts: FileMemoryStoreOptions | string) {
        const o = typeof opts === 'string' ? { dir: opts } : opts;
        this.#dir = resolve(o.dir);
        this.id = o.id ?? 'file';
    }

    get dir(): string {
        return this.#dir;
    }

    async search(scope: string, q: MemoryQuery): Promise<MemoryHit[]> {
        return rankMemories(await this.#all(scope), q);
    }

    async get(scope: string, id: string): Promise<MemoryRecord | undefined> {
        return this.#readJson<MemoryRecord>(this.#recordPath(scope, id));
    }

    async write(scope: string, rec: MemoryDraft, opId: string): Promise<MemoryRecord> {
        const known = await this.#readOp(scope, opId);
        if (known) {
            const existing = await this.get(scope, known);
            if (existing) {
                return existing;
            }
        }
        const now = new Date().toISOString();
        const record: MemoryRecord = {
            id: randomUUID(),
            scope,
            kind: rec.kind ?? 'fact',
            text: rec.text,
            metadata: rec.metadata,
            createdAt: now,
            updatedAt: now,
            revision: 1,
        };
        await this.#writeRecord(record);
        await this.#writeOp(scope, opId, record.id);
        return record;
    }

    async update(
        scope: string,
        id: string,
        patch: MemoryPatch,
        opId: string,
    ): Promise<MemoryRecord> {
        const cur = await this.get(scope, id);
        if (!cur) {
            throw new Error(`memory record not found: ${scope}/${id}`);
        }
        if ((await this.#readOp(scope, opId)) === id) {
            return cur;
        }
        if (patch.expectedRevision !== undefined && patch.expectedRevision !== cur.revision) {
            throw new Error(
                `memory conflict on ${scope}/${id}: expected revision ` +
                    `${patch.expectedRevision}, found ${cur.revision}`,
            );
        }
        const next: MemoryRecord = {
            ...cur,
            kind: patch.kind ?? cur.kind,
            text: patch.text ?? cur.text,
            metadata: patch.metadata ?? cur.metadata,
            updatedAt: new Date().toISOString(),
            revision: cur.revision + 1,
        };
        await this.#writeRecord(next);
        await this.#writeOp(scope, opId, id);
        return next;
    }

    async delete(scope: string, id: string, opId: string): Promise<void> {
        await rm(this.#recordPath(scope, id), { force: true });
        await this.#writeOp(scope, opId, id);
    }

    // --- layout -----------------------------------------------------------

    /**
     * Percent-encoding is reversible and, with dots escaped too, cannot
     * produce a traversal segment out of a scope like `../etc`.
     */
    #scopeDir(scope: string): string {
        return join(this.#dir, encodeURIComponent(scope).replace(/\./g, '%2E'));
    }

    #recordPath(scope: string, id: string): string {
        return join(this.#scopeDir(scope), 'records', `${safeId(id, 'record id')}.json`);
    }

    #opPath(scope: string, opId: string): string {
        return join(this.#scopeDir(scope), 'ops', `${safeId(opId, 'op id')}.json`);
    }

    // --- io ---------------------------------------------------------------

    async #all(scope: string): Promise<MemoryRecord[]> {
        const dir = join(this.#scopeDir(scope), 'records');
        let names: string[];
        try {
            names = await readdir(dir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return [];
            }
            throw err;
        }
        const records = await Promise.all(
            names
                .filter((n) => n.endsWith('.json'))
                .map((n) => this.#readJson<MemoryRecord>(join(dir, n))),
        );
        return records.filter((r): r is MemoryRecord => r !== undefined);
    }

    async #readOp(scope: string, opId: string): Promise<string | undefined> {
        const op = await this.#readJson<{ recordId: string }>(this.#opPath(scope, opId));
        return op?.recordId;
    }

    async #writeOp(scope: string, opId: string, recordId: string): Promise<void> {
        await writeJson(this.#opPath(scope, opId), { recordId });
    }

    async #writeRecord(record: MemoryRecord): Promise<void> {
        await writeJson(join(this.#scopeDir(record.scope), 'scope.json'), { scope: record.scope });
        await writeJson(this.#recordPath(record.scope, record.id), record);
    }

    async #readJson<T>(path: string): Promise<T | undefined> {
        try {
            return JSON.parse(await readFile(path, 'utf8')) as T;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw err;
        }
    }
}

function safeId(value: string, what: string): string {
    if (!SAFE_ID.test(value)) {
        throw new Error(`invalid ${what}: ${JSON.stringify(value)}`);
    }
    return value;
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value), 'utf8');
    try {
        await rename(tmp, path);
    } catch (err) {
        await rm(tmp, { force: true });
        throw err;
    }
}
