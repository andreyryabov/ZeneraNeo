import { MultiDirectedGraph } from 'graphology';
import {
    edgeVisible,
    visible,
    type MemoryEdge,
    type MemoryEdgeAttrs,
    type MemoryNode,
    type Relation,
} from './types.ts';

// ---------------------------------------------------------------------------
// The graph itself — in memory, synchronous, and unaware of disk
//
// A thin wrapper over graphology rather than a leaky re-export, for two
// reasons. Masking has to be applied at every read, and a wrapper is the only
// place that can be true of; and edge identity has to be deterministic, so that
// committing the same link twice is one edge and a replayed commit is a no-op.
//
// Nothing here is async. Persistence is the store's problem, ranking is the
// ranker's, and keeping those out means the graph can be exercised in a test
// without a temp directory or an embedder.
// ---------------------------------------------------------------------------

export type Graphology = MultiDirectedGraph<MemoryNode, MemoryEdgeAttrs>;

export interface NodeDraft {
    id: string;
    kind: string;
    text: string;
    audience: string[];
    metadata?: Record<string, unknown>;
    file?: MemoryNode['file'];
}

export interface NodePatch {
    kind?: string;
    text?: string;
    audience?: string[];
    metadata?: Record<string, unknown>;
    file?: MemoryNode['file'];
    /** when given, the update fails unless the stored revision matches */
    expectedRevision?: number;
}

/** Deterministic, so the same link committed twice stays one edge. */
export const edgeKey = (source: string, target: string, relation: Relation): string =>
    `${source}|${relation}|${target}`;

export class MemoryGraph {
    readonly #graph: Graphology = new MultiDirectedGraph<MemoryNode, MemoryEdgeAttrs>();

    static from(serialized: unknown): MemoryGraph {
        const g = new MemoryGraph();
        g.#graph.import(serialized as Parameters<Graphology['import']>[0]);
        return g;
    }

    export(): ReturnType<Graphology['export']> {
        return this.#graph.export();
    }

    get order(): number {
        return this.#graph.order;
    }

    get size(): number {
        return this.#graph.size;
    }

    has(id: string): boolean {
        return this.#graph.hasNode(id);
    }

    get(id: string): MemoryNode | undefined {
        return this.#graph.hasNode(id) ? this.#graph.getNodeAttributes(id) : undefined;
    }

    add(draft: NodeDraft, at: string): MemoryNode {
        const node: MemoryNode = {
            id: draft.id,
            kind: draft.kind,
            text: draft.text,
            audience: draft.audience.length ? [...draft.audience] : ['*'],
            createdAt: at,
            updatedAt: at,
            lastUsedAt: at,
            useCount: 0,
            revision: 1,
            ...(draft.metadata ? { metadata: draft.metadata } : {}),
            ...(draft.file ? { file: draft.file } : {}),
        };
        this.#graph.addNode(node.id, node);
        return node;
    }

    update(id: string, patch: NodePatch, at: string): MemoryNode {
        const current = this.#graph.getNodeAttributes(id);
        if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
            throw new RevisionMismatch(id, patch.expectedRevision, current.revision);
        }
        const next: MemoryNode = {
            ...current,
            ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
            ...(patch.text !== undefined ? { text: patch.text } : {}),
            ...(patch.audience !== undefined ? { audience: [...patch.audience] } : {}),
            ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
            ...(patch.file !== undefined ? { file: patch.file } : {}),
            updatedAt: at,
            revision: current.revision + 1,
        };
        this.#graph.replaceNodeAttributes(id, next);
        return next;
    }

    /** Reading is what counts as use — see `memory_load`, not `memory_search`. */
    touch(id: string, at: string): MemoryNode | undefined {
        if (!this.#graph.hasNode(id)) {
            return undefined;
        }
        const node = this.#graph.getNodeAttributes(id);
        const next = { ...node, lastUsedAt: at, useCount: node.useCount + 1 };
        this.#graph.replaceNodeAttributes(id, next);
        return next;
    }

    link(source: string, target: string, relation: Relation, at: string): void {
        this.#graph.mergeEdgeWithKey(edgeKey(source, target, relation), source, target, {
            relation,
            createdAt: at,
        });
    }

    /** Drops the node and every edge touching it; the file it names is the store's to unlink. */
    forget(id: string): MemoryNode | undefined {
        const node = this.get(id);
        if (node) {
            this.#graph.dropNode(id);
        }
        return node;
    }

    nodes(sees?: readonly string[]): MemoryNode[] {
        const out: MemoryNode[] = [];
        this.#graph.forEachNode((_id, attrs) => {
            if (!sees || visible(attrs, sees)) {
                out.push(attrs);
            }
        });
        return out;
    }

    edges(sees?: readonly string[]): MemoryEdge[] {
        const out: MemoryEdge[] = [];
        this.#graph.forEachEdge((_key, attrs, source, target) => {
            if (sees && !this.#passable(source, target, attrs, sees)) {
                return;
            }
            out.push({ source, target, relation: attrs.relation });
        });
        return out;
    }

    /** Both directions: a memory is as often reached from its artifact as from its request. */
    neighbors(id: string, sees?: readonly string[]): MemoryEdge[] {
        if (!this.#graph.hasNode(id)) {
            return [];
        }
        const out: MemoryEdge[] = [];
        this.#graph.forEachEdge(id, (_key, attrs, source, target) => {
            if (sees && !this.#passable(source, target, attrs, sees)) {
                return;
            }
            out.push({ source, target, relation: attrs.relation });
        });
        return out;
    }

    /** Edges between nodes already chosen — what makes a materialized subgraph closed. */
    between(ids: Iterable<string>, sees?: readonly string[]): MemoryEdge[] {
        const set = new Set(ids);
        return this.edges(sees).filter((e) => set.has(e.source) && set.has(e.target));
    }

    /**
     * The nodes some visible node replaces. Recall drops these, which is what
     * makes a correction take effect without erasing what was corrected.
     */
    superseded(sees?: readonly string[]): Set<string> {
        const out = new Set<string>();
        this.#graph.forEachEdge((_key, attrs, source, target) => {
            if (attrs.relation !== 'SUPERSEDES') {
                return;
            }
            if (sees && !this.#passable(source, target, attrs, sees)) {
                return;
            }
            out.add(target);
        });
        return out;
    }

    #passable(
        source: string,
        target: string,
        attrs: MemoryEdgeAttrs,
        sees: readonly string[],
    ): boolean {
        return (
            edgeVisible(attrs, sees) &&
            visible(this.#graph.getNodeAttributes(source), sees) &&
            visible(this.#graph.getNodeAttributes(target), sees)
        );
    }
}

export class RevisionMismatch extends Error {
    readonly id: string;
    readonly expected: number;
    readonly actual: number;

    constructor(id: string, expected: number, actual: number) {
        super(`memory ${id} has revision ${actual}, not ${expected}`);
        this.name = 'RevisionMismatch';
        this.id = id;
        this.expected = expected;
        this.actual = actual;
    }
}
