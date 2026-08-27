import {
    rankMemories,
    type MemoryDraft,
    type MemoryHit,
    type MemoryPatch,
    type MemoryQuery,
    type MemoryRecord,
    type MemoryStore,
} from '../memory.ts';

/**
 * Reference implementation: scoped maps plus token-overlap scoring. Good enough
 * for tests and local runs; production deployments swap in a vector store
 * without touching the kernel.
 */
export class InMemoryMemoryStore implements MemoryStore {
    readonly id: string;
    readonly #scopes = new Map<string, Map<string, MemoryRecord>>();
    /** opId → record id, so a replayed op returns the original result */
    readonly #ops = new Map<string, string>();
    #seq = 0;

    constructor(id = 'mem') {
        this.id = id;
    }

    async search(scope: string, q: MemoryQuery): Promise<MemoryHit[]> {
        return rankMemories(this.#space(scope).values(), q);
    }

    async get(scope: string, id: string): Promise<MemoryRecord | undefined> {
        return this.#space(scope).get(id);
    }

    async write(scope: string, rec: MemoryDraft, opId: string): Promise<MemoryRecord> {
        const known = this.#ops.get(opId);
        if (known) {
            const existing = this.#space(scope).get(known);
            if (existing) {
                return existing;
            }
        }
        const now = new Date().toISOString();
        const record: MemoryRecord = {
            id: `m${++this.#seq}`,
            scope,
            kind: rec.kind ?? 'fact',
            text: rec.text,
            metadata: rec.metadata,
            createdAt: now,
            updatedAt: now,
            revision: 1,
        };
        this.#space(scope).set(record.id, record);
        this.#ops.set(opId, record.id);
        return record;
    }

    async update(
        scope: string,
        id: string,
        patch: MemoryPatch,
        opId: string,
    ): Promise<MemoryRecord> {
        const space = this.#space(scope);
        const cur = space.get(id);
        if (!cur) {
            throw new Error(`memory record not found: ${scope}/${id}`);
        }
        if (this.#ops.get(opId) === id) {
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
        space.set(id, next);
        this.#ops.set(opId, id);
        return next;
    }

    async delete(scope: string, id: string, opId: string): Promise<void> {
        this.#space(scope).delete(id);
        this.#ops.set(opId, id);
    }

    #space(scope: string): Map<string, MemoryRecord> {
        const s = this.#scopes.get(scope) ?? new Map<string, MemoryRecord>();
        this.#scopes.set(scope, s);
        return s;
    }
}
