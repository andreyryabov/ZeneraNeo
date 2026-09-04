// ---------------------------------------------------------------------------
// Schemas, made uniform
//
// Three dialects arrive here and one leaves. Swagger 2.0 carries Draft-4,
// OpenAPI 3.0 carries a Draft-4 derivative with its own `nullable`, and
// OpenAPI 3.1 is honest 2020-12. Ajv can be asked to speak any of them, but
// then every consumer downstream — the request check, the response check, the
// prompt the model reads, the `jsonschema` call inside the generator — has to
// be told which one it is looking at. So they are converted once, here, into
// 2020-12, and nothing below this file knows a dialect exists.
//
// The other job is cycles. `dereference` replaces every `$ref` with the object
// it pointed at, so a self-referencing schema comes back as a *cyclic JS
// object* — which Ajv cannot compile and `JSON.stringify` cannot print. Any
// node reached more than once is therefore hoisted into `$defs` and referred to
// by `$ref`, which restores the recursion in the one form every tool here can
// read. Shared-but-acyclic components take the same route, and the schema the
// model is shown gets smaller for free.
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

/** Annotations that mean nothing to a validator and cost prompt tokens. */
const DROP = new Set([
    'example',
    'externalDocs',
    'xml',
    'discriminator',
    'deprecated',
    'x-internal',
]);

const isObject = (v: unknown): v is Schema =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Converts a dereferenced schema into 2020-12, hoisting anything reached more
 * than once into `$defs`. The result is acyclic and safe to stringify.
 */
export function normalize(root: unknown, dialect: Dialect): Schema {
    if (!isObject(root)) {
        return {};
    }
    const shared = repeated(root);
    const defs = new Map<Schema, string>();
    const bodies = new Map<string, Schema>();

    const walk = (node: unknown): unknown => {
        if (!isObject(node)) {
            return node;
        }
        const name = defs.get(node);
        if (name !== undefined) {
            return { $ref: `#/$defs/${name}` };
        }
        if (!shared.has(node)) {
            return convert(node, dialect, walk);
        }
        const id = `def${defs.size}`;
        // Registered *before* the body is built, so a node that contains
        // itself refers to the name rather than recursing forever.
        defs.set(node, id);
        bodies.set(id, convert(node, dialect, walk));
        return { $ref: `#/$defs/${id}` };
    };

    // A root that is itself recursive comes back as a bare `$ref`; 2020-12
    // allows siblings on one, so `$defs` and `$schema` still land here.
    const out = walk(root) as Schema;
    if (bodies.size > 0) {
        out.$defs = Object.fromEntries(bodies);
    }
    out.$schema = 'https://json-schema.org/draft/2020-12/schema';
    return out;
}

function convert(node: Schema, dialect: Dialect, walk: (v: unknown) => unknown): Schema {
    const out: Schema = {};

    for (const [key, value] of Object.entries(node)) {
        if (DROP.has(key) || value === undefined) {
            continue;
        }
        if ((ONE as readonly string[]).includes(key)) {
            out[key] = typeof value === 'boolean' ? value : walk(value);
        } else if ((MAP as readonly string[]).includes(key) && isObject(value)) {
            const target = key === 'definitions' ? '$defs' : key;
            out[target] = Object.fromEntries(
                Object.entries(value).map(([k, v]) => [k, typeof v === 'boolean' ? v : walk(v)]),
            );
        } else if ((LIST as readonly string[]).includes(key) && Array.isArray(value)) {
            out[key] = value.map(walk);
        } else if (key === 'items') {
            // Draft-4 and Swagger 2.0 spell tuples as an array here; 2020-12
            // spells them `prefixItems` and keeps `items` for the tail.
            out[Array.isArray(value) ? 'prefixItems' : 'items'] = Array.isArray(value)
                ? value.map(walk)
                : walk(value);
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
 * — is written in real documents. JSON Schema wants the body alone, and with
 * the slashes left on, the expression is unsatisfiable: no string both contains
 * a slash and begins after it. Left alone it makes the endpoint impossible to
 * answer rather than merely badly specified, so the delimiters come off, and a
 * pattern that still will not compile is dropped instead of enforced.
 */
function fixPattern(out: Schema): void {
    const raw = out.pattern;
    if (typeof raw !== 'string') {
        return;
    }
    const literal = /^\/(.+)\/[dgimsuvy]*$/s.exec(raw);
    const body = literal ? literal[1] : raw;
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
 * Draft-4 spells an exclusive bound as a boolean flag on the inclusive one.
 * Left alone, Ajv reads `exclusiveMinimum: true` as "the minimum is 1".
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

/** Every schema-position object reached by more than one path, or by itself. */
function repeated(root: Schema): Set<Schema> {
    const seen = new Set<Schema>();
    const twice = new Set<Schema>();
    const stack: unknown[] = [root];

    while (stack.length > 0) {
        const node = stack.pop();
        if (!isObject(node)) {
            continue;
        }
        if (seen.has(node)) {
            twice.add(node);
            continue;
        }
        seen.add(node);
        for (const key of ONE) {
            stack.push(node[key]);
        }
        for (const key of LIST) {
            const value = node[key];
            if (Array.isArray(value)) {
                stack.push(...value);
            }
        }
        for (const key of MAP) {
            const value = node[key];
            if (isObject(value)) {
                stack.push(...Object.values(value));
            }
        }
        const items = node.items;
        stack.push(...(Array.isArray(items) ? items : [items]));
    }
    return twice;
}

// ---------------------------------------------------------------------------
// What a schema declares
//
// One walker, because two that disagree is a bug that hides: anything reading a
// normalized schema has to descend into the *values* of `$defs`, which is where
// everything shared or recursive was just moved to, and code that pushes the
// `$defs` map itself stops one level short and finds nothing.
// ---------------------------------------------------------------------------

export interface Declared {
    name: string;
    /** the property's own schema, with a `$defs` pointer already followed */
    schema: Schema;
    /** whether the object declaring it lists it in `required` */
    required: boolean;
    /** how many objects deep it sits; 0 is the top level */
    depth: number;
}

/** Every property a schema declares, at any depth, nearest first. */
export function properties(root: Schema): Declared[] {
    const out: Declared[] = [];
    const seen = new Set<Schema>();
    let level: unknown[] = [root];

    for (let depth = 0; level.length > 0; depth++) {
        const next: unknown[] = [];
        for (const raw of level) {
            const node = resolve(raw, root);
            if (node === undefined || seen.has(node)) {
                continue;
            }
            seen.add(node);
            const required = new Set(
                Array.isArray(node.required)
                    ? node.required.filter((n): n is string => typeof n === 'string')
                    : [],
            );
            const props = node.properties;
            if (isObject(props)) {
                for (const [name, sub] of Object.entries(props)) {
                    const target = resolve(sub, root);
                    if (target === undefined) {
                        continue;
                    }
                    out.push({ name, schema: target, required: required.has(name), depth });
                    next.push(sub);
                }
            }
            for (const key of ONE) {
                next.push(node[key]);
            }
            for (const key of LIST) {
                const value = node[key];
                if (Array.isArray(value)) {
                    next.push(...value);
                }
            }
            for (const key of MAP) {
                if (key === 'properties') {
                    continue;
                }
                const value = node[key];
                if (isObject(value)) {
                    next.push(...Object.values(value));
                }
            }
            const items = node.items;
            next.push(...(Array.isArray(items) ? items : [items]));
        }
        level = next;
    }
    return out;
}

/** Every property name a schema mentions, at any depth. */
export const propertyNames = (root: Schema): Set<string> =>
    new Set(properties(root).map((p) => p.name));

/** A schema, with a local `#/$defs/...` pointer followed as far as it goes. */
function resolve(value: unknown, root: Schema): Schema | undefined {
    let at = value;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
        if (!isObject(at)) {
            return undefined;
        }
        const ref = at.$ref;
        if (typeof ref !== 'string' || !ref.startsWith(DEFS)) {
            return at;
        }
        const defs = root.$defs;
        if (!isObject(defs)) {
            return at;
        }
        at = defs[ref.slice(DEFS.length)];
    }
    return undefined;
}

const DEFS = '#/$defs/';
const MAX_HOPS = 8;
