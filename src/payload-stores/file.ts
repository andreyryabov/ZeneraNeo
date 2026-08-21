import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hash, previewOf, type Payload, type PayloadStore } from '../payload.ts';

// ---------------------------------------------------------------------------
// Filesystem-backed payload store
// ---------------------------------------------------------------------------

/**
 * A content address is the only thing that ever becomes a path segment, so it
 * is validated before it touches the filesystem: addresses arrive from
 * deserialized state, which may come from an untrusted bundle.
 */
const ADDRESS = /^[0-9a-f]{64}$/;

export interface FilePayloadStoreOptions {
    /** root directory; created on demand */
    dir: string;
    /**
     * Store id embedded in every `Payload` this store hands out. Keep it a
     * logical name (not the path) so a run stays portable between machines.
     */
    id?: string;
    /** parallel reads in `getMany` — guards against EMFILE on big projections */
    concurrency?: number;
    /** re-hash on read; turns silent corruption into a loud error */
    verify?: boolean;
}

/**
 * Same contract as the in-memory store, on disk. Content addressing does the
 * hard part: writes are write-once and therefore idempotent under retry and
 * replay, and two processes racing on the same blob produce identical bytes.
 */
export class FilePayloadStore implements PayloadStore {
    readonly id: string;
    readonly #dir: string;
    readonly #concurrency: number;
    readonly #verify: boolean;

    constructor(opts: FilePayloadStoreOptions | string) {
        const o = typeof opts === 'string' ? { dir: opts } : opts;
        this.#dir = resolve(o.dir);
        this.id = o.id ?? 'file';
        this.#concurrency = Math.max(1, o.concurrency ?? 32);
        this.#verify = o.verify ?? false;
    }

    get dir(): string {
        return this.#dir;
    }

    async put(value: string): Promise<Payload> {
        const sha256 = hash(value);
        const path = this.#path(sha256);
        if (!(await exists(path))) {
            await mkdir(dirname(path), { recursive: true });
            // Write elsewhere then rename: a reader never observes a partial
            // blob, and a crash leaves at worst an orphaned temp file.
            const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
            await writeFile(tmp, value, 'utf8');
            try {
                await rename(tmp, path);
            } catch (err) {
                await rm(tmp, { force: true });
                throw err;
            }
        }
        return {
            store: this.id,
            sha256,
            size: Buffer.byteLength(value),
            preview: previewOf(value),
        };
    }

    async get(p: Payload): Promise<string> {
        return this.#read(p.sha256);
    }

    async getMany(ps: Payload[]): Promise<string[]> {
        return mapPool(ps, this.#concurrency, (p) => this.#read(p.sha256));
    }

    /** Two levels of fan-out keep any single directory small. */
    #path(sha256: string): string {
        if (!ADDRESS.test(sha256)) {
            throw new Error(`invalid payload address: ${JSON.stringify(sha256)}`);
        }
        return join(this.#dir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    }

    async #read(sha256: string): Promise<string> {
        const path = this.#path(sha256);
        let value: string;
        try {
            value = await readFile(path, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`payload not found in store "${this.id}": ${sha256}`);
            }
            throw err;
        }
        if (this.#verify && hash(value) !== sha256) {
            throw new Error(`payload corrupted in store "${this.id}": ${sha256}`);
        }
        return value;
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw err;
    }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        for (let i = next++; i < items.length; i = next++) {
            out[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
