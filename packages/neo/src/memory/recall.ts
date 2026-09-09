import type { MemoryGraph } from './graph.ts';
import {
    PREFERENCE_KIND,
    SPINE_RELATIONS,
    visible,
    type MemoryEdge,
    type MemoryNode,
    type MemoryQuery,
    type NodeVia,
    type Recollection,
    type ScoredNode,
} from './types.ts';
import { overlap, recencyDecay, tokenize, type VectorBlock } from './vectors.ts';

// ---------------------------------------------------------------------------
// From a question to a subgraph
//
// A ranked list of node ids is not an answer. A remembered script is worth
// having only alongside the request that asked for it and the endpoint it
// calls, and two hits are one memory only if the graph joins them. So ranking
// picks seeds and traversal decides what has to come with them.
//
// The budget is spent in tiers. Seeds first, then the spine — what a task
// produced, what an artifact calls, what replaced it — and only then the
// context that merely informed the work. A tight budget therefore degrades by
// dropping background rather than by truncating the answer itself.
//
// Superseded nodes are dropped, not deleted. A corrected script hides the one
// it replaced from every recall, while the history stays on disk for anyone
// asking how the correction came about.
// ---------------------------------------------------------------------------

export const DEFAULT_SEEDS = 5;
export const DEFAULT_MAX_HOPS = 2;

/** Past roughly this many nodes a rendered graph reads as soup, not structure. */
export const DEFAULT_MAX_NODES = 25;

/** Below this, a "match" is noise that costs context and buys nothing. */
export const DEFAULT_MIN_SCORE = 0.15;

const SEED = 0;
const LINK = 1;
const FILL = 2;

export interface RecallInput {
    graph: MemoryGraph;
    query: MemoryQuery;
    sees: readonly string[];
    /** the embedded query; absent ranks by term overlap instead */
    vector?: ArrayLike<number>;
    vectors?: VectorBlock;
    now?: number;
    /** include what has been superseded; off by default, on for an audit */
    stale?: boolean;
}

export function recall(input: RecallInput): Recollection {
    const seeds = rank(input);
    return stitch(input.graph, seeds, input.query, input.sees, input.stale ?? false);
}

/**
 * Decay orders, it does not admit. Relevance alone clears `minScore`, and
 * recency only breaks the tie afterwards — folding decay in before the
 * threshold would make every memory unreachable once it was old enough,
 * however exactly it matched, which is the opposite of outliving a run.
 */
export function rank(input: RecallInput): ScoredNode[] {
    const { graph, query, sees } = input;
    const now = input.now ?? Date.now();
    const limit = query.limit ?? DEFAULT_SEEDS;
    const minScore = query.minScore ?? DEFAULT_MIN_SCORE;
    const stale = input.stale ? new Set<string>() : graph.superseded(sees);
    const admissible = (n: MemoryNode) => eligible(n, query, sees) && !stale.has(n.id);

    let scored: { node: MemoryNode; score: number }[];
    if (input.vector && input.vectors) {
        const hits = input.vectors.topK(input.vector, limit * 4, (id) => {
            const node = graph.get(id);
            return !!node && admissible(node);
        });
        scored = hits.flatMap((h) => {
            const node = graph.get(h.id);
            return node ? [{ node, score: h.score }] : [];
        });
    } else {
        const terms = tokenize(query.text ?? '');
        scored = graph.nodes(sees).flatMap((node) => {
            if (!admissible(node)) {
                return [];
            }
            const score = terms.length ? overlap(terms, tokenize(node.text)) : 1;
            return score > 0 ? [{ node, score }] : [];
        });
    }

    // `score` stays the similarity the caller can reason about; the decayed
    // value exists only to order, and is not reported.
    return scored
        .filter((s) => s.score >= minScore)
        .map((s) => ({ ...s, rung: s.score * recencyDecay(s.node.lastUsedAt, now) }))
        .sort((a, b) => b.rung - a.rung)
        .slice(0, limit)
        .map((s) => ({ node: s.node, score: s.score, seed: true }));
}

function eligible(node: MemoryNode, query: MemoryQuery, sees: readonly string[]): boolean {
    if (!visible(node, sees)) {
        return false;
    }
    if (query.kinds?.length && !query.kinds.includes(node.kind)) {
        return false;
    }
    // A preference is in the system prompt already. Recalling one would state
    // the same standing instruction twice in two framings; asking for the kind
    // by name still finds it, which is how an agent checks for a duplicate
    // before committing another.
    if (!query.kinds?.length && node.kind === PREFERENCE_KIND) {
        return false;
    }
    if (query.newerThan && node.createdAt < query.newerThan) {
        return false;
    }
    return true;
}

/**
 * Breadth-first from every seed at once, so a node two hops from one seed loses
 * to a node one hop from another. Direction is ignored on the walk: a memory is
 * as often reached from the artifact back to the request as the other way.
 */
export function stitch(
    graph: MemoryGraph,
    seeds: readonly ScoredNode[],
    query: MemoryQuery,
    sees: readonly string[],
    stale = false,
): Recollection {
    const maxHops = query.maxHops ?? DEFAULT_MAX_HOPS;
    const maxNodes = query.maxNodes ?? DEFAULT_MAX_NODES;
    const superseded = stale ? new Set<string>() : graph.superseded(sees);

    const tier = new Map<string, number>();
    const scores = new Map<string, number>();
    // What admitted each node, which is the branch the renderer hangs it from.
    // A seed never gets one: its tier is 0 and no edge can better that.
    const via = new Map<string, NodeVia>();
    for (const seed of seeds) {
        tier.set(seed.node.id, SEED);
        scores.set(seed.node.id, seed.score);
    }

    let frontier = seeds.map((s) => s.node.id);
    for (let hop = 0; hop < maxHops && frontier.length; hop++) {
        const next: string[] = [];
        for (const id of frontier) {
            for (const edge of graph.neighbors(id, sees)) {
                const other = edge.source === id ? edge.target : edge.source;
                if (superseded.has(other)) {
                    continue;
                }
                const rung = SPINE_RELATIONS.has(edge.relation) ? LINK : FILL;
                const known = tier.get(other);
                if (known !== undefined && known <= rung) {
                    continue;
                }
                if (known === undefined) {
                    next.push(other);
                }
                tier.set(other, rung);
                via.set(other, { from: id, relation: edge.relation, outbound: edge.source === id });
            }
        }
        frontier = next;
    }

    // Seeds, then the spine, then context — and inside a tier, by seed score.
    const ranked = [...tier.entries()]
        .flatMap(([id, rung]) => {
            const node = graph.get(id);
            return node ? [{ node, rung, score: scores.get(id) ?? 0 }] : [];
        })
        .sort((a, b) => a.rung - b.rung || b.score - a.score);

    const kept = ranked.slice(0, maxNodes);
    const ids = new Set(kept.map((k) => k.node.id));
    const edges: MemoryEdge[] = graph.between(ids, sees);

    return {
        nodes: kept.map((k) => {
            const branch = via.get(k.node.id);
            return {
                node: k.node,
                score: k.score,
                seed: k.rung === SEED,
                ...(branch ? { via: branch } : {}),
            };
        }),
        edges,
        seeds: seeds.map((s) => s.node.id),
        truncated: ranked.length > kept.length,
    };
}
