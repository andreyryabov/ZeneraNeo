import { hash } from './payload.ts';
import {
    MEMORY_DELETE_TOOL,
    MEMORY_SEARCH_TOOL,
    MEMORY_UPDATE_TOOL,
    MEMORY_WRITE_TOOL,
    type AnyTool,
    tool,
    withEffects,
} from './types.ts';

// ---------------------------------------------------------------------------
// Memory — knowledge that outlives a run (the trajectory is one run's record)
// ---------------------------------------------------------------------------

export interface MemoryRecord {
    id: string;
    /** memory space this record belongs to */
    scope: string;
    /** app-defined: 'fact' | 'preference' | 'episode' | … */
    kind: string;
    text: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    /** optimistic-concurrency token */
    revision: number;
}

export interface MemoryDraft {
    kind?: string;
    text: string;
    metadata?: Record<string, unknown>;
}

export interface MemoryPatch {
    kind?: string;
    text?: string;
    metadata?: Record<string, unknown>;
    /** when given, the update fails unless the stored revision matches */
    expectedRevision?: number;
}

export interface MemoryQuery {
    /** semantic query; omitted ⇒ pure filter listing */
    text?: string;
    filter?: Record<string, unknown>;
    kind?: string;
    limit?: number;
    minScore?: number;
}

export interface MemoryHit {
    record: MemoryRecord;
    /** 0..1, backend-normalized */
    score: number;
}

/**
 * Embedding generation is the store's business, not the kernel's: a pgvector
 * implementation embeds inside `write`/`search`, the in-memory one below falls
 * back to token overlap. The kernel never sees vectors.
 */
export interface MemoryStore {
    readonly id: string;
    search(scope: string, q: MemoryQuery): Promise<MemoryHit[]>;
    get(scope: string, id: string): Promise<MemoryRecord | undefined>;
    /** `opId` makes writes idempotent under retry/replay */
    write(scope: string, rec: MemoryDraft, opId: string): Promise<MemoryRecord>;
    update(scope: string, id: string, patch: MemoryPatch, opId: string): Promise<MemoryRecord>;
    delete(scope: string, id: string, opId: string): Promise<void>;
}

export interface MemoryBinding<TCtx = unknown> {
    /** MemoryStore id */
    store: string;
    /** namespace; default `agent:${agent.name}`. A function is resolved per run. */
    scope?: string | ((ctx: TCtx) => string);
    access: 'read' | 'read-write';
    /** inject top-k matches before an LLM call */
    autoRecall?: { query: 'last_user_input' | 'none'; limit: number };
}

/** A binding with its scope already resolved against the run context. */
export interface ResolvedBinding {
    store: string;
    scope: string;
    access: 'read' | 'read-write';
    autoRecall?: { query: 'last_user_input' | 'none'; limit: number };
}

// --- trajectory-facing effect specs ---------------------------------------

export interface MemoryRecallSpec {
    kind: 'recall';
    store: string;
    scope: string;
    query: MemoryQuery;
    hits: { id: string; score: number; revision: number }[];
    /** the rendered block the model actually saw */
    content: string;
}

export interface MemoryOpSpec {
    kind: 'op';
    op: 'write' | 'update' | 'delete';
    store: string;
    scope: string;
    /** sha256(runId, callId) — deterministic, so replay re-issues the same write */
    opId: string;
    recordId: string;
    revision: number;
    before?: string;
    after?: string;
}

export function memoryOpId(runId: string, callId: string): string {
    return hash(`${runId}\u0000${callId}`);
}

export function renderMemories(hits: MemoryHit[]): string {
    if (!hits.length) {
        return '';
    }
    const lines = hits.map(
        (h) => `- [${h.record.id}] (${h.record.kind}, score ${h.score.toFixed(2)}) ${h.record.text}`,
    );
    return `Relevant memories:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Default backend
// ---------------------------------------------------------------------------

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
        const limit = q.limit ?? 8;
        const terms = tokenize(q.text ?? '');
        const hits: MemoryHit[] = [];
        for (const rec of this.#space(scope).values()) {
            if (q.kind && rec.kind !== q.kind) {
                continue;
            }
            if (q.filter && !matches(rec.metadata, q.filter)) {
                continue;
            }
            const score = terms.length ? overlap(terms, tokenize(rec.text)) : 1;
            if (score <= 0 || (q.minScore !== undefined && score < q.minScore)) {
                continue;
            }
            hits.push({ record: rec, score });
        }
        return hits.sort((a, b) => b.score - a.score).slice(0, limit);
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

function tokenize(v: string): string[] {
    return v
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2);
}

function overlap(a: string[], b: string[]): number {
    const set = new Set(b);
    const shared = a.filter((t) => set.has(t)).length;
    return a.length ? shared / a.length : 0;
}

function matches(meta: Record<string, unknown> | undefined, filter: Record<string, unknown>) {
    return Object.entries(filter).every(([k, v]) => meta?.[k] === v);
}

// ---------------------------------------------------------------------------
// Built-in memory tools
// ---------------------------------------------------------------------------

function spaceParam(bindings: ResolvedBinding[]): Record<string, unknown> | undefined {
    return bindings.length > 1
        ? { type: 'string', enum: bindings.map((b) => b.scope), description: 'memory space' }
        : undefined;
}

function pick(bindings: ResolvedBinding[], space?: string): ResolvedBinding {
    const b = space ? bindings.find((x) => x.scope === space) : bindings[0];
    if (!b) {
        throw new Error(`unknown memory space: ${space ?? '(default)'}`);
    }
    return b;
}

/**
 * Memory is reachable both explicitly (these tools) and implicitly (auto-recall
 * in the runner). Both land in the trajectory; only the explicit path is
 * visible to the model as a tool.
 */
export function memoryTools<TCtx>(bindings: ResolvedBinding[]): AnyTool<TCtx>[] {
    if (!bindings.length) {
        return [];
    }
    const writable = bindings.filter((b) => b.access === 'read-write');
    const space = spaceParam(bindings);
    const withSpace = (props: Record<string, unknown>) => (space ? { ...props, space } : props);
    const tools: AnyTool<TCtx>[] = [
        tool<{ query?: string; kind?: string; limit?: number; space?: string }, TCtx>({
            name: MEMORY_SEARCH_TOOL,
            description: 'Search long-lived memories.',
            parameters: {
                type: 'object',
                properties: withSpace({
                    query: { type: 'string' },
                    kind: { type: 'string' },
                    limit: { type: 'integer' },
                }),
                required: ['query'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const b = pick(bindings, args.space);
                const store = tc.services.memoryStore(b.store);
                const hits = await store.search(b.scope, {
                    text: args.query,
                    kind: args.kind,
                    limit: args.limit,
                });
                return hits.map((h) => ({
                    id: h.record.id,
                    kind: h.record.kind,
                    text: h.record.text,
                    revision: h.record.revision,
                    score: Number(h.score.toFixed(3)),
                }));
            },
        }),
    ];
    if (!writable.length) {
        return tools;
    }
    const wSpace = spaceParam(writable);
    const withWSpace = (props: Record<string, unknown>) => (wSpace ? { ...props, space: wSpace } : props);
    tools.push(
        tool<{ text: string; kind?: string; space?: string }, TCtx>({
            name: MEMORY_WRITE_TOOL,
            description: 'Store a new long-lived memory.',
            parameters: {
                type: 'object',
                properties: withWSpace({ text: { type: 'string' }, kind: { type: 'string' } }),
                required: ['text'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const b = pick(writable, args.space);
                const opId = memoryOpId(tc.state.runId, tc.callId);
                const rec = await tc.services
                    .memoryStore(b.store)
                    .write(b.scope, { text: args.text, kind: args.kind }, opId);
                return withEffects(`stored memory ${rec.id}`, {
                    kind: 'memory_op',
                    spec: {
                        kind: 'op',
                        op: 'write',
                        store: b.store,
                        scope: b.scope,
                        opId,
                        recordId: rec.id,
                        revision: rec.revision,
                        after: rec.text,
                    },
                });
            },
        }),
        tool<{ id: string; text?: string; kind?: string; space?: string }, TCtx>({
            name: MEMORY_UPDATE_TOOL,
            description: 'Update an existing memory by id.',
            parameters: {
                type: 'object',
                properties: withWSpace({
                    id: { type: 'string' },
                    text: { type: 'string' },
                    kind: { type: 'string' },
                }),
                required: ['id'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const b = pick(writable, args.space);
                const store = tc.services.memoryStore(b.store);
                const before = await store.get(b.scope, args.id);
                const opId = memoryOpId(tc.state.runId, tc.callId);
                const rec = await store.update(
                    b.scope,
                    args.id,
                    { text: args.text, kind: args.kind },
                    opId,
                );
                return withEffects(`updated memory ${rec.id}`, {
                    kind: 'memory_op',
                    spec: {
                        kind: 'op',
                        op: 'update',
                        store: b.store,
                        scope: b.scope,
                        opId,
                        recordId: rec.id,
                        revision: rec.revision,
                        before: before?.text,
                        after: rec.text,
                    },
                });
            },
        }),
        tool<{ id: string; space?: string }, TCtx>({
            name: MEMORY_DELETE_TOOL,
            description: 'Delete a memory by id.',
            parameters: {
                type: 'object',
                properties: withWSpace({ id: { type: 'string' } }),
                required: ['id'],
                additionalProperties: false,
            },
            execute: async (args, tc) => {
                const b = pick(writable, args.space);
                const store = tc.services.memoryStore(b.store);
                const before = await store.get(b.scope, args.id);
                const opId = memoryOpId(tc.state.runId, tc.callId);
                await store.delete(b.scope, args.id, opId);
                return withEffects(`deleted memory ${args.id}`, {
                    kind: 'memory_op',
                    spec: {
                        kind: 'op',
                        op: 'delete',
                        store: b.store,
                        scope: b.scope,
                        opId,
                        recordId: args.id,
                        revision: before?.revision ?? 0,
                        before: before?.text,
                    },
                });
            },
        }),
    );
    return tools;
}
