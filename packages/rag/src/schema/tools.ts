import { tool, type AnyTool } from '@zenera/neo';
import { loose, matcher, PatternError } from '../common/match.ts';
import type { NodeKind } from './graph.ts';
import { toTypeScript } from './hydrate.ts';
import { fields, grepNodes, listNodes, propertyCount, type Row } from './lookup.ts';
import { FORMATS, isFormat, present, type Format } from './present.ts';
import { isEmpty, parseQuery, QueryError } from './query.ts';
import { sourceTag } from './render.ts';
import type { SchemaIndex, SchemaQuery } from './search.ts';
import { stitch, type Subgraph } from './subgraph.ts';
import { chainOf, traceNodes } from './trace.ts';

// ---------------------------------------------------------------------------
// The same index, given to an agent
//
// Six tools over one engine, and only one of them ranks anything. `search_api`
// is the way in when the question is vague; the other five are exact, because
// a model that has been told "no results" by a vector search has learned
// nothing — a ranking returns the top of a list, so an empty answer and an
// absent thing look identical.
//
// `find_types_with_property` is for the moment after the compiler says
// `'password' does not exist in type 'PublicUserProfile'`. At that point the
// model does not need to be reminded what a password is — it needs the list of
// types that have one. `grep_api` is the same instinct widened: every literal
// occurrence, counted in full, so "it is not there" can actually be concluded.
//
// `trace_api` is the other direction entirely. Having found a field, the next
// question is always which call carries it. `search_api` stitches part of the
// way there, but only between the nodes that ranked — and the operation and
// the field usually share no word at all, which is why the edge between them
// was built. `trace_api` follows that edge instead of ranking anything.
// ---------------------------------------------------------------------------

const GROUP = 'schema';

/** Kept small on purpose: a tool result is prompt, and the model asked for one thing. */
const DEFAULT_LIMIT = 4;
const DEFAULT_MAX_NODES = 60;
const MAX_CANDIDATES = 25;

/** A listing is lines rather than subgraphs, so it can afford more of them. */
const DEFAULT_ROWS = 50;
const MAX_ROWS = 200;

/** A trace is a paragraph per node, so fewer of them, and fewer routes each. */
const DEFAULT_TRACES = 5;
const MAX_TRACES = 25;
const DEFAULT_ROUTES = 10;

export interface SchemaToolOptions {
    /** what `format` defaults to when the model does not say */
    format?: Format;
    docs?: boolean;
    /** name the document each answer came from; on by default past one document */
    source?: boolean;
}

export function schemaTools<TCtx = unknown>(
    index: SchemaIndex,
    options: SchemaToolOptions = {},
): AnyTool<TCtx>[] {
    const fallback = options.format ?? 'text';
    const docs = options.docs ?? true;
    // With one document there is nothing to disambiguate and naming it on every
    // line is prompt spent saying the same word; with several it is the only
    // way to tell two revisions of one API apart.
    const source = options.source ?? index.manifest.sources.length > 1;
    const names = index.manifest.sources.map((s) => s.name);

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
                // Naming the documents is only a choice when there is more than
                // one, and an enum is what stops a model inventing a third.
                ...(names.length > 1
                    ? {
                          sources: {
                              type: 'array',
                              items: { type: 'string', enum: names },
                              description:
                                  'Search only these documents. Omit it to search all of them.',
                          },
                      }
                    : {}),
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
            const absent = (query.sources ?? []).filter((name) => !names.includes(name));
            if (absent.length > 0) {
                return {
                    error: `no document called ${absent.join(', ')}`,
                    hint: `it has: ${names.join(', ')}`,
                };
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
                api: await present(index, result.subgraphs, chosen(format, fallback), {
                    docs,
                    source,
                }),
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

    const listApi = tool<
        {
            kind?: string;
            name?: string;
            path?: string;
            regex?: boolean;
            method_type?: string;
            direction?: string;
            source?: string;
            limit?: number;
        },
        TCtx
    >({
        name: 'list_api',
        group: GROUP,
        description:
            'Lists operations, schemas or fields by name, with no searching and no ranking. ' +
            'The answer is complete: every match is counted, so `found` tells you how many ' +
            'exist even when the list was shortened. Use it to see the shape of the API ' +
            'before deciding what to ask for, and to settle whether something exists at all — ' +
            'search can only ever return its best guesses, so it cannot answer that.',
        parameters: {
            type: 'object',
            properties: {
                kind: {
                    type: 'string',
                    enum: ['methods', 'types', 'properties'],
                    description: 'What to list. Default methods.',
                },
                name: {
                    type: 'string',
                    description:
                        'Match the name. A plain word matches anywhere in it; use * and ? ' +
                        'to match the whole name, e.g. "*Password*".',
                },
                path: {
                    type: 'string',
                    description:
                        'Match the route, e.g. "/users*". Keeps operations and their ' +
                        'parameters; a schema sits on no one route, so it is left out.',
                },
                regex: {
                    type: 'boolean',
                    description: 'Read `name` and `path` as regular expressions instead.',
                },
                method_type: {
                    type: 'string',
                    enum: ['read_only', 'read_write', 'any'],
                },
                direction: { type: 'string', enum: ['input', 'output', 'any'] },
                source: {
                    type: 'string',
                    description: 'Only this document, when the index holds more than one.',
                },
                limit: {
                    type: 'integer',
                    description: `Rows to return. Default ${DEFAULT_ROWS}.`,
                },
            },
            additionalProperties: false,
        },
        execute: async ({
            kind,
            name,
            path,
            regex,
            method_type,
            direction,
            source: only,
            limit,
        }) => {
            const subject = SUBJECTS[kind ?? 'methods'];
            if (!subject) {
                return { error: `cannot list "${kind}"`, hint: 'kind is methods, types or fields' };
            }
            let result;
            try {
                result = listNodes(index.graph, {
                    kind: subject,
                    name: name ? [loose(name, { regex })] : undefined,
                    path: path ? [loose(path, { regex })] : undefined,
                    source: only,
                    methodType: enumerated(method_type),
                    direction: enumerated(direction),
                    limit: Math.min(limit ?? DEFAULT_ROWS, MAX_ROWS),
                });
            } catch (err) {
                return { error: err instanceof PatternError ? err.message : String(err) };
            }
            return {
                found: result.found,
                truncated: result.truncated,
                [PLURALS[subject]]: result.rows.map((r) => line(index.graph, subject, r, source)),
            };
        },
    });

    const grepApi = tool<
        {
            pattern: string;
            regex?: boolean;
            kind?: string;
            name?: string;
            path?: string;
            source?: string;
            limit?: number;
        },
        TCtx
    >({
        name: 'grep_api',
        group: GROUP,
        description:
            'Finds every literal occurrence of a string across the whole API description — ' +
            'operations, schemas and fields alike. No embeddings and no ranking, so ' +
            'nothing is missed for being an unusual word or an odd spelling. This is the ' +
            'tool for "does X exist anywhere", and for checking that a search which ' +
            'returned nothing really means there is nothing. Narrow it with `path` or ' +
            '`name` when the word is common and only one corner of the API is meant.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'The text to find. Matched anywhere, ignoring case.',
                },
                regex: {
                    type: 'boolean',
                    description: 'Read the pattern as a regular expression instead.',
                },
                kind: { type: 'string', enum: ['method', 'type', 'property'] },
                name: {
                    type: 'string',
                    description: 'Only nodes whose own name matches this. * and ? allowed.',
                },
                path: {
                    type: 'string',
                    description: 'Only what sits on a matching route, e.g. "/users*".',
                },
                source: {
                    type: 'string',
                    description: 'Only this document, when the index holds more than one.',
                },
                limit: {
                    type: 'integer',
                    description: `Matches to return. Default ${DEFAULT_ROWS}. \`found\` always counts them all.`,
                },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        execute: async ({ pattern, regex, kind, name, path, source: only, limit }) => {
            let result;
            try {
                result = grepNodes(index.graph, matcher(pattern, { regex }), {
                    kinds: kind ? [kind] : undefined,
                    name: name ? [loose(name)] : undefined,
                    path: path ? [loose(path)] : undefined,
                    source: only,
                    limit: Math.min(limit ?? DEFAULT_ROWS, MAX_ROWS),
                });
            } catch (err) {
                return { error: err instanceof PatternError ? err.message : String(err) };
            }
            if (result.found === 0) {
                return {
                    found: 0,
                    hint: 'nothing in the description contains it — it is not there under this name',
                };
            }
            return {
                found: result.found,
                truncated: result.truncated,
                matches: result.matches.map((m) => ({
                    id: m.id,
                    ...(source ? { source: m.attributes.source } : {}),
                    text: m.text,
                })),
            };
        },
    });

    const traceApi = tool<
        {
            of: string;
            kind?: string;
            direction?: string;
            source?: string;
            limit?: number;
            routes?: number;
        },
        TCtx
    >({
        name: 'trace_api',
        group: GROUP,
        description:
            'Answers "which calls can reach this?" for a field or a schema: walks up the ' +
            'graph from everything of that name to the operations that accept or return it, ' +
            'and gives the chain in between. Use it whenever a field has been found and the ' +
            'endpoint to call is what is actually wanted — searching for the operation will ' +
            'not work, because a call almost never repeats the name of a field nested inside ' +
            'its body. An empty answer means nothing in the API carries it.',
        parameters: {
            type: 'object',
            properties: {
                of: {
                    type: 'string',
                    description:
                        'The field or schema name to trace up from, or a node id such as ' +
                        '"Type:User". A plain word matches anywhere in the name; * and ? ' +
                        'match the whole of it.',
                },
                kind: {
                    type: 'string',
                    enum: ['type', 'property'],
                    description: 'Only trace from schemas, or only from fields.',
                },
                direction: {
                    type: 'string',
                    enum: ['input', 'output', 'any'],
                    description: 'Keep only the calls that accept it, or that return it.',
                },
                source: {
                    type: 'string',
                    description: 'Only this document, when the index holds more than one.',
                },
                limit: {
                    type: 'integer',
                    description: `Nodes to trace from. Default ${DEFAULT_TRACES}.`,
                },
                routes: {
                    type: 'integer',
                    description: `Operations per node. Default ${DEFAULT_ROUTES}.`,
                },
            },
            required: ['of'],
            additionalProperties: false,
        },
        execute: async ({ of: wanted, kind, direction, source: only, limit, routes }) => {
            let result;
            try {
                result = traceNodes(index.graph, {
                    ids: index.graph.hasNode(wanted) ? [wanted] : undefined,
                    kinds: kind ? [kind as NodeKind] : undefined,
                    name: index.graph.hasNode(wanted) ? undefined : [loose(wanted)],
                    source: only,
                    limit: Math.min(limit ?? DEFAULT_TRACES, MAX_TRACES),
                    maxRoutes: Math.min(routes ?? DEFAULT_ROUTES, MAX_ROWS),
                });
            } catch (err) {
                return { error: err instanceof PatternError ? err.message : String(err) };
            }
            if (result.found === 0) {
                return {
                    found: 0,
                    hint: `nothing in the API is called "${wanted}" — try grep_api for it`,
                };
            }

            const side = enumerated(direction);
            return {
                found: result.found,
                truncated: result.truncated,
                traced: result.traces.map((t) => ({
                    id: t.id,
                    reached_by: t.found,
                    operations: t.routes
                        .filter((r) => !side || r.direction === side || r.direction === 'both')
                        .map(
                            (r) =>
                                `${r.attributes.httpMethod} ${r.attributes.path}  ` +
                                `${r.attributes.name}  (${r.direction})${
                                    source ? `  ${sourceTag(r.attributes.source)}` : ''
                                }  ${chainOf(index.graph, t.id, r)}`,
                        ),
                })),
            };
        },
    });

    return [searchApi, describeTypes, findTypesWithProperty, listApi, grepApi, traceApi];
}

// ---------------------------------------------------------------------------

const SUBJECTS: Record<string, NodeKind | undefined> = {
    methods: 'method',
    types: 'type',
    properties: 'property',
    fields: 'property',
};

const PLURALS: Record<NodeKind, string> = {
    method: 'methods',
    type: 'types',
    property: 'properties',
};

/** One row, as the line a model reads rather than an object it has to walk. */
function line(graph: SchemaIndex['graph'], kind: NodeKind, row: Row, source = false): string {
    const from = source ? `  ${sourceTag(row.source)}` : '';
    if (kind === 'method') {
        return `${row.httpMethod} ${row.path}  ${row.name}${from}${row.doc ? ` — ${row.doc}` : ''}`;
    }
    if (kind === 'type') {
        const side = row.direction === 'none' ? '' : ` (${row.direction})`;
        return `${row.name}${side}  ${fields(propertyCount(graph, row.id))}${from}${row.doc ? ` — ${row.doc}` : ''}`;
    }
    const owner = row.parent ? `${row.parent}.` : '';
    return `${owner}${row.name}${row.required ? '' : '?'}: ${row.signature || 'unknown'}${from}`;
}

const enumerated = (value: string | undefined): string | undefined =>
    value && value !== 'any' ? value : undefined;

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
