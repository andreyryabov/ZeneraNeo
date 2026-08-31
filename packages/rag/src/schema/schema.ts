// ---------------------------------------------------------------------------
// Schemas, made uniform — without losing their names
//
// Three dialects arrive here and one leaves, the same conversion the faker
// does. What is deliberately *not* done here is dereferencing: a `$ref` is
// left as the string it is, because a component's name is this package's
// primary key. `#/components/schemas/ResetPasswordPayload` is the edge that
// makes the graph a graph, and the word the model is going to say back.
//
// Nothing here recurses through a `$ref`, so nothing here can meet a cycle.
// ---------------------------------------------------------------------------

export type Schema = Record<string, unknown>;

export type Dialect = 'swagger-2.0' | 'openapi-3.0' | 'openapi-3.1';

/** Subschema positions, by the shape of what sits in them. */
const ONE = [
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
    'additionalProperties',
    'unevaluatedProperties',
    'additionalItems',
    'unevaluatedItems',
] as const;
const MAP = ['properties', 'patternProperties', '$defs', 'definitions'] as const;
const LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/**
 * Annotations that cost tokens and change no meaning. `discriminator` is
 * conspicuously absent — the faker drops it, and here it is the whole reason a
 * `oneOf` can be printed as a TypeScript tagged union rather than a bare one.
 */
const DROP = new Set(['externalDocs', 'xml', 'x-internal']);

export const isObject = (v: unknown): v is Schema =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** Converts one schema, and everything under it, into 2020-12. */
export function normalize(root: unknown, dialect: Dialect): Schema {
    if (!isObject(root)) {
        return {};
    }
    return convert(root, dialect);
}

function walk(value: unknown, dialect: Dialect): unknown {
    return isObject(value) ? convert(value, dialect) : value;
}

function convert(node: Schema, dialect: Dialect): Schema {
    const out: Schema = {};

    for (const [key, value] of Object.entries(node)) {
        if (DROP.has(key) || value === undefined) {
            continue;
        }
        if ((ONE as readonly string[]).includes(key)) {
            out[key] = typeof value === 'boolean' ? value : walk(value, dialect);
        } else if ((MAP as readonly string[]).includes(key) && isObject(value)) {
            const target = key === 'definitions' ? '$defs' : key;
            out[target] = Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                    k,
                    typeof v === 'boolean' ? v : walk(v, dialect),
                ]),
            );
        } else if ((LIST as readonly string[]).includes(key) && Array.isArray(value)) {
            out[key] = value.map((v) => walk(v, dialect));
        } else if (key === 'items') {
            // Draft-4 and Swagger 2.0 spell tuples as an array here; 2020-12
            // spells them `prefixItems` and keeps `items` for the tail.
            out[Array.isArray(value) ? 'prefixItems' : 'items'] = Array.isArray(value)
                ? value.map((v) => walk(v, dialect))
                : walk(value, dialect);
        } else {
            out[key] = value;
        }
    }

    if (dialect !== 'openapi-3.1') {
        widenNullable(node, out);
        fixExclusive(out);
    }
    fixPattern(out);
    // `type: file` is Swagger 2.0's way of saying "bytes".
    if (out.type === 'file') {
        out.type = 'string';
    }
    if (Array.isArray(out.required) && out.required.length === 0) {
        delete out.required;
    }
    return out;
}

/**
 * `pattern: /^[_a-z0-9-]+$/` — a JavaScript regex *literal*, delimiters and all
 * — is written in real documents, and with the slashes left on it matches
 * nothing. They come off, and an expression that still will not compile is
 * dropped rather than shown to anyone.
 */
function fixPattern(out: Schema): void {
    const raw = out.pattern;
    if (typeof raw !== 'string') {
        return;
    }
    const literal = /^\/(.+)\/[dgimsuvy]*$/s.exec(raw);
    const body = literal ? literal[1]! : raw;
    try {
        new RegExp(body);
        out.pattern = body;
    } catch {
        delete out.pattern;
    }
}

/** `nullable: true` is not a 2020-12 keyword; a union type is. */
function widenNullable(node: Schema, out: Schema): void {
    if (node.nullable !== true) {
        return;
    }
    delete out.nullable;
    const type = out.type;
    if (typeof type === 'string') {
        out.type = [type, 'null'];
    } else if (Array.isArray(type)) {
        out.type = type.includes('null') ? type : [...type, 'null'];
    } else if (Array.isArray(out.enum) && !out.enum.includes(null)) {
        out.enum = [...out.enum, null];
    }
}

/**
 * Draft-4 spells an exclusive bound as a boolean flag on the inclusive one, so
 * `exclusiveMinimum: true` left alone reads as "the minimum is 1".
 */
function fixExclusive(out: Schema): void {
    for (const [flag, bound] of [
        ['exclusiveMinimum', 'minimum'],
        ['exclusiveMaximum', 'maximum'],
    ] as const) {
        if (typeof out[flag] !== 'boolean') {
            continue;
        }
        const value = out[bound];
        if (out[flag] === true && typeof value === 'number') {
            out[flag] = value;
            delete out[bound];
        } else {
            delete out[flag];
        }
    }
}

/** The component name a `$ref` points at, or undefined for anything foreign. */
export function refName(value: unknown): string | undefined {
    if (!isObject(value) || typeof value.$ref !== 'string') {
        return undefined;
    }
    const match = /^#\/(?:components\/schemas|definitions|\$defs)\/(.+)$/.exec(value.$ref);
    return match
        ? decodeURIComponent(match[1]!.replace(/~1/g, '/').replace(/~0/g, '~'))
        : undefined;
}

/** Every component name reachable from a schema, one level of `$ref` deep. */
export function refsIn(schema: unknown): string[] {
    const out = new Set<string>();
    const stack: unknown[] = [schema];

    while (stack.length > 0) {
        const node = stack.pop();
        if (Array.isArray(node)) {
            stack.push(...node);
            continue;
        }
        if (!isObject(node)) {
            continue;
        }
        const name = refName(node);
        if (name !== undefined) {
            out.add(name);
            // A `$ref` may carry siblings in 2020-12, but none of them are the
            // pointed-at schema, so there is nothing further down this branch.
            continue;
        }
        stack.push(...Object.values(node));
    }
    return [...out];
}

export function docOf(schema: unknown): string {
    if (!isObject(schema)) {
        return '';
    }
    const description = schema.description ?? schema.title;
    return typeof description === 'string' ? description.trim() : '';
}
