import type { GeneratorInput } from './envelope.ts';
import type { Paging } from './paging.ts';
import { propertyNames, type Schema } from './schema.ts';
import type { Operation, ParamSpec } from './spec.ts';
import type { Issue } from './validate.ts';

// ---------------------------------------------------------------------------
// Probes
//
// A generator is judged before it is trusted, and it is judged on inputs made
// up here rather than on traffic. That is not only about cost: a probe built
// from a request body would put whatever a caller sent into the next prompt,
// and a mock server is exactly the kind of thing people point at with real
// payloads by accident.
//
// Two probes, deliberately. One ordinary, one at the edges of whatever the
// schema allows — a generator that hard-codes the first probe's id passes once
// and fails the second, which is the mistake this catches.
// ---------------------------------------------------------------------------

export function probesFor(operation: Operation): GeneratorInput[] {
    return [0, 1].map((variant) => ({
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        pathParams: values(operation.params, 'path', variant),
        query: values(operation.params, 'query', variant),
        headers: {},
        body: operation.requestBody
            ? sample(operation.requestBody.schema, variant, 0, operation.requestBody.schema)
            : undefined,
        seed: variant === 0 ? 1 : 2,
    }));
}

function values(
    params: readonly ParamSpec[],
    where: 'path' | 'query',
    variant: number,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of params) {
        if (p.in !== where) {
            continue;
        }
        // An optional query parameter is present in one probe and absent in the
        // other, so a generator cannot assume either.
        if (!p.required && variant === 1) {
            continue;
        }
        out[p.name] = sample(p.schema, variant, 0, p.schema);
    }
    return out;
}

const NAMES = ['ada', 'grace', 'linus'];

/**
 * A value the schema would accept. Not a faker — that job belongs to the
 * generator; this only has to be *valid*, so that a probe failure is the
 * generator's fault and never the probe's.
 */
function sample(schema: Schema, variant: number, depth: number, root: Schema): unknown {
    if (depth > 4) {
        return null;
    }
    // Normalisation hoists anything shared or recursive, so a top-level schema
    // is quite often nothing but a pointer into `$defs`.
    const target = follow(schema, root);
    if (target !== schema) {
        return sample(target, variant, depth + 1, root);
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum[variant % schema.enum.length];
    }
    if (schema.const !== undefined) {
        return schema.const;
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
        const list = schema[key];
        if (Array.isArray(list) && list.length > 0) {
            return sample(list[0] as Schema, variant, depth + 1, root);
        }
    }

    switch (typeOf(schema)) {
        case 'integer':
            return bounded(schema, variant === 0 ? 12324 : 7, true);
        case 'number':
            return bounded(schema, variant === 0 ? 42.5 : 1.5, false);
        case 'boolean':
            return variant === 0;
        case 'null':
            return null;
        case 'array': {
            const items = schema.items;
            const one =
                typeof items === 'object' && items !== null
                    ? sample(items as Schema, variant, depth + 1, root)
                    : 1;
            return variant === 0 ? [one] : [one, one];
        }
        case 'object': {
            const properties = (schema.properties ?? {}) as Record<string, Schema>;
            const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
            const out: Record<string, unknown> = {};
            for (const [name, sub] of Object.entries(properties)) {
                if (variant === 1 && !required.includes(name)) {
                    continue;
                }
                out[name] = sample(sub, variant, depth + 1, root);
            }
            return out;
        }
        default:
            return text(schema, variant);
    }
}

/** One hop through a local `#/$defs/...` pointer, or the schema itself. */
function follow(schema: Schema, root: Schema): Schema {
    const ref = schema.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) {
        return schema;
    }
    const defs = root.$defs;
    if (typeof defs !== 'object' || defs === null) {
        return schema;
    }
    const target = (defs as Record<string, unknown>)[ref.slice('#/$defs/'.length)];
    return typeof target === 'object' && target !== null ? (target as Schema) : schema;
}

function typeOf(schema: Schema): string | undefined {
    const type = schema.type;
    if (typeof type === 'string') {
        return type;
    }
    if (Array.isArray(type)) {
        return type.find((t) => t !== 'null') as string | undefined;
    }
    return schema.properties !== undefined
        ? 'object'
        : schema.items !== undefined
          ? 'array'
          : undefined;
}

function bounded(schema: Schema, wanted: number, integer: boolean): number {
    const min = num(schema.minimum) ?? num(schema.exclusiveMinimum);
    const max = num(schema.maximum) ?? num(schema.exclusiveMaximum);
    let value = wanted;
    if (min !== undefined && value <= min) {
        value = min + 1;
    }
    if (max !== undefined && value >= max) {
        value = max - 1;
    }
    return integer ? Math.round(value) : value;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function text(schema: Schema, variant: number): string {
    switch (schema.format) {
        case 'uuid':
            return variant === 0
                ? '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
                : '9c858901-8a57-4791-81fe-4c455b099bc9';
        case 'date':
            return variant === 0 ? '2024-01-15' : '1999-12-31';
        case 'date-time':
            return variant === 0 ? '2024-01-15T09:30:00Z' : '1999-12-31T23:59:59Z';
        case 'email':
            return `${NAMES[variant % NAMES.length]}@example.com`;
        case 'uri':
        case 'url':
            return 'https://example.com/thing';
        default:
            break;
    }
    // A `pattern` cannot be satisfied by guessing, so it is left to the
    // parameter check to tell us the probe was wrong rather than the generator.
    const base = NAMES[variant % NAMES.length];
    const min = num(schema.minLength) ?? 0;
    return base.length >= min ? base : base.padEnd(min, 'x');
}

// ---------------------------------------------------------------------------
// The walk
//
// The probes above are independent, which is the right shape for everything one
// response can be wrong about and the wrong shape for pagination: a cursor only
// means anything in the answer it arrived with, so the pages have to be asked
// for in order.
//
// The seed is held still across the whole walk on purpose. A generator that
// mints its token out of `seed` rather than out of the request is the exact
// mistake being looked for, and a still seed makes it a fixed point — visible
// on the second page here instead of on somebody's client.
// ---------------------------------------------------------------------------

/** The first page: an ordinary probe with the paging control taken back off. */
export function walkStart(operation: Operation, paging: Paging): GeneratorInput {
    const input = probesFor(operation)[0];
    const query = { ...input.query };
    delete query[paging.param];
    return { ...input, query };
}

/** The same request again, asking for whatever the last answer pointed at. */
export function nextPage(previous: GeneratorInput, paging: Paging, token: string): GeneratorInput {
    return { ...previous, query: { ...previous.query, [paging.param]: token } };
}

// ---------------------------------------------------------------------------
// The echo rule
//
// `get_user_by_id(12324)` answering `{ user_id: 999 }` validates perfectly and
// is still wrong, so schema conformance is not the whole test. Where the
// response declares a property with a parameter's name, the parameter's value
// has to be the one that comes back.
//
// **Path parameters only.** A path segment identifies the resource, so a
// mismatch there is a broken mock. A query parameter is usually a control
// rather than content — `?source=realtime`, `?page_size=50`, `?cursor=…` — and
// real APIs collide those names with unrelated response properties all the
// time. Enforcing on them rejected working generators for a rule they were
// right to ignore. The prompt still asks for query echo where it is meaningful;
// it is simply not a reason to throw the file away.
// ---------------------------------------------------------------------------

export function echoIssues(
    input: GeneratorInput,
    value: unknown,
    schema: Schema | undefined,
): Issue[] {
    if (!schema) {
        return [];
    }
    const declared = propertyNames(schema);
    const out: Issue[] = [];

    for (const [name, expected] of Object.entries(input.pathParams)) {
        if (!declared.has(name) || expected === undefined || expected === null) {
            continue;
        }
        if (!carries(value, name, expected)) {
            out.push({
                where: `/${name}`,
                message: `must echo the path parameter ${JSON.stringify(expected)}, the response schema declares this property`,
            });
        }
    }
    return out;
}

/** Whether `name` anywhere in the value holds something equal to `expected`. */
function carries(value: unknown, name: string, expected: unknown): boolean {
    const stack: unknown[] = [value];
    const seen = new Set<object>();

    while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node !== 'object' || node === null) {
            continue;
        }
        if (Array.isArray(node)) {
            stack.push(...node);
            continue;
        }
        if (seen.has(node)) {
            continue;
        }
        seen.add(node);
        const record = node as Record<string, unknown>;
        if (name in record && same(record[name], expected)) {
            return true;
        }
        stack.push(...Object.values(record));
    }
    return false;
}

/** A path segment is text on the wire; `"12324"` and `12324` are the same id. */
function same(got: unknown, expected: unknown): boolean {
    if (got === expected) {
        return true;
    }
    if (got === null || got === undefined || typeof got === 'object') {
        return false;
    }
    return String(got) === String(expected);
}
