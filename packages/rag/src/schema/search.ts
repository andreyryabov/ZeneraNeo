import type { Embedder } from '@zenera/neo';
import { assertSameEmbedding } from '../common/manifest.ts';
import type { EntityRecord } from './entities.ts';
import { openIndex, type Manifest, type OpenIndex } from './files.ts';
import type { ApiGraph } from './graph.ts';
import type { Schema } from './schema.ts';
import type { Operation } from './spec.ts';
import { EntityStore, type StoreFilter } from './store.ts';
import {
    DEFAULT_MAX_HOPS,
    DEFAULT_MAX_NODES,
    stitch,
    type Seed,
    type Subgraph,
} from './subgraph.ts';

// ---------------------------------------------------------------------------
// The one way in
//
// Every surface — the command, the prompt loop, the tools an agent is given —
// calls `SchemaIndex.search`. None of them own any retrieval logic, because
// three copies of a ranking rule is three answers to the same question.
//
// A query is a handful of *fields*, not one string, and the field a phrase
// arrives in is what decides the filter it runs under: `output_properties`
// means kind=property and direction on the output side, and nothing about that
// has to be spelled out again by the caller.
// ---------------------------------------------------------------------------

export type DirectionFilter = 'input' | 'output' | 'any';

export type MethodTypeFilter = 'read_only' | 'read_write' | 'any';

export interface SchemaQuery {
    /** searched against everything, unfiltered */
    all?: readonly string[];

    methods?: readonly string[];
    method_type?: MethodTypeFilter;

    types?: readonly string[];
    input_types?: readonly string[];
    output_types?: readonly string[];

    properties?: readonly string[];
    input_properties?: readonly string[];
    output_properties?: readonly string[];
    /** the side `types` and `properties` are read on; the explicit fields override it */
    direction?: DirectionFilter;

    exclude_ids?: readonly string[];
    exclude_methods?: readonly string[];
    exclude_types?: readonly string[];
    exclude_properties?: readonly string[];

    /** seeds kept per query string */
    limit?: number;
    max_hops?: number;
    max_nodes?: number;
}

export interface SearchResult {
    seeds: Seed[];
    subgraphs: Subgraph[];
    /** query strings that matched nothing once exclusions were applied */
    empty: string[];
}

export const DEFAULT_LIMIT = 5;

/** Reciprocal rank fusion; the constant is the usual one and damps the top. */
const RRF_K = 60;

interface Term {
    field: string;
    text: string;
    filter: StoreFilter;
}

export class SchemaIndex {
    readonly manifest: Manifest;
    readonly graph: ApiGraph;
    readonly #index: OpenIndex;
    readonly #store: EntityStore;
    readonly #embedder: Embedder;

    constructor(index: OpenIndex, store: EntityStore, embedder: Embedder) {
        this.manifest = index.manifest;
        this.graph = index.graph;
        this.#index = index;
        this.#store = store;
        this.#embedder = embedder;
    }

    static async open(dir: string, embedder: Embedder): Promise<SchemaIndex> {
        const index = await openIndex(dir);
        assertSameEmbedding(index.manifest, embedder.id);
        return new SchemaIndex(index, await EntityStore.open(dir), embedder);
    }

    schemas(): Promise<Record<string, Schema>> {
        return this.#index.schemas();
    }

    operations(): Promise<Operation[]> {
        return this.#index.operations();
    }

    close(): void {
        this.#store.close();
    }

    async search(query: SchemaQuery, signal?: AbortSignal): Promise<SearchResult> {
        const terms = termsOf(query);
        if (terms.length === 0) {
            return { seeds: [], subgraphs: [], empty: [] };
        }

        const limit = query.limit ?? DEFAULT_LIMIT;
        const excluded = exclusion(query);
        const response = await this.#embedder.embed({
            input: terms.map((t) => t.text),
            taskType: 'query',
            signal,
        });

        const seeds: Seed[] = [];
        const empty: string[] = [];

        for (const [at, term] of terms.entries()) {
            const vector = Float32Array.from(response.vectors[at]!);
            // Over-fetch by what may be thrown away, so an exclusion list
            // shortens the answer instead of emptying it.
            const hits = await this.#store.search(
                term.text,
                vector,
                term.filter,
                limit + Math.min(excluded.size, limit * 4),
            );
            const kept = hits.filter((hit) => !excluded.has(hit.record)).slice(0, limit);
            if (kept.length === 0) {
                empty.push(term.text);
            }
            for (const hit of kept) {
                seeds.push({
                    id: hit.record.id,
                    term: term.text,
                    field: term.field,
                    score: 1 / (RRF_K + hit.rank),
                });
            }
        }

        const subgraphs = stitch(this.graph, seeds, {
            maxHops: query.max_hops ?? DEFAULT_MAX_HOPS,
            maxNodes: query.max_nodes ?? DEFAULT_MAX_NODES,
        });
        return { seeds, subgraphs, empty };
    }
}

// ---------------------------------------------------------------------------

function termsOf(query: SchemaQuery): Term[] {
    const method = methodTypes(query.method_type);
    const loose = query.direction ?? 'any';

    return [
        ...group(query.all, 'all', { methodTypes: method.mixed }),
        ...group(query.methods, 'methods', { kinds: ['method'], methodTypes: method.only }),
        ...group(query.types, 'types', { kinds: ['type'], directions: sides(loose) }),
        ...group(query.input_types, 'input_types', { kinds: ['type'], directions: sides('input') }),
        ...group(query.output_types, 'output_types', {
            kinds: ['type'],
            directions: sides('output'),
        }),
        ...group(query.properties, 'properties', {
            kinds: ['property'],
            directions: sides(loose),
        }),
        ...group(query.input_properties, 'input_properties', {
            kinds: ['property'],
            directions: sides('input'),
        }),
        ...group(query.output_properties, 'output_properties', {
            kinds: ['property'],
            directions: sides('output'),
        }),
    ];
}

function group(texts: readonly string[] | undefined, field: string, filter: StoreFilter): Term[] {
    return (texts ?? [])
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ field, text, filter }));
}

function sides(direction: DirectionFilter): string[] | undefined {
    return direction === 'any' ? undefined : [direction, 'both'];
}

/**
 * A method-type filter is about methods. Applied whole to an unfiltered query
 * it would also throw away every type and property, since those carry `n/a`.
 */
function methodTypes(filter: MethodTypeFilter | undefined): {
    only?: string[];
    mixed?: string[];
} {
    if (!filter || filter === 'any') {
        return {};
    }
    return { only: [filter], mixed: [filter, 'n/a'] };
}

interface Exclusion {
    has(record: EntityRecord): boolean;
    size: number;
}

function exclusion(query: SchemaQuery): Exclusion {
    const ids = new Set(query.exclude_ids ?? []);
    const methods = new Set(query.exclude_methods ?? []);
    const types = new Set(query.exclude_types ?? []);
    const properties = new Set(query.exclude_properties ?? []);
    const size = ids.size + methods.size + types.size + properties.size;

    return {
        size,
        has(record) {
            if (ids.has(record.id)) {
                return true;
            }
            switch (record.kind) {
                case 'method':
                    return methods.has(record.name);
                case 'type':
                    return types.has(record.name);
                default:
                    return properties.has(record.name);
            }
        },
    };
}
