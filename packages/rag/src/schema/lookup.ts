import { PatternError, type Matcher } from '../common/match.ts';
import { textOf } from './entities.ts';
import { methodId, type ApiGraph, type NodeAttrs, type NodeKind } from './graph.ts';

// ---------------------------------------------------------------------------
// The graph, read exhaustively
//
// One pass over `graph.json` and no store, no embedder, no credential. That is
// not an optimization — it is the contract. These answers are complete: what
// comes back is every node that matched, and the count is the true one even
// when the list was cut, so a caller can tell "there are three" from "there are
// three hundred and you are being shown three".
//
// The CLI and the agent tools both come through here. Two implementations of
// "list the operations" would be two answers to one question, and the whole
// reason for this file is that there be exactly one.
// ---------------------------------------------------------------------------

export interface Row extends NodeAttrs {
    id: string;
}

export interface ListFilter {
    kind: NodeKind;
    /** any one matching is enough; none means every name passes */
    name?: readonly Matcher[];
    path?: readonly Matcher[];
    source?: string;
    methodType?: string;
    direction?: string;
    limit?: number;
}

export interface Listing {
    /** how many matched, whatever was kept */
    found: number;
    rows: Row[];
    truncated: boolean;
}

export interface Match {
    id: string;
    attributes: NodeAttrs;
    /** the indexed text this matched against */
    text: string;
}

export interface GrepFilter {
    kinds?: readonly string[];
    source?: string;
    /** the same two constraints `list` takes, so one question has one spelling */
    name?: readonly Matcher[];
    path?: readonly Matcher[];
    limit?: number;
}

export interface Grep {
    found: number;
    matches: Match[];
    truncated: boolean;
}

/** A scan is bounded, because a pattern may have come from a model. */
const DEADLINE_MS = 2000;
const DEADLINE_EVERY = 500;

export function listNodes(graph: ApiGraph, filter: ListFilter): Listing {
    const rows: Row[] = [];

    graph.forEachNode((id, a) => {
        if (a.kind !== filter.kind || !passes(a, filter)) {
            return;
        }
        if (filter.name && !filter.name.some((match) => match(a.name))) {
            return;
        }
        if (filter.path && !matchesRoute(graph, id, a, filter.path)) {
            return;
        }
        rows.push({ ...a, id });
    });

    rows.sort(order(filter.kind));
    return cut(rows, filter.limit);
}

export function grepNodes(graph: ApiGraph, match: Matcher, filter: GrepFilter = {}): Grep {
    const kinds = filter.kinds?.length ? new Set(filter.kinds) : undefined;
    const matches: Match[] = [];
    const until = Date.now() + DEADLINE_MS;
    let seen = 0;

    for (const id of graph.nodes()) {
        if (++seen % DEADLINE_EVERY === 0 && Date.now() > until) {
            throw new PatternError(
                `the pattern is still running after ${DEADLINE_MS / 1000}s — it is too expensive to be useful`,
            );
        }
        const a = graph.getNodeAttributes(id);
        if (kinds && !kinds.has(a.kind)) {
            continue;
        }
        if (filter.source && a.source !== filter.source) {
            continue;
        }
        if (filter.name && !filter.name.some((match) => match(a.name))) {
            continue;
        }
        if (filter.path && !matchesRoute(graph, id, a, filter.path)) {
            continue;
        }
        const text = textOf(graph, id);
        if (match(text)) {
            matches.push({ id, attributes: a, text });
        }
    }

    matches.sort((a, b) => a.id.localeCompare(b.id));
    const kept = cut(matches, filter.limit);
    return { found: kept.found, matches: kept.rows, truncated: kept.truncated };
}

/** How many fields a type carries, which is most of what a listing wants to say. */
export function propertyCount(graph: ApiGraph, id: string): number {
    return graph
        .outEdges(id)
        .filter((e) => graph.getEdgeAttribute(e, 'relation') === 'HAS_PROPERTY').length;
}

/** That count, said properly, in the one phrasing the CLI and the tools share. */
export const fields = (n: number): string => `${n} ${n === 1 ? 'field' : 'fields'}`;

/**
 * The route a node sits on. An operation carries its own; a parameter carries
 * the operation's name instead, so it is looked up. A schema has no route at
 * all and never will — the same DTO is returned by half the API — which is
 * why a `--path` filter is a filter on the operations and what hangs off them.
 */
export function routeOf(graph: ApiGraph, id: string, a: NodeAttrs): string {
    if (a.path) {
        return a.path;
    }
    if (a.kind !== 'property' || !a.parent) {
        return '';
    }
    const owner = methodId(a.parent);
    return graph.hasNode(owner) ? graph.getNodeAttribute(owner, 'path') : '';
}

// ---------------------------------------------------------------------------

function matchesRoute(
    graph: ApiGraph,
    id: string,
    a: NodeAttrs,
    patterns: readonly Matcher[],
): boolean {
    const route = routeOf(graph, id, a);
    return route !== '' && patterns.some((match) => match(route));
}

function passes(a: NodeAttrs, filter: ListFilter): boolean {
    if (filter.source && a.source !== filter.source) {
        return false;
    }
    if (filter.methodType && a.methodType !== filter.methodType) {
        return false;
    }
    if (filter.direction && a.direction !== filter.direction && a.direction !== 'both') {
        return false;
    }
    return true;
}

/** Operations read as a table of routes; everything else reads as a list of names. */
function order(kind: NodeKind): (a: Row, b: Row) => number {
    if (kind !== 'method') {
        return (a, b) => a.id.localeCompare(b.id);
    }
    return (a, b) => a.path.localeCompare(b.path) || a.httpMethod.localeCompare(b.httpMethod);
}

function cut<T>(
    rows: T[],
    limit: number | undefined,
): { found: number; rows: T[]; truncated: boolean } {
    const found = rows.length;
    if (!limit || limit >= found) {
        return { found, rows, truncated: false };
    }
    return { found, rows: rows.slice(0, limit), truncated: true };
}
