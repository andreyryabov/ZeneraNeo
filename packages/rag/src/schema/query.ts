import type { SchemaQuery } from './schema/search.ts';

// ---------------------------------------------------------------------------
// A query, from somewhere untrusted
//
// `--query` and the tool both hand over a whole object, which means the shape
// has to be checked rather than assumed. The rule is the same either way: a
// key that is not known is an error, because a silently ignored
// `output_propertys` looks exactly like a search that found nothing.
// ---------------------------------------------------------------------------

const LISTS = [
    'all',
    'methods',
    'types',
    'input_types',
    'output_types',
    'properties',
    'input_properties',
    'output_properties',
    'exclude_ids',
    'exclude_methods',
    'exclude_types',
    'exclude_properties',
] as const;

const NUMBERS = ['limit', 'max_hops', 'max_nodes'] as const;

const DIRECTIONS = ['input', 'output', 'any'] as const;
const METHOD_TYPES = ['read_only', 'read_write', 'any'] as const;

const KNOWN = new Set<string>([...LISTS, ...NUMBERS, 'direction', 'method_type']);

export class QueryError extends Error {}

export function parseQuery(value: unknown): SchemaQuery {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new QueryError('a query must be an object');
    }
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
        if (!KNOWN.has(key)) {
            throw new QueryError(
                `unknown query field "${key}" — expected ${[...KNOWN].join(', ')}`,
            );
        }
    }

    const out: Record<string, unknown> = {};
    for (const key of LISTS) {
        const list = input[key];
        if (list === undefined) {
            continue;
        }
        if (!Array.isArray(list) || list.some((v) => typeof v !== 'string')) {
            throw new QueryError(`${key} must be an array of strings`);
        }
        out[key] = list;
    }
    for (const key of NUMBERS) {
        const number = input[key];
        if (number === undefined) {
            continue;
        }
        if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
            throw new QueryError(`${key} must be a whole number of at least 1`);
        }
        out[key] = number;
    }
    if (input.direction !== undefined) {
        out.direction = oneOf('direction', input.direction, DIRECTIONS);
    }
    if (input.method_type !== undefined) {
        out.method_type = oneOf('method_type', input.method_type, METHOD_TYPES);
    }
    return out as SchemaQuery;
}

/** Whether anything was actually asked, as opposed to only filtered. */
export function isEmpty(query: SchemaQuery): boolean {
    const terms = [
        query.all,
        query.methods,
        query.types,
        query.input_types,
        query.output_types,
        query.properties,
        query.input_properties,
        query.output_properties,
    ];
    return terms.every((list) => !list || list.length === 0);
}

function oneOf<T extends string>(key: string, value: unknown, allowed: readonly T[]): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
        throw new QueryError(`${key} must be one of ${allowed.join(', ')}`);
    }
    return value as T;
}
