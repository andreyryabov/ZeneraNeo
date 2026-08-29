// Both packages are CommonJS. `ajv/dist/2020` has a real named export, so it is
// imported by name; `ajv-formats` sets `module.exports` to the plugin function
// but also declares named exports, which NodeNext models as a namespace with a
// synthetic default. The value is callable at runtime; only the type is wrong.
import addFormatsDefault from 'ajv-formats';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { Schema } from './schema.ts';
import type { Operation, ParamSpec } from './spec.ts';

const addFormats = addFormatsDefault as unknown as (ajv: Ajv2020) => void;

// ---------------------------------------------------------------------------
// Checking
//
// One Ajv instance, one dialect, two customers. Requests are checked so a
// caller learns it sent the wrong thing here rather than three layers into a
// generated body; responses are checked so a generator that drifts from its
// schema is caught by the build loop instead of by whoever is using the mock.
//
// `coerceTypes` is on and is not a shortcut. A path segment and a query string
// are always text on the wire, so `/users/12324` against `type: integer` would
// otherwise fail every time. Coercion is confined to the parameter validators
// for exactly that reason; the body and the response are checked strictly.
// ---------------------------------------------------------------------------

export interface Issue {
    where: string;
    message: string;
}

export class Checks {
    readonly #strict = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    readonly #loose = new Ajv2020({
        allErrors: true,
        strict: false,
        coerceTypes: true,
        useDefaults: false,
        validateFormats: true,
    });
    readonly #cache = new Map<string, Compiled>();

    constructor() {
        addFormats(this.#strict);
        addFormats(this.#loose);
    }

    for(operation: Operation): Compiled {
        const hit = this.#cache.get(operation.key);
        if (hit) {
            return hit;
        }
        const compiled: Compiled = {
            path: this.#loose.compile(envelope(operation.params, 'path')),
            query: this.#loose.compile(envelope(operation.params, 'query')),
            body: operation.requestBody
                ? this.#strict.compile(operation.requestBody.schema)
                : undefined,
            bodyRequired: operation.requestBody?.required === true,
            response: operation.success.schema
                ? this.#strict.compile(operation.success.schema)
                : undefined,
        };
        this.#cache.set(operation.key, compiled);
        return compiled;
    }
}

export interface Compiled {
    path: ValidateFunction;
    query: ValidateFunction;
    body?: ValidateFunction;
    bodyRequired: boolean;
    response?: ValidateFunction;
}

/**
 * Parameters are validated as one object rather than one at a time, so a
 * request with three wrong values is answered once with all three.
 */
function envelope(params: readonly ParamSpec[], where: 'path' | 'query'): Schema {
    const mine = params.filter((p) => p.in === where);
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: Object.fromEntries(mine.map((p) => [p.name, stripped(p.schema)])),
        required: mine.filter((p) => p.required).map((p) => p.name),
        // A query string may carry anything; only what the spec names is checked.
        additionalProperties: true,
    };
}

/** A subschema must not carry its own `$schema`; only the envelope may. */
function stripped(schema: Schema): Schema {
    const { $schema: _ignored, ...rest } = schema;
    return rest;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function issues(prefix: string, errors: ErrorObject[] | null | undefined): Issue[] {
    return (errors ?? []).map((e) => ({
        where: `${prefix}${e.instancePath}`,
        message: e.message ?? 'is invalid',
    }));
}

export function describeIssues(list: readonly Issue[]): string {
    return list.map((i) => `${i.where || '(root)'} ${i.message}`).join('; ');
}
