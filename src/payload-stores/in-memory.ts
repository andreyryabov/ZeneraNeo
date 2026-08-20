import { hash, previewOf, type Payload, type PayloadStore } from '../payload.ts';

/**
 * The zero-I/O backend, and the one `Services` falls back to. Content-addressed
 * and therefore write-once: putting existing content is a no-op returning the
 * same reference, which makes writes idempotent under retry and replay for
 * free.
 */
export class InMemoryPayloadStore implements PayloadStore {
    readonly id: string;
    readonly #blobs = new Map<string, string>();

    constructor(id = 'mem') {
        this.id = id;
    }

    async put(value: string): Promise<Payload> {
        const sha256 = hash(value);
        if (!this.#blobs.has(sha256)) {
            this.#blobs.set(sha256, value);
        }
        return { store: this.id, sha256, size: Buffer.byteLength(value), preview: previewOf(value) };
    }

    async get(p: Payload): Promise<string> {
        const v = this.#blobs.get(p.sha256);
        if (v === undefined) {
            throw new Error(`payload not found in store "${this.id}": ${p.sha256}`);
        }
        return v;
    }

    async getMany(ps: Payload[]): Promise<string[]> {
        return Promise.all(ps.map((p) => this.get(p)));
    }

    get size(): number {
        return this.#blobs.size;
    }
}
