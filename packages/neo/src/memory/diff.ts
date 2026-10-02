import { DUPLICATE_SCORE } from './index.ts';
import type { MemoryStore } from './store.ts';
import { comparable, sameContent, twinKey } from './twin.ts';
import type { MemoryNode } from './types.ts';
import { overlap, tokenize } from './vectors.ts';

// ---------------------------------------------------------------------------
// What one memory holds that another did not
//
// The question after a run that started from a copy: what did it learn, what
// did it read, and what did it say again. A node it committed that `merge`
// would fold onto one already there is a re-commit — a call that bought
// nothing — so every added node carries its nearest neighbour in the base,
// scored, and is a twin by exactly the rule merge folds by.
//
// Read-only on both sides; nothing here takes a lock or writes.
// ---------------------------------------------------------------------------

export interface MemoryNearest {
    id: string;
    score: number;
    text: string;
}

export interface MemoryDiffAdded {
    node: MemoryNode;
    /** the closest comparable node the base held, if any */
    nearest?: MemoryNearest;
    /** `merge` would fold it onto `nearest`: the base already said this */
    twin: boolean;
}

export interface MemoryDiff {
    base: string;
    other: string;
    /** how `nearest` was scored: cosine when both sides hold vectors, else term overlap */
    by: 'vector' | 'text';
    added: MemoryDiffAdded[];
    revised: { before: MemoryNode; after: MemoryNode }[];
    /** base nodes `memory_load` returned since — what the run actually read */
    used: { node: MemoryNode; loads: number }[];
    removed: MemoryNode[];
    /** edges `other` has that `base` did not */
    edges: number;
    supersedes: { source: string; target: string }[];
}

export function diffMemories(base: MemoryStore, other: MemoryStore): MemoryDiff {
    const stale = base.graph.superseded();
    const block = base.vectors;
    const theirs = other.vectors;
    const byVector = !!block?.rows && !!theirs && theirs.dims === block.dims;
    const held = base.graph.nodes();
    const lexical = new Map(held.filter((n) => !stale.has(n.id)).map((n) => [twinKey(n), n.id]));

    const nearestOf = (node: MemoryNode): { nearest?: MemoryNearest; twin: boolean } => {
        if (node.file) {
            return { twin: false };
        }
        const allow = (id: string): boolean => {
            const n = base.graph.get(id);
            return !stale.has(id) && !!n && comparable(n, node);
        };
        const exact = lexical.get(twinKey(node));
        const vector = byVector ? theirs!.get(node.id) : undefined;
        if (vector) {
            const hit = block!.topK(vector, 1, allow)[0];
            if (hit) {
                const text = base.graph.get(hit.id)!.text;
                return {
                    nearest: { id: hit.id, score: hit.score, text },
                    twin: hit.score >= DUPLICATE_SCORE,
                };
            }
        }
        if (exact) {
            return {
                nearest: { id: exact, score: 1, text: base.graph.get(exact)!.text },
                twin: true,
            };
        }
        const words = tokenize(node.text);
        let best: MemoryNearest | undefined;
        for (const n of held) {
            if (!allow(n.id)) {
                continue;
            }
            const score = overlap(words, tokenize(n.text));
            if (score > 0 && (!best || score > best.score)) {
                best = { id: n.id, score, text: n.text };
            }
        }
        return { nearest: best, twin: false };
    };

    const diff: MemoryDiff = {
        base: base.dir,
        other: other.dir,
        by: byVector ? 'vector' : 'text',
        added: [],
        revised: [],
        used: [],
        removed: [],
        edges: 0,
        supersedes: [],
    };

    for (const after of other.graph.nodes()) {
        const before = base.graph.get(after.id);
        if (!before) {
            diff.added.push({ node: after, ...nearestOf(after) });
            continue;
        }
        if (before.revision !== after.revision || !sameContent(before, after)) {
            diff.revised.push({ before, after });
        }
        if (after.useCount > before.useCount) {
            diff.used.push({ node: after, loads: after.useCount - before.useCount });
        }
    }
    for (const node of held) {
        if (!other.graph.has(node.id)) {
            diff.removed.push(node);
        }
    }

    const key = (source: string, target: string, relation: string): string =>
        `${source}\u0000${target}\u0000${relation}`;
    const had = new Set(base.graph.links().map((l) => key(l.source, l.target, l.attrs.relation)));
    for (const link of other.graph.links()) {
        if (had.has(key(link.source, link.target, link.attrs.relation))) {
            continue;
        }
        diff.edges++;
        if (link.attrs.relation === 'SUPERSEDES') {
            diff.supersedes.push({ source: link.source, target: link.target });
        }
    }

    const newest = (a: { node: MemoryNode }, b: { node: MemoryNode }): number =>
        b.node.createdAt.localeCompare(a.node.createdAt);
    diff.added.sort(newest);
    diff.used.sort((a, b) => b.loads - a.loads);
    return diff;
}
