import { tool, type AnyTool } from '@zenera/neo';
import { FORMATS, isFormat, present, type Format } from '../present.ts';
import { isEmpty, parseQuery, QueryError } from '../query.ts';
import { toTypeScript } from './hydrate.ts';
import type { SchemaIndex, SchemaQuery } from './search.ts';
import { stitch, type Subgraph } from './subgraph.ts';

// ---------------------------------------------------------------------------
// The same index, given to an agent
//
// Four tools over one engine. Three of them search, and the fourth deliberately
// does not: `find_types_with_property` is a graph lookup, for the moment after
// the compiler says `'password' does not exist in type 'PublicUserProfile'`.
// At that point the model does not need to be reminded what a password is —
// it needs the list of types that have one, and an embedding of the word will
// only rank the guess it already made near the top again.
// ---------------------------------------------------------------------------

const GROUP = 'schema';

/** Kept small on purpose: a tool result is prompt, and the model asked for one thing. */
const DEFAULT_LIMIT = 4;
const DEFAULT_MAX_NODES = 60;
const MAX_CANDIDATES = 25;

export interface SchemaToolOptions {
    /** what `format` defaults to when the model does not say */
    format?: Format;
    docs?: boolean;
}

export function schemaTools<TCtx = unknown>(
    index: SchemaIndex,
    options: SchemaToolOptions = {},
): AnyTool<TCtx>[] {
    const fallback = options.format ?? 'text';
    const docs = options.docs ?? true;

    const searchApi = tool<SchemaQuery & { format?: string }, TCtx>({
        name: 'search_api',
        group: GROUP,
        description:
            'Searches the API description and answers with the connected piece of it that ' +
            'matched: the operations, the schemas they carry and the fields inside them. ' +
            'Put the intent in the field that matches what is wanted — a request field in ' +
            'input_properties, a response field in output_properties — rather than putting ' +
            'everything in `all`, which cannot filter. Pass the ids from a previous answer ' +
            'in exclude_ids to be shown something new instead of the same thing again.',
        parameters: {
            type: 'object',
            properties: {
                all: list('Free search over operations, schemas and fields alike.'),
                methods: list('What the call does, e.g. "reset a user password".'),
                types: list('What the schema is, e.g. "a billing invoice".'),
                input_types: list('Schemas a call accepts.'),
                output_types: list('Schemas a call returns.'),
                properties: list('Fields or parameters, either side.'),
                input_properties: list('Fields in a request body, or query/path parameters.'),
                output_properties: list('Fields in a response body.'),
                direction: {
                    type: 'string',
                    enum: ['input', 'output', 'any'],
                    description: 'Which side `types` and `properties` are read on.',
                },
                method_type: {
                    type: 'string',
                    enum: ['read_only', 'read_write', 'any'],
                    description: 'read_only is GET/HEAD/OPTIONS; read_write is everything else.',
                },
                exclude_ids: list('Node ids already seen, as printed in an earlier answer.'),
                exclude_methods: list('Operation names to leave out.'),
                exclude_types: list('Schema names to leave out.'),
                exclude_properties: list('Field names to leave out.'),
                limit: {
                    type: 'integer',
                    description: `Results per phrase. Default ${DEFAULT_LIMIT}.`,
                },
                max_nodes: {
                    type: 'integer',
                    description: `Largest answer, in nodes. Default ${DEFAULT_MAX_NODES}.`,
                },
                format: {
                    type: 'string',
                    enum: [...FORMATS],
                    description: `How to write it. Default ${fallback}. Use "ts" to get types to code against.`,
                },
            },
            additionalProperties: false,
        },
        execute: async (args) => {
            const { format, ...rest } = args;
            let query: SchemaQuery;
            try {
                query = parseQuery(rest);
            } catch (err) {
                return {
                    error: err instanceof QueryError ? err.message : String(err),
                };
            }
            if (isEmpty(query)) {
                return { error: 'nothing was asked for', hint: 'fill at least one search field' };
            }

            const result = await index.search({
                limit: DEFAULT_LIMIT,
                max_nodes: DEFAULT_MAX_NODES,
                ...query,
            });
            if (result.subgraphs.length === 0) {
                return { found: 0, hint: 'try fewer words, or `all` instead of a narrower field' };
            }
            return {
                found: result.subgraphs.length,
                ids: result.subgraphs.flatMap((s) => s.hits),
                truncated: result.subgraphs.some((s) => s.truncated),
                api: await present(index, result.subgraphs, chosen(format, fallback), { docs }),
            };
        },
    });

    const describeTypes = tool<{ names: string[]; only?: string[] }, TCtx>({
        name: 'describe_types',
        group: GROUP,
        description:
            'Prints named schemas as TypeScript declarations, together with everything they ' +
            'refer to, so the result compiles on its own. Use it once search has named a ' +
            'schema and the exact fields are what is needed.',
        parameters: {
            type: 'object',
            properties: {
                names: list('Schema names, e.g. ["ResetPasswordPayload"]. Not node ids.'),
                only: list('Restrict every schema to these field names.'),
            },
            required: ['names'],
            additionalProperties: false,
        },
        execute: async ({ names, only }) => {
            const known = names.filter((name) => index.graph.hasNode(`Type:${name}`));
            const missing = names.filter((name) => !known.includes(name));
            if (known.length === 0) {
                return {
                    error: `no such schema: ${names.join(', ')}`,
                    hint: 'search for it first',
                };
            }
            const schemas = await index.schemas();
            const sub = subgraphOf(
                index,
                known.map((name) => `Type:${name}`),
            );
            const code = toTypeScript(sub, schemas, { docs, onlyHits: false });
            return {
                typescript: only?.length ? narrow(code, only) : code,
                ...(missing.length > 0 ? { missing } : {}),
            };
        },
    });

    const findTypesWithProperty = tool<{ property: string; direction?: string }, TCtx>({
        name: 'find_types_with_property',
        group: GROUP,
        description:
            'Lists every schema that has a field of this name. Exact lookup, no searching: ' +
            'reach for it when a field was put on the wrong type and the right one has to be ' +
            'found, for instance after a compiler error saying the property does not exist.',
        parameters: {
            type: 'object',
            properties: {
                property: { type: 'string', description: 'The field name, e.g. "password".' },
                direction: {
                    type: 'string',
                    enum: ['input', 'output', 'any'],
                    description: 'Only schemas used on this side of a call.',
                },
            },
            required: ['property'],
            additionalProperties: false,
        },
        execute: async ({ property, direction }) => {
            const wanted = property.toLowerCase();
            const candidates: Record<string, unknown>[] = [];

            index.graph.forEachNode((id, a) => {
                if (a.kind !== 'property' || a.name.toLowerCase() !== wanted || !a.parent) {
                    return;
                }
                const owner = index.graph.getNodeAttributes(`Type:${a.parent}`) ?? a;
                if (direction && direction !== 'any' && !onSide(owner.direction, direction)) {
                    return;
                }
                candidates.push({
                    type: a.parent,
                    id,
                    signature: a.signature,
                    required: a.required,
                    direction: owner.direction,
                    doc: a.doc || owner.doc,
                });
            });

            return candidates.length === 0
                ? { found: 0, hint: 'try search_api with the field in input_properties' }
                : { found: candidates.length, candidates: candidates.slice(0, MAX_CANDIDATES) };
        },
    });

    const listMethods = tool<{ contains?: string; method_type?: string }, TCtx>({
        name: 'list_methods',
        group: GROUP,
        description:
            'Lists operations by path, with no searching. Use it to see the shape of the API ' +
            'before deciding what to ask for.',
        parameters: {
            type: 'object',
            properties: {
                contains: { type: 'string', description: 'Only paths holding this text.' },
                method_type: {
                    type: 'string',
                    enum: ['read_only', 'read_write', 'any'],
                },
            },
            additionalProperties: false,
        },
        execute: async ({ contains, method_type }) => {
            const needle = contains?.toLowerCase();
            const rows: string[] = [];
            index.graph.forEachNode((_id, a) => {
                if (a.kind !== 'method') {
                    return;
                }
                if (needle && !a.path.toLowerCase().includes(needle)) {
                    return;
                }
                if (method_type && method_type !== 'any' && a.methodType !== method_type) {
                    return;
                }
                rows.push(`${a.httpMethod} ${a.path}  ${a.name}${a.doc ? ` — ${a.doc}` : ''}`);
            });
            return { found: rows.length, methods: rows.sort() };
        },
    });

    return [searchApi, describeTypes, findTypesWithProperty, listMethods];
}

// ---------------------------------------------------------------------------

function list(description: string): Record<string, unknown> {
    return { type: 'array', items: { type: 'string' }, description };
}

function chosen(format: string | undefined, fallback: Format): Format {
    return format && isFormat(format) ? format : fallback;
}

function onSide(direction: string, wanted: string): boolean {
    return direction === wanted || direction === 'both';
}

function subgraphOf(index: SchemaIndex, ids: readonly string[]): Subgraph {
    const [first] = stitch(
        index.graph,
        ids.map((id) => ({ id, term: id, field: 'describe', score: 1 })),
        { maxNodes: DEFAULT_MAX_NODES * ids.length },
    );
    return first ?? { nodes: [], edges: [], hits: [], score: 0, truncated: false };
}

/** Keeps the declarations, drops the field lines nobody asked about. */
function narrow(code: string, only: readonly string[]): string {
    const wanted = new Set(only);
    return code
        .split('\n')
        .filter((line) => {
            const field = /^\s{4}'?([A-Za-z0-9_$-]+)'?\??:/.exec(line);
            return !field || wanted.has(field[1]!);
        })
        .join('\n');
}
