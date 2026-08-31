import type { ApiGraph, NodeAttrs, Relation } from './graph.ts';

// ---------------------------------------------------------------------------
// From seeds to something worth reading
//
// A ranked list of node ids is not an answer. `password` is an answer only
// once it says which type carries it and which call takes that type, and two
// separate hits are one answer only if the graph joins them.
//
// So: expand each seed into its immediate surroundings, look for a short path
// between seeds that came from *different* query terms, and return whatever
// connected pieces fall out. Everything is bounded — a type with three hundred
// fields would otherwise be the whole reply.
//
// The paths are found with a plain bidirectional BFS over `graph.neighbors`,
// which on a directed graph is the union of both sides. That is the point:
// `POST /pets` reaches `Cat` by following an edge forwards and `Cat` reaches
// `Pet` by following one backwards, and a shortest-path routine that respected
// direction would find neither.
// ---------------------------------------------------------------------------

export interface Seed {
    id: string;
    /** the query string that found it */
    term: string;
    /** which field of the query that string came from */
    field: string;
    score: number;
}

export interface SubgraphNode {
    id: string;
    kind: string;
    attributes: NodeAttrs;
    /** the search found this one; everything else is here to connect it */
    hit: boolean;
    score: number;
}

export interface SubgraphEdge {
    source: string;
    target: string;
    relation: Relation;
    status: number;
    in: string;
}

export interface Subgraph {
    nodes: SubgraphNode[];
    edges: SubgraphEdge[];
    hits: string[];
    score: number;
    /** nodes were dropped to stay inside the budget */
    truncated: boolean;
}

export interface StitchOptions {
    maxHops?: number;
    maxNodes?: number;
}

export const DEFAULT_MAX_HOPS = 3;
export const DEFAULT_MAX_NODES = 200;

/** How many fields of one type are pulled in when the type itself was the hit. */
const FIELDS_PER_TYPE = 24;

const OWNS: ReadonlySet<Relation> = new Set(['HAS_PROPERTY', 'HAS_PARAM']);
const CALLS: ReadonlySet<Relation> = new Set(['TAKES_INPUT', 'RETURNS_OUTPUT']);

export function stitch(
    graph: ApiGraph,
    seeds: readonly Seed[],
    options: StitchOptions = {},
): Subgraph[] {
    const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

    const live = seeds.filter((s) => graph.hasNode(s.id));
    if (live.length === 0) {
        return [];
    }

    const scores = new Map<string, number>();
    for (const seed of live) {
        scores.set(seed.id, (scores.get(seed.id) ?? 0) + seed.score);
    }

    const keep = new Set<string>(scores.keys());
    for (const seed of live) {
        for (const node of anchor(graph, seed.id)) {
            keep.add(node);
        }
    }
    for (const node of connect(graph, live, maxHops)) {
        keep.add(node);
    }

    return components(graph, keep, scores).map((part) =>
        materialize(graph, part, scores, maxNodes),
    );
}

// ---------------------------------------------------------------------------

/** The nodes that make one hit legible on its own. */
function anchor(graph: ApiGraph, id: string): string[] {
    const kind = graph.getNodeAttribute(id, 'kind');
    const out: string[] = [];

    if (kind === 'property') {
        for (const owner of related(graph, id, 'in', OWNS)) {
            out.push(owner, ...related(graph, owner, 'in', CALLS));
        }
        // What the field is *of* matters as much as what holds it.
        out.push(...related(graph, id, 'out', new Set(['OF_TYPE'])));
        return out;
    }

    if (kind === 'type') {
        out.push(...related(graph, id, 'in', CALLS));
        out.push(...related(graph, id, 'out', new Set(['COMPOSES', 'ITEM_OF'])));
        out.push(...related(graph, id, 'out', OWNS).slice(0, FIELDS_PER_TYPE));
        return out;
    }

    for (const target of related(graph, id, 'out', new Set([...OWNS, ...CALLS]))) {
        out.push(target);
        // A parameter typed `Species` is part of reading the call, and is one
        // hop further out than anything else here.
        if (graph.getNodeAttribute(target, 'kind') === 'property') {
            out.push(...related(graph, target, 'out', new Set(['OF_TYPE'])));
        }
    }
    return out;
}

function related(
    graph: ApiGraph,
    id: string,
    side: 'in' | 'out',
    relations: ReadonlySet<Relation>,
): string[] {
    const edges = side === 'in' ? graph.inEdges(id) : graph.outEdges(id);
    const out: string[] = [];
    for (const edge of edges) {
        if (relations.has(graph.getEdgeAttribute(edge, 'relation'))) {
            out.push(side === 'in' ? graph.source(edge) : graph.target(edge));
        }
    }
    return [...new Set(out)];
}

/**
 * The joins between hits. Only pairs from different query terms are tried:
 * two properties found by the same phrase are already one thought, and paying
 * for a path between them buys nothing but hops.
 */
function connect(graph: ApiGraph, seeds: readonly Seed[], maxHops: number): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
            const a = seeds[i]!;
            const b = seeds[j]!;
            if (a.term === b.term || a.id === b.id) {
                continue;
            }
            for (const node of path(graph, a.id, b.id, maxHops) ?? []) {
                out.add(node);
            }
        }
    }
    return out;
}

/** Breadth-first, ignoring edge direction, giving up past `maxHops`. */
export function path(
    graph: ApiGraph,
    from: string,
    to: string,
    maxHops: number,
): string[] | undefined {
    if (from === to) {
        return [from];
    }
    const previous = new Map<string, string>([[from, from]]);
    let frontier = [from];

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
        const next: string[] = [];
        for (const node of frontier) {
            for (const neighbor of graph.neighbors(node)) {
                if (previous.has(neighbor)) {
                    continue;
                }
                previous.set(neighbor, node);
                if (neighbor === to) {
                    return trace(previous, from, to);
                }
                next.push(neighbor);
            }
        }
        frontier = next;
    }
    return undefined;
}

function trace(previous: Map<string, string>, from: string, to: string): string[] {
    const out = [to];
    while (out[0] !== from) {
        out.unshift(previous.get(out[0]!)!);
    }
    return out;
}

// ---------------------------------------------------------------------------

/** Connected pieces of the kept set, biggest score first. */
function components(
    graph: ApiGraph,
    keep: ReadonlySet<string>,
    scores: ReadonlyMap<string, number>,
): Set<string>[] {
    const seen = new Set<string>();
    const out: Set<string>[] = [];

    for (const start of keep) {
        if (seen.has(start)) {
            continue;
        }
        const part = new Set<string>();
        const stack = [start];
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (seen.has(node)) {
                continue;
            }
            seen.add(node);
            part.add(node);
            for (const neighbor of graph.neighbors(node)) {
                if (keep.has(neighbor) && !seen.has(neighbor)) {
                    stack.push(neighbor);
                }
            }
        }
        out.push(part);
    }

    return out.sort((a, b) => total(b, scores) - total(a, scores));
}

function total(part: ReadonlySet<string>, scores: ReadonlyMap<string, number>): number {
    let sum = 0;
    for (const node of part) {
        sum += scores.get(node) ?? 0;
    }
    return sum;
}

/**
 * Turns one component into a result, spending the node budget on the hits
 * first and then outwards from them, so what is dropped is always the part
 * furthest from anything anyone asked about.
 */
function materialize(
    graph: ApiGraph,
    part: ReadonlySet<string>,
    scores: ReadonlyMap<string, number>,
    maxNodes: number,
): Subgraph {
    const hits = [...part].filter((id) => scores.has(id));
    const kept = new Set<string>(hits.slice(0, maxNodes));
    let frontier = [...kept];

    while (kept.size < maxNodes && frontier.length > 0) {
        const next: string[] = [];
        for (const node of frontier) {
            for (const neighbor of graph.neighbors(node)) {
                if (!part.has(neighbor) || kept.has(neighbor) || kept.size >= maxNodes) {
                    continue;
                }
                kept.add(neighbor);
                next.push(neighbor);
            }
        }
        frontier = next;
    }

    const nodes: SubgraphNode[] = [...kept]
        .map((id) => ({
            id,
            kind: graph.getNodeAttribute(id, 'kind'),
            attributes: graph.getNodeAttributes(id),
            hit: scores.has(id),
            score: scores.get(id) ?? 0,
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const edges: SubgraphEdge[] = [];
    for (const id of kept) {
        for (const edge of graph.outEdges(id)) {
            const target = graph.target(edge);
            if (!kept.has(target)) {
                continue;
            }
            const attrs = graph.getEdgeAttributes(edge);
            edges.push({
                source: id,
                target,
                relation: attrs.relation,
                status: attrs.status,
                in: attrs.in,
            });
        }
    }

    return {
        nodes,
        edges: edges.sort(
            (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
        ),
        hits: hits.filter((id) => kept.has(id)),
        score: total(part, scores),
        truncated: kept.size < part.size,
    };
}
