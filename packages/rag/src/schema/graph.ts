import { MultiDirectedGraph } from 'graphology';
import { isObject, refName, type Schema } from './schema.ts';
import {
    methodTypeOf,
    type Corpus,
    type MethodType,
    type Operation,
    type ParamIn,
} from './spec.ts';
import { Printer } from './typescript.ts';

// ---------------------------------------------------------------------------
// The graph
//
// Three kinds of node and seven kinds of edge, and between them they answer
// the question a vector index cannot: *what is this connected to*. Finding
// `password` is a retrieval problem; knowing that it is reached by POSTing a
// `ResetPasswordPayload` to `/auth/reset-password` is a traversal one.
//
// A parameter is a `property` too, not a fourth kind. Someone asking for an
// input property called `page_size` means the query parameter, and having to
// know in advance whether a field lives in a body or a query string is exactly
// the knowledge they came here to get.
// ---------------------------------------------------------------------------

export type NodeKind = 'method' | 'type' | 'property';

export type Direction = 'input' | 'output' | 'both' | 'none';

export type Relation =
    | 'TAKES_INPUT'
    | 'HAS_PARAM'
    | 'RETURNS_OUTPUT'
    | 'HAS_PROPERTY'
    | 'OF_TYPE'
    | 'COMPOSES'
    | 'ITEM_OF';

export interface NodeAttrs {
    kind: NodeKind;
    name: string;
    /** owning type id for a property, operation id for a parameter, else '' */
    parent: string;
    doc: string;
    direction: Direction;
    methodType: MethodType | 'n/a';
    httpMethod: string;
    path: string;
    source: string;
    /** the TypeScript type expression, for properties */
    signature: string;
    required: boolean;
}

export interface EdgeAttrs {
    relation: Relation;
    /** on RETURNS_OUTPUT */
    status: number;
    /** on HAS_PARAM */
    in: ParamIn | '';
}

export type ApiGraph = MultiDirectedGraph<NodeAttrs, EdgeAttrs>;

export interface Built {
    graph: ApiGraph;
    /** every type the graph names, synthesized ones included */
    types: Record<string, Schema>;
}

export const methodId = (operationId: string): string => `Method:${operationId}`;
export const typeId = (name: string): string => `Type:${name}`;
export const propertyId = (parent: string, name: string): string => `Property:${parent}.${name}`;
export const paramId = (operationId: string, name: string): string =>
    `Property:${operationId}#${name}`;

/** How deep an anonymous object is given a name of its own before giving up. */
const MAX_SYNTHESIS_DEPTH = 4;

export function buildGraph(corpus: Corpus): Built {
    return new Builder(corpus).run();
}

class Builder {
    readonly #corpus: Corpus;
    readonly #graph: ApiGraph = new MultiDirectedGraph<NodeAttrs, EdgeAttrs>();
    readonly #types: Record<string, Schema>;
    /** property node -> the schema it was built from, for signatures at the end */
    readonly #schemas = new Map<string, unknown>();
    /** synthesized type -> how many levels of anonymity it sat under */
    readonly #depths = new Map<string, number>();
    readonly #source: Record<string, string>;
    readonly #queue: string[] = [];
    readonly #expanded = new Set<string>();

    constructor(corpus: Corpus) {
        this.#corpus = corpus;
        this.#types = { ...corpus.types };
        this.#source = { ...corpus.typeSource };
        this.#queue.push(...Object.keys(corpus.types));
    }

    run(): Built {
        for (const operation of this.#corpus.operations) {
            this.#operation(operation);
        }
        while (this.#queue.length > 0) {
            this.#expand(this.#queue.pop()!);
        }
        this.#signatures();
        propagate(this.#graph);
        return { graph: this.#graph, types: this.#types };
    }

    // -----------------------------------------------------------------------
    // Operations
    // -----------------------------------------------------------------------

    #operation(op: Operation): void {
        const id = methodId(op.operationId);
        this.#graph.mergeNode(id, {
            ...blank(),
            kind: 'method',
            name: op.operationId,
            doc: op.summary || op.description,
            methodType: methodTypeOf(op.method),
            httpMethod: op.method.toUpperCase(),
            path: op.path,
            source: op.source,
        });

        for (const param of op.params) {
            const node = paramId(op.operationId, param.name);
            this.#graph.mergeNode(node, {
                ...blank(),
                kind: 'property',
                name: param.name,
                parent: op.operationId,
                doc: param.doc,
                source: op.source,
                required: param.required,
            });
            this.#schemas.set(node, param.schema);
            this.#edge(id, node, { relation: 'HAS_PARAM', status: 0, in: param.in });

            const target = this.#resolve(
                param.schema,
                `${op.operationId}_${param.name}`,
                1,
                op.source,
            );
            if (target) {
                this.#edge(node, typeId(target), edge('OF_TYPE'));
            }
        }

        if (op.requestBody) {
            const target = this.#resolve(
                op.requestBody.schema,
                `${op.operationId}Request`,
                0,
                op.source,
            );
            if (target) {
                this.#edge(id, typeId(target), edge('TAKES_INPUT'));
            }
        }

        const many = op.responses.length > 1;
        for (const response of op.responses) {
            const preferred = many
                ? `${op.operationId}Response${response.status}`
                : `${op.operationId}Response`;
            const target = this.#resolve(response.schema, preferred, 0, op.source);
            if (target) {
                this.#edge(id, typeId(target), {
                    relation: 'RETURNS_OUTPUT',
                    status: response.status,
                    in: '',
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    /**
     * The type id a schema stands for, inventing one where the document did
     * not bother. An array is unwrapped first: `returns User[]` and
     * `returns User` are the same edge as far as reaching `User` goes, and
     * keeping a `UsersResponse` wrapper in between costs a hop and says nothing.
     */
    #resolve(
        schema: unknown,
        preferred: string,
        depth: number,
        source: string,
    ): string | undefined {
        if (!isObject(schema)) {
            return undefined;
        }
        const ref = refName(schema);
        if (ref !== undefined) {
            return this.#types[ref] ? ref : undefined;
        }
        if (schema.type === 'array' || schema.items !== undefined) {
            return this.#resolve(schema.items, preferred, depth, source);
        }
        if (!worthNaming(schema) || depth >= MAX_SYNTHESIS_DEPTH) {
            return undefined;
        }
        return this.#synthesize(preferred, schema, depth, source);
    }

    #synthesize(preferred: string, schema: Schema, depth: number, source: string): string {
        let name = preferred;
        for (let n = 2; this.#types[name]; n++) {
            name = `${preferred}${n}`;
        }
        this.#types[name] = schema;
        this.#source[name] = source;
        this.#depths.set(name, depth);
        this.#queue.push(name);
        return name;
    }

    #expand(name: string): void {
        if (this.#expanded.has(name)) {
            return;
        }
        this.#expanded.add(name);
        const schema = this.#types[name];
        if (!schema) {
            return;
        }
        const id = typeId(name);
        const depth = this.#depths.get(name) ?? 0;
        const source = this.#source[name] ?? '';
        this.#graph.mergeNode(id, {
            ...blank(),
            kind: 'type',
            name,
            doc: docOf(schema),
            source,
        });

        for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
            const list = schema[key];
            if (!Array.isArray(list)) {
                continue;
            }
            for (const member of list) {
                const target = refName(member);
                if (target && this.#types[target]) {
                    this.#edge(id, typeId(target), edge('COMPOSES'));
                }
            }
        }

        const items = this.#resolve(schema.items, `${name}Item`, depth + 1, source);
        if (items) {
            this.#edge(id, typeId(items), edge('ITEM_OF'));
        }

        const { properties, required } = flatten(schema, this.#types);
        for (const [key, value] of Object.entries(properties)) {
            const node = propertyId(name, key);
            this.#graph.mergeNode(node, {
                ...blank(),
                kind: 'property',
                name: key,
                parent: name,
                doc: docOf(value),
                source,
                required: required.has(key),
            });
            this.#schemas.set(node, value);
            this.#edge(id, node, edge('HAS_PROPERTY'));

            const target = this.#resolve(value, `${name}_${capital(key)}`, depth + 1, source);
            if (target) {
                this.#edge(node, typeId(target), edge('OF_TYPE'));
            }
        }
    }

    // -----------------------------------------------------------------------

    #edge(from: string, to: string, attrs: EdgeAttrs): void {
        if (!this.#graph.hasNode(to)) {
            this.#graph.addNode(to, { ...blank(), kind: 'type', name: to.slice(5) });
        }
        this.#graph.addDirectedEdge(from, to, attrs);
    }

    /** One printer over the settled corpus, so every signature agrees. */
    #signatures(): void {
        const printer = new Printer(this.#types);
        for (const [node, schema] of this.#schemas) {
            if (this.#graph.hasNode(node)) {
                this.#graph.setNodeAttribute(node, 'signature', printer.signature(schema));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

/**
 * Which side of a call a node lives on. Seeded from the operations — a request
 * body is an input, a response is an output — and then pushed down through
 * composition until it stops. A DTO used both ways comes out `both`, which is
 * the honest answer and the reason this is a closure rather than a flag set at
 * the point of use.
 */
export function propagate(graph: ApiGraph): void {
    const inputs = new Set<string>();
    const outputs = new Set<string>();

    graph.forEachDirectedEdge((_edge, attrs, _source, target) => {
        if (attrs.relation === 'TAKES_INPUT' || attrs.relation === 'HAS_PARAM') {
            inputs.add(target);
        } else if (attrs.relation === 'RETURNS_OUTPUT') {
            outputs.add(target);
        }
    });

    const DOWN: ReadonlySet<Relation> = new Set(['HAS_PROPERTY', 'OF_TYPE', 'COMPOSES', 'ITEM_OF']);

    for (const [seeds, mark] of [
        [inputs, 'input'],
        [outputs, 'output'],
    ] as const) {
        const seen = new Set<string>();
        const stack = [...seeds];
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (seen.has(node) || !graph.hasNode(node)) {
                continue;
            }
            seen.add(node);
            const was = graph.getNodeAttribute(node, 'direction');
            graph.setNodeAttribute(
                node,
                'direction',
                was === 'none' || was === mark ? mark : 'both',
            );
            graph.forEachOutEdge(node, (_e, attrs, _s, target) => {
                if (DOWN.has(attrs.relation)) {
                    stack.push(target);
                }
            });
        }
    }
}

// ---------------------------------------------------------------------------

function blank(): NodeAttrs {
    return {
        kind: 'type',
        name: '',
        parent: '',
        doc: '',
        direction: 'none',
        methodType: 'n/a',
        httpMethod: '',
        path: '',
        source: '',
        signature: '',
        required: false,
    };
}

function edge(relation: Relation): EdgeAttrs {
    return { relation, status: 0, in: '' };
}

/** Worth a node of its own: it has fields, or it is a choice between things. */
function worthNaming(schema: Schema): boolean {
    return (
        isObject(schema.properties) ||
        Array.isArray(schema.allOf) ||
        Array.isArray(schema.oneOf) ||
        Array.isArray(schema.anyOf)
    );
}

/**
 * The properties a type actually has. `allOf` with an inline member is how
 * most documents spell inheritance, and leaving those fields off the type that
 * declares them would hide them from every search.
 */
function flatten(
    schema: Schema,
    types: Readonly<Record<string, Schema>>,
    seen = new Set<Schema>(),
): { properties: Record<string, unknown>; required: Set<string> } {
    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    if (seen.has(schema)) {
        return { properties, required };
    }
    seen.add(schema);

    if (isObject(schema.properties)) {
        Object.assign(properties, schema.properties);
    }
    if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
            if (typeof key === 'string') {
                required.add(key);
            }
        }
    }
    for (const member of Array.isArray(schema.allOf) ? schema.allOf : []) {
        // A named member is a node in its own right, reached by COMPOSES.
        if (!isObject(member) || refName(member) !== undefined) {
            continue;
        }
        const inner = flatten(member, types, seen);
        Object.assign(properties, inner.properties);
        for (const key of inner.required) {
            required.add(key);
        }
    }
    return { properties, required };
}

function docOf(schema: unknown): string {
    if (!isObject(schema)) {
        return '';
    }
    const description = schema.description ?? schema.title;
    return typeof description === 'string' ? description.trim() : '';
}

function capital(key: string): string {
    const cleaned = key.replace(/[^A-Za-z0-9]+/g, '_');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
