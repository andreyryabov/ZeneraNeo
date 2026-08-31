import SwaggerParser from '@apidevtools/swagger-parser';
import { createHash } from 'node:crypto';
import { CliError, EXIT } from '@zenera/cli/lib';
import { normalize, type Dialect, type Schema } from './schema.ts';

// ---------------------------------------------------------------------------
// Documents, flattened
//
// Everything below this file works on `Operation`, which is one method on one
// path with its schemas already dereferenced and already 2020-12. Which
// document it came from, and which of the three dialects that document was
// written in, stops mattering here.
//
// `dereference` is used rather than `bundle` on purpose: the generator is asked
// to produce a body for one operation, and it should see that operation's
// shapes rather than a pointer into a components section it was never shown.
// ---------------------------------------------------------------------------

export const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

export type Method = (typeof METHODS)[number];

export type ParamIn = 'path' | 'query' | 'header' | 'cookie';

export interface ParamSpec {
    name: string;
    in: ParamIn;
    required: boolean;
    schema: Schema;
    description?: string;
}

export interface Operation {
    /** cache identity — a pure function of the operation's shape, see `keyOf` */
    key: string;
    /** the document it came from, for error messages */
    source: string;
    method: Method;
    /** the template, `/users/{user_id}` */
    path: string;
    operationId: string;
    summary?: string;
    description?: string;
    params: ParamSpec[];
    requestBody?: { required: boolean; schema: Schema };
    /** the response a call is answered with; `schema` absent means no body */
    success: { status: number; schema?: Schema };
}

interface Doc {
    swagger?: string;
    openapi?: string;
    basePath?: string;
    paths?: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `CliError` so an unreadable document exits 3 wherever it is raised. */
export class SpecError extends CliError {
    constructor(message: string, hint?: string) {
        super(message, EXIT.invalid, hint);
        this.name = 'SpecError';
    }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadSpecs(files: readonly string[]): Promise<Operation[]> {
    const out: Operation[] = [];
    for (const file of files) {
        out.push(...(await loadSpec(file)));
    }
    return out;
}

export async function loadSpec(file: string): Promise<Operation[]> {
    let doc: Doc;
    try {
        doc = (await SwaggerParser.dereference(file)) as Doc;
    } catch (err) {
        throw new SpecError(
            `${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
            'the document must be a readable OpenAPI 3.x or Swagger 2.0 file',
        );
    }

    const dialect = dialectOf(doc);
    const prefix = dialect === 'swagger-2.0' ? (doc.basePath ?? '') : '';
    const out: Operation[] = [];

    for (const [template, item] of Object.entries(doc.paths ?? {})) {
        if (!isObject(item)) {
            continue;
        }
        // Path-level parameters apply to every method on it, and an operation
        // may override one by repeating its name and location.
        const shared = params(item.parameters, dialect);
        for (const method of METHODS) {
            const op = item[method];
            if (!isObject(op)) {
                continue;
            }
            const path = join(prefix, template);
            const merged = override(shared, params(op.parameters, dialect));
            out.push(
                build({
                    source: file,
                    dialect,
                    method,
                    path,
                    op,
                    params: merged,
                    body: requestBody(op, dialect),
                }),
            );
        }
    }
    return out;
}

function dialectOf(doc: Doc): Dialect {
    if (doc.swagger?.startsWith('2.')) {
        return 'swagger-2.0';
    }
    if (doc.openapi?.startsWith('3.1')) {
        return 'openapi-3.1';
    }
    if (doc.openapi?.startsWith('3.')) {
        return 'openapi-3.0';
    }
    throw new SpecError('neither `swagger: 2.0` nor `openapi: 3.x` is declared');
}

function join(prefix: string, template: string): string {
    const base = prefix.replace(/\/+$/, '');
    return `${base}${template.startsWith('/') ? '' : '/'}${template}` || '/';
}

interface Built {
    source: string;
    dialect: Dialect;
    method: Method;
    path: string;
    op: Record<string, unknown>;
    params: ParamSpec[];
    body?: { required: boolean; schema: Schema };
}

function build(b: Built): Operation {
    const success = successOf(b.op, b.dialect);
    const operationId =
        typeof b.op.operationId === 'string' && b.op.operationId
            ? b.op.operationId
            : synthesizeId(b.method, b.path);

    const operation: Operation = {
        key: '',
        source: b.source,
        method: b.method,
        path: b.path,
        operationId,
        summary: typeof b.op.summary === 'string' ? b.op.summary : undefined,
        description: typeof b.op.description === 'string' ? b.op.description : undefined,
        params: b.params,
        requestBody: b.body,
        success,
    };
    return { ...operation, key: keyOf(operation) };
}

/**
 * Cache identity. Everything that changes what a generator must produce is in
 * here and nothing else is — not the file it came from, not its summary, not
 * the order of its keys. Editing a spec therefore yields a new key and the old
 * artefact is simply never looked up again, so there is no invalidation step
 * to get wrong.
 */
function keyOf(op: Operation): string {
    const shape = {
        method: op.method,
        path: op.path,
        operationId: op.operationId,
        params: [...op.params]
            .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`))
            .map((p) => [p.in, p.name, p.required, canonical(p.schema)]),
        body: op.requestBody ? [op.requestBody.required, canonical(op.requestBody.schema)] : null,
        success: [op.success.status, op.success.schema ? canonical(op.success.schema) : null],
    };
    return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

/** Key order is a formatting accident; it must not change a cache key. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (isObject(value)) {
        return Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]);
    }
    return value;
}

function synthesizeId(method: Method, path: string): string {
    const words = path
        .split('/')
        .filter(Boolean)
        .map((s) => s.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, '_'));
    return [method, ...words].join('_');
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function params(raw: unknown, dialect: Dialect): ParamSpec[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: ParamSpec[] = [];
    for (const entry of raw) {
        if (!isObject(entry) || typeof entry.name !== 'string') {
            continue;
        }
        const where = entry.in;
        if (where !== 'path' && where !== 'query' && where !== 'header' && where !== 'cookie') {
            continue; // `body` and `formData` are handled as a request body
        }
        out.push({
            name: entry.name,
            in: where,
            required: where === 'path' ? true : entry.required === true,
            schema: normalize(paramSchema(entry, dialect), dialect),
            description: typeof entry.description === 'string' ? entry.description : undefined,
        });
    }
    return out;
}

/**
 * Swagger 2.0 puts a non-body parameter's type keywords directly on the
 * parameter object; OpenAPI 3 moved them under `schema`. Both end up as a
 * schema, so the difference is confined to this function.
 */
function paramSchema(entry: Record<string, unknown>, dialect: Dialect): unknown {
    if (dialect !== 'swagger-2.0') {
        return isObject(entry.schema) ? entry.schema : {};
    }
    const {
        name: _name,
        in: _in,
        required: _required,
        description: _description,
        collectionFormat: _collectionFormat,
        allowEmptyValue: _allowEmptyValue,
        ...rest
    } = entry;
    return rest;
}

/** Operation-level parameters win over path-level ones with the same identity. */
function override(base: ParamSpec[], own: ParamSpec[]): ParamSpec[] {
    const merged = new Map(base.map((p) => [`${p.in}:${p.name}`, p]));
    for (const p of own) {
        merged.set(`${p.in}:${p.name}`, p);
    }
    return [...merged.values()];
}

function requestBody(
    op: Record<string, unknown>,
    dialect: Dialect,
): { required: boolean; schema: Schema } | undefined {
    if (dialect === 'swagger-2.0') {
        const list = Array.isArray(op.parameters) ? op.parameters : [];
        const body = list.find((p): p is Record<string, unknown> => isObject(p) && p.in === 'body');
        if (!body || !isObject(body.schema)) {
            return undefined;
        }
        return { required: body.required === true, schema: normalize(body.schema, dialect) };
    }
    const rb = op.requestBody;
    if (!isObject(rb)) {
        return undefined;
    }
    const schema = jsonContent(rb.content);
    return schema
        ? { required: rb.required === true, schema: normalize(schema, dialect) }
        : undefined;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The response a call gets answered with: the lowest 2xx that carries a JSON
 * body, or the lowest 2xx at all when none of them do. An operation whose
 * success response has no JSON schema is answered `204` and never gets a
 * generator — there is nothing for one to produce.
 */
function successOf(
    op: Record<string, unknown>,
    dialect: Dialect,
): { status: number; schema?: Schema } {
    const responses = isObject(op.responses) ? op.responses : {};
    const codes = Object.keys(responses)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 200 && n < 300)
        .sort((a, b) => a - b);

    for (const status of codes) {
        const schema = responseSchema(responses[String(status)], dialect);
        if (schema) {
            return { status, schema: normalize(schema, dialect) };
        }
    }
    return { status: codes[0] ?? 204 };
}

function responseSchema(response: unknown, dialect: Dialect): unknown {
    if (!isObject(response)) {
        return undefined;
    }
    if (dialect === 'swagger-2.0') {
        return isObject(response.schema) ? response.schema : undefined;
    }
    return jsonContent(response.content);
}

/** The first JSON media type a content map offers, `+json` suffixes included. */
function jsonContent(content: unknown): unknown {
    if (!isObject(content)) {
        return undefined;
    }
    for (const [type, entry] of Object.entries(content)) {
        const base = type.split(';')[0].trim();
        if ((base === 'application/json' || base.endsWith('+json')) && isObject(entry)) {
            return isObject(entry.schema) ? entry.schema : undefined;
        }
    }
    return undefined;
}
