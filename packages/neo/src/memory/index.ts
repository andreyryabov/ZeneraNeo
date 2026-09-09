import { readFile } from 'node:fs/promises';
import type { Embedder } from '../embedding.ts';
import type { IdClock } from '../ids.ts';
import { forgetFile, hostPath, rememberFile } from './files.ts';
import type { MemoryGraph, NodeDraft, NodePatch } from './graph.ts';
import { recall } from './recall.ts';
import type { MemoryStore } from './store.ts';
import {
    ALL_AGENTS,
    MEMORY_KINDS,
    MEMORY_RELATIONS,
    MemoryError,
    type MemoryFile,
    type MemoryNode,
    type MemoryQuery,
    PREFERENCE_KIND,
    type Recollection,
    type Relation,
    visible,
} from './types.ts';

// ---------------------------------------------------------------------------
// The memory, as the engine uses it
//
// `MemoryStore` knows how to persist a graph; this knows what the operations
// mean. It owns the two things that must not drift: the vector for a node's
// text, and the bytes of a remembered file.
//
// `commit` is one transaction. The model names nodes it is creating by a local
// `ref` — it cannot know an id that has not been minted — and edges join refs
// and existing ids indiscriminately, so a whole subgraph arrives in one call.
// Everything is validated, and every source file stat-ed, before the first
// mutation, on the same principle as `runPatch` in tools/workspace.ts: a
// commit that fails must leave no half-built graph behind.
// ---------------------------------------------------------------------------

/** Past this a `load` returns the path and lets the agent open it itself. */
export const INLINE_FILE_BYTES = 32 * 1024;

/**
 * Cosine at or above this is one memory written twice, not two memories. Set
 * high on purpose: merging two things that only resembled each other loses a
 * memory outright, while missing a merge only wastes a node.
 */
export const DUPLICATE_SCORE = 0.97;

export interface MemoryIndexOptions {
    store: MemoryStore;
    /** absent ranks by term overlap and stores no vectors */
    embedder?: Embedder;
    /** the project's vocabulary, when it extends the built-in one */
    kinds?: readonly string[];
    relations?: readonly string[];
}

export interface CommitNode {
    /** names this node within the transaction; for a node being created */
    ref?: string;
    /** an existing node to update; mutually exclusive with `ref` */
    id?: string;
    kind?: string;
    text?: string;
    audience?: string[];
    metadata?: Record<string, unknown>;
    /** absolute host path of a file to copy in, already resolved by the caller */
    file?: { source: string };
    expectedRevision?: number;
}

export interface CommitEdge {
    from: string;
    to: string;
    relation: string;
}

export interface MemoryTransaction {
    nodes?: CommitNode[];
    edges?: CommitEdge[];
}

export interface CommitOptions {
    /** audience labels this agent may assign */
    writes: readonly string[];
    /** labels it may read; a duplicate is only a duplicate if it can see it */
    sees: readonly string[];
    clock: IdClock;
}

export interface CommitResult {
    /** local ref (or id, for an update) to the id it resolved to */
    ids: Record<string, string>;
    created: number;
    updated: number;
    edges: number;
    files: number;
    /** new nodes that turned out to already exist, and were folded into them */
    merged: number;
}

export interface LoadedNode {
    node: MemoryNode;
    /** the file's bytes, when it was small enough to inline */
    content?: string;
}

export class MemoryIndex {
    readonly store: MemoryStore;
    readonly #embedder?: Embedder;
    readonly #kinds: ReadonlySet<string>;
    readonly #relations: ReadonlySet<string>;

    constructor(opts: MemoryIndexOptions) {
        this.store = opts.store;
        this.#embedder = opts.embedder;
        this.#kinds = new Set([...(opts.kinds ?? MEMORY_KINDS), PREFERENCE_KIND]);
        this.#relations = new Set(opts.relations ?? MEMORY_RELATIONS);
    }

    get graph(): MemoryGraph {
        return this.store.graph;
    }

    get kinds(): readonly string[] {
        return [...this.#kinds];
    }

    get relations(): readonly string[] {
        return [...this.#relations];
    }

    /** Read-only: a search returns nodes the model has not read, so nothing is touched. */
    async search(query: MemoryQuery, sees: readonly string[]): Promise<Recollection> {
        const vector = query.text ? await this.#embed([query.text], 'query') : undefined;
        return recall({
            graph: this.graph,
            query,
            sees,
            vector: vector?.[0],
            vectors: this.store.vectors,
        });
    }

    /**
     * Listed rather than ranked, and deliberately not routed through `recall`:
     * ranking decays by `lastUsedAt`, only `memory_load` bumps that, and a
     * preference is injected rather than loaded — so it would age out of its
     * own list. Ordered so the rendered block is byte-stable between runs,
     * because an unstable one would invalidate the prompt prefix for nothing.
     */
    preferences(sees: readonly string[]): MemoryNode[] {
        const stale = this.graph.superseded(sees);
        return this.graph
            .nodes(sees)
            .filter((n) => n.kind === PREFERENCE_KIND && !stale.has(n.id))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }

    /**
     * The only path that counts as use — recency decay is meant to track what
     * an agent actually read, and a search hands back context it never opened.
     */
    async load(
        ids: readonly string[],
        sees: readonly string[],
        clock: IdClock,
    ): Promise<LoadedNode[]> {
        const at = clock.now();
        const out: LoadedNode[] = [];
        for (const id of ids) {
            const node = this.graph.get(id);
            // Indistinguishable from "no such node" on purpose: a refusal that
            // said "you may not see this" would confirm the node exists.
            if (!node || !visible(node, sees)) {
                throw new MemoryError(
                    `no memory ${id}`,
                    'use an id from the legend of a memory_search result',
                );
            }
            const touched = this.graph.touch(id, at) ?? node;
            const file = touched.file;
            out.push({
                node: touched,
                content:
                    file && file.bytes <= INLINE_FILE_BYTES
                        ? await readFile(hostPath(this.store.dir, file), 'utf8')
                        : undefined,
            });
        }
        await this.store.commit();
        return out;
    }

    async commit(tx: MemoryTransaction, opts: CommitOptions): Promise<CommitResult> {
        const nodes = tx.nodes ?? [];
        const edges = tx.edges ?? [];
        if (!nodes.length && !edges.length) {
            throw new MemoryError('a commit needs at least one node or edge');
        }

        const plan = this.#plan(nodes, edges, opts);
        const vectors = await this.#embed(
            plan.embed.map((e) => e.text),
            'document',
        );
        // Keyed before anything is dropped: `#merge` reshapes `plan.embed`, and
        // the vectors only line up with it positionally until it does.
        const vector = new Map(plan.embed.map((e, i) => [e.id, vectors?.[i]]));
        const merged = this.#merge(plan, vector, opts.sees);

        // Files first, so a failed copy can be undone before the graph knows.
        const written: MemoryFile[] = [];
        try {
            for (const item of plan.files) {
                const file = await rememberFile(this.store.dir, item.source, item.id);
                written.push(file);
                item.target.file = file;
            }
        } catch (err) {
            await Promise.all(written.map((f) => forgetFile(this.store.dir, f)));
            throw err;
        }

        const at = opts.clock.now();
        let created = 0;
        let updated = 0;
        for (const item of plan.nodes) {
            if (item.existing) {
                this.graph.update(item.id, item.patch, at);
                updated++;
            } else {
                this.graph.add(item.draft, at);
                created++;
            }
        }
        for (const edge of plan.edges) {
            this.graph.link(edge.source, edge.target, edge.relation, at);
        }
        for (const e of plan.embed) {
            const v = vector.get(e.id);
            if (v) {
                this.store.vectors?.set(e.id, v);
            }
        }

        await this.store.commit();
        return {
            ids: plan.ids,
            created,
            updated,
            edges: plan.edges.length,
            files: plan.files.length,
            merged,
        };
    }

    /**
     * A second run that learns the same thing should join the graph, not fork
     * it. Nothing tells an agent the id of a node it is about to write, so two
     * runs of one job commit two identical tasks and split every edge between
     * them — which is what makes a five-seed recall return two memories.
     *
     * Detected here rather than in `#plan` because the vectors that answer it
     * have just been paid for, so the check is a dot product over what is
     * already in memory and costs no extra call. A merged node keeps its
     * original id, and every edge and ref in this commit is re-pointed at it,
     * so the caller is told the canonical id and can link to it next time.
     *
     * File-bearing nodes never merge: their text is a summary of the artifact,
     * and two summaries can read alike while the bytes underneath differ.
     */
    #merge(
        plan: Plan,
        vector: ReadonlyMap<string, number[] | undefined>,
        sees: readonly string[],
    ): number {
        const minted = new Set(plan.nodes.map((n) => n.id));
        const carries = new Set(plan.files.map((f) => f.id));
        const stale = this.graph.superseded(sees);

        const twins = new Map<string, string>();
        for (const item of plan.nodes) {
            if (item.existing || carries.has(item.id)) {
                continue;
            }
            const { kind, text } = item.draft;
            const eligible = (id: string): boolean => {
                if (minted.has(id) || stale.has(id)) {
                    return false;
                }
                const node = this.graph.get(id);
                return !!node && node.kind === kind && !node.file && visible(node, sees);
            };
            const mine = vector.get(item.id);
            const twin = mine
                ? this.store.vectors
                      ?.topK(mine, 1, eligible)
                      .find((h) => h.score >= DUPLICATE_SCORE)?.id
                : this.graph
                      .nodes(sees)
                      .find((n) => eligible(n.id) && flatten(n.text) === flatten(text))?.id;
            if (twin) {
                twins.set(item.id, twin);
            }
        }
        if (!twins.size) {
            return 0;
        }

        const to = (id: string): string => twins.get(id) ?? id;
        plan.nodes = plan.nodes.filter((n) => !twins.has(n.id));
        plan.embed = plan.embed.filter((e) => !twins.has(e.id));
        for (const [ref, id] of Object.entries(plan.ids)) {
            plan.ids[ref] = to(id);
        }
        // A self-edge is what two refs collapsing onto one node leaves behind.
        plan.edges = plan.edges
            .map((e) => ({ ...e, source: to(e.source), target: to(e.target) }))
            .filter((e) => e.source !== e.target);
        return twins.size;
    }

    async forget(ids: readonly string[], sees: readonly string[]): Promise<MemoryNode[]> {
        const doomed = ids.map((id) => {
            const node = this.graph.get(id);
            if (!node || !visible(node, sees)) {
                throw new MemoryError(`no memory ${id}`);
            }
            return node;
        });
        for (const node of doomed) {
            this.graph.forget(node.id);
            this.store.vectors?.remove(node.id);
            if (node.file) {
                await forgetFile(this.store.dir, node.file);
            }
        }
        await this.store.commit();
        return doomed;
    }

    /**
     * Everything that can be refused, refused here — before a file is copied or
     * a node is added, so a rejected commit leaves the graph exactly as it was.
     */
    #plan(nodes: CommitNode[], edges: CommitEdge[], opts: CommitOptions): Plan {
        const ids: Record<string, string> = {};
        const planned: PlannedNode[] = [];
        const files: PlannedFile[] = [];
        const embed: { id: string; text: string }[] = [];

        for (const [i, node] of nodes.entries()) {
            const where = node.ref ?? node.id ?? `nodes[${i}]`;
            if ((node.ref === undefined) === (node.id === undefined)) {
                throw new MemoryError(
                    `${where}: give either a ref (to create) or an id (to update), not both`,
                );
            }
            const audience = this.#audience(node, opts.writes, where);

            if (node.id) {
                const existing = this.graph.get(node.id);
                if (!existing) {
                    throw new MemoryError(`${where}: no such memory`);
                }
                if (node.kind !== undefined) {
                    this.#kind(node.kind, where);
                }
                ids[node.id] = node.id;
                const patch: NodePatch = {
                    ...(node.kind !== undefined ? { kind: node.kind } : {}),
                    ...(node.text !== undefined ? { text: node.text } : {}),
                    ...(audience ? { audience } : {}),
                    ...(node.metadata !== undefined ? { metadata: node.metadata } : {}),
                    ...(node.expectedRevision !== undefined
                        ? { expectedRevision: node.expectedRevision }
                        : {}),
                };
                planned.push({ existing: true, id: node.id, patch });
                // Only a text change invalidates the vector; re-embedding on an
                // audience edit would burn a call to store the same numbers.
                if (node.text !== undefined && node.text !== existing.text) {
                    embed.push({ id: node.id, text: node.text });
                }
                if (node.file) {
                    files.push({ id: node.id, source: node.file.source, target: patch });
                }
                continue;
            }

            const ref = node.ref!;
            if (ref in ids) {
                throw new MemoryError(`${where}: two nodes share the ref "${ref}"`);
            }
            if (node.text === undefined || !node.text.trim()) {
                throw new MemoryError(
                    `${where}: a new node needs text`,
                    'text is the only thing a search can match, so it has to describe the node',
                );
            }
            const kind = this.#kind(node.kind, where);
            const id = opts.clock.newId();
            ids[ref] = id;
            const draft: NodeDraft = {
                id,
                kind,
                text: node.text,
                audience: audience ?? [ALL_AGENTS],
                ...(node.metadata !== undefined ? { metadata: node.metadata } : {}),
            };
            planned.push({ existing: false, id, draft });
            embed.push({ id, text: node.text });
            if (node.file) {
                files.push({ id, source: node.file.source, target: draft });
            }
        }

        const resolved = edges.map((edge, i) => {
            const where = `edges[${i}]`;
            const relation = edge.relation;
            if (!this.#relations.has(relation)) {
                throw new MemoryError(
                    `${where}: unknown relation "${relation}"`,
                    `use one of ${[...this.#relations].join(', ')}`,
                );
            }
            return {
                source: this.#endpoint(edge.from, ids, where),
                target: this.#endpoint(edge.to, ids, where),
                relation: relation as Relation,
            };
        });

        return { ids, nodes: planned, edges: resolved, files, embed };
    }

    #endpoint(name: string, ids: Record<string, string>, where: string): string {
        const id = ids[name];
        if (id) {
            return id;
        }
        if (this.graph.has(name)) {
            return name;
        }
        throw new MemoryError(
            `${where}: "${name}" is neither a ref in this commit nor an existing memory id`,
        );
    }

    #kind(kind: string | undefined, where: string): string {
        if (kind === undefined) {
            throw new MemoryError(`${where}: a new node needs a kind`);
        }
        if (!this.#kinds.has(kind)) {
            throw new MemoryError(
                `${where}: unknown kind "${kind}"`,
                `use one of ${[...this.#kinds].join(', ')}`,
            );
        }
        return kind;
    }

    /** An agent can only label a node with something it was granted. */
    #audience(node: CommitNode, writes: readonly string[], where: string): string[] | undefined {
        if (!node.audience?.length) {
            return undefined;
        }
        for (const label of node.audience) {
            if (!writes.includes(label)) {
                throw new MemoryError(
                    `${where}: not allowed to label a memory "${label}"`,
                    `this agent may write ${writes.join(', ') || 'nothing'}`,
                );
            }
        }
        return [...node.audience];
    }

    async #embed(texts: string[], taskType: 'query' | 'document'): Promise<number[][] | undefined> {
        if (!this.#embedder || !texts.length) {
            return undefined;
        }
        const res = await this.#embedder.embed({ input: texts, taskType });
        this.store.adopt({ model: this.#embedder.id, dimensions: res.dimensions });
        return res.vectors;
    }
}

type PlannedNode =
    | { existing: false; id: string; draft: NodeDraft }
    | { existing: true; id: string; patch: NodePatch };

/** Whitespace and case are not what makes two memories different. */
function flatten(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface PlannedFile {
    id: string;
    source: string;
    /** the draft or patch the copied file's record is written into */
    target: { file?: MemoryFile };
}

interface Plan {
    ids: Record<string, string>;
    nodes: PlannedNode[];
    edges: { source: string; target: string; relation: Relation }[];
    files: PlannedFile[];
    embed: { id: string; text: string }[];
}
