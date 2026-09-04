import type { ApiGraph, NodeAttrs, NodeKind, Relation } from './graph.ts';
import { listNodes } from './lookup.ts';
import type { Matcher } from './match.ts';

// ---------------------------------------------------------------------------
// Upwards, to the calls
//
// Everything else here reads the graph sideways. This reads it the one way a
// person actually needs it read: from a field they can name to the operations
// that carry it, which is the only place they can do anything about it.
//
// Done by hand it is three searches and a guess. `audit_password` sits on
// `NodeUserSettings`; nothing calls that, so you look for what holds it, find
// `TransportNodePlacementConfig`, and look again for what accepts *that* — and
// the answer is only right if you got every branch. It is a breadth-first walk
// up containment, so it is one command, it is complete, and it says which side
// of the call each answer is on.
//
// A ranking cannot do this at all. The operation that takes a field usually
// does not mention it: `POST /transport-nodes` and `audit_password` have no
// word in common, which is exactly why the edge between them was built.
// ---------------------------------------------------------------------------

export type Side = 'input' | 'output' | 'both';

export interface Route {
    /** the operation node */
    id: string;
    attributes: NodeAttrs;
    /** whether the call accepts what was traced, returns it, or both */
    direction: Side;
    /** the nodes in between, nearest the operation first */
    via: string[];
    hops: number;
}

export interface Trace {
    id: string;
    attributes: NodeAttrs;
    /** how many operations reach it, whatever was kept */
    found: number;
    routes: Route[];
    truncated: boolean;
}

export interface Traced {
    /** how many nodes were traced, whatever was kept */
    found: number;
    traces: Trace[];
    truncated: boolean;
}

export interface TraceFilter {
    /** node ids to start from, taken as given */
    ids?: readonly string[];
    /** which kinds a `name` may match; all three when unset */
    kinds?: readonly NodeKind[];
    name?: readonly Matcher[];
    source?: string;
    /** starting nodes kept */
    limit?: number;
    /** routes kept per starting node */
    maxRoutes?: number;
    maxHops?: number;
}

/** How far containment is read backwards before a route is too indirect to mean anything. */
export const DEFAULT_TRACE_HOPS = 8;

/** A walk is bounded; a document can always be larger than the one this was written against. */
const MAX_VISITS = 20_000;

/**
 * What a bare pattern matches. Operations are left out on purpose: they are
 * where a trace ends, so starting one at an operationId that happens to share
 * a word adds a row saying only that it found itself. Naming a `Method:` id
 * outright still works.
 */
const KINDS: readonly NodeKind[] = ['type', 'property'];

/** The edges an operation holds its payload by. Reaching one of these is arriving. */
const ENTRY: ReadonlySet<Relation> = new Set(['TAKES_INPUT', 'RETURNS_OUTPUT', 'HAS_PARAM']);

/** Containment, read backwards: a type to the fields that hold it, a field to its owner. */
const UPWARD: ReadonlySet<Relation> = new Set(['HAS_PROPERTY', 'OF_TYPE', 'COMPOSES', 'ITEM_OF']);

export function traceNodes(graph: ApiGraph, filter: TraceFilter): Traced {
    const starts = select(graph, filter);
    const kept =
        filter.limit && filter.limit < starts.length ? starts.slice(0, filter.limit) : starts;

    return {
        found: starts.length,
        truncated: kept.length < starts.length,
        traces: kept.map((id) => traceOne(graph, id, filter)),
    };
}

export function traceOne(graph: ApiGraph, id: string, filter: TraceFilter = {}): Trace {
    const attributes = graph.getNodeAttributes(id);
    // An operation is already where a trace ends; it reaches itself and nothing above it.
    const routes =
        attributes.kind === 'method'
            ? [{ id, attributes, direction: 'both' as Side, via: [], hops: 0 }]
            : climb(graph, id, filter.maxHops ?? DEFAULT_TRACE_HOPS);

    const limit = filter.maxRoutes;
    return {
        id,
        attributes,
        found: routes.length,
        routes: limit && limit < routes.length ? routes.slice(0, limit) : routes,
        truncated: Boolean(limit && limit < routes.length),
    };
}

/**
 * The chain from an operation down to the node that was traced, as one line.
 * A field is written onto the type above it (`User.email`) and a parameter is
 * marked (`?page_size`), so the shape of the call can be read off the route
 * without going and looking any of it up.
 */
export function chainOf(graph: ApiGraph, start: string, route: Route): string {
    let out = '';
    for (const id of [...route.via, start]) {
        const label = labelOf(graph, id);
        out += out === '' || label.startsWith('.') ? label : ` → ${label}`;
    }
    return out;
}

// ---------------------------------------------------------------------------

function labelOf(graph: ApiGraph, id: string): string {
    const a = graph.getNodeAttributes(id);
    if (a.kind !== 'property') {
        return a.name;
    }
    // A parameter belongs to a call rather than to a type, so it cannot be
    // written as a field of the thing before it.
    return id.includes('#') ? `?${a.name}` : `.${a.name}`;
}

function select(graph: ApiGraph, filter: TraceFilter): string[] {
    const out = new Set((filter.ids ?? []).filter((id) => graph.hasNode(id)));
    if (filter.name) {
        for (const kind of filter.kinds ?? KINDS) {
            for (const row of listNodes(graph, { kind, name: filter.name, source: filter.source })
                .rows) {
                out.add(row.id);
            }
        }
    }
    return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * Breadth-first up containment, recording an operation the moment one is
 * reached. Breadth-first is what makes the answer the *shortest* way in: a
 * type held by a wrapper held by a request body should be reported through
 * the body, not through whichever branch happened to be walked first.
 */
function climb(graph: ApiGraph, start: string, maxHops: number): Route[] {
    const previous = new Map<string, string>();
    const seen = new Set([start]);
    const found = new Map<string, Route>();
    let frontier = [start];

    for (let hop = 0; hop <= maxHops && frontier.length > 0 && seen.size < MAX_VISITS; hop++) {
        const next: string[] = [];
        for (const node of frontier) {
            for (const edge of graph.inEdges(node)) {
                const relation = graph.getEdgeAttribute(edge, 'relation');
                const from = graph.source(edge);

                if (ENTRY.has(relation)) {
                    arrive(found, {
                        id: from,
                        attributes: graph.getNodeAttributes(from),
                        direction: sideOf(relation),
                        via: upward(previous, start, node),
                        hops: hop + 1,
                    });
                } else if (UPWARD.has(relation) && !seen.has(from)) {
                    seen.add(from);
                    previous.set(from, node);
                    next.push(from);
                }
            }
        }
        frontier = next;
    }

    return [...found.values()].sort(
        (a, b) =>
            a.hops - b.hops ||
            a.attributes.path.localeCompare(b.attributes.path) ||
            a.attributes.httpMethod.localeCompare(b.attributes.httpMethod),
    );
}

/**
 * One operation, once. A call that both accepts and returns the same type is
 * two edges and one answer, and the honest word for that answer is `both`.
 */
function arrive(found: Map<string, Route>, route: Route): void {
    const existing = found.get(route.id);
    if (!existing) {
        found.set(route.id, route);
    } else if (existing.direction !== route.direction) {
        existing.direction = 'both';
    }
}

const sideOf = (relation: Relation): Side => (relation === 'RETURNS_OUTPUT' ? 'output' : 'input');

/** The nodes walked through, from the one holding the entry edge back down towards the start. */
function upward(previous: Map<string, string>, start: string, from: string): string[] {
    const out: string[] = [];
    let at = from;
    while (at !== start) {
        out.push(at);
        const below = previous.get(at);
        if (below === undefined) {
            break;
        }
        at = below;
    }
    return out;
}
