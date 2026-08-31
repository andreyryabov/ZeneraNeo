import SwaggerParser from '@apidevtools/swagger-parser';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { CliError, EXIT } from '@zenera/cli/lib';
import { docOf, isObject, normalize, type Dialect, type Schema } from './schema.ts';

// ---------------------------------------------------------------------------
// Documents, flattened — but not dereferenced
//
// `bundle` rather than `dereference`: it resolves external files and leaves
// internal `$ref`s standing. That is the opposite of what a mock server wants
// and exactly what a graph wants, because `#/components/schemas/User` is an
// edge and `User` is a node id.
//
// Two documents may both call a schema `User`. Rather than qualify every name
// and make the single-document case ugly, names are qualified only where they
// actually collide, and every `$ref` in the corpus is rewritten to the id that
// was settled on. Below this file there is one flat namespace of type ids.
// ---------------------------------------------------------------------------

export const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

export type Method = (typeof METHODS)[number];

export type ParamIn = 'path' | 'query' | 'header' | 'cookie' | 'formData';

export type MethodType = 'read_only' | 'read_write';

/** GET/HEAD/OPTIONS answer a question; everything else changes something. */
export function methodTypeOf(method: Method): MethodType {
    return method === 'get' || method === 'head' || method === 'options'
        ? 'read_only'
        : 'read_write';
}

export interface ParamSpec {
    name: string;
    in: ParamIn;
    required: boolean;
    doc: string;
    schema: Schema;
}

export interface ResponseSpec {
    status: number;
    doc: string;
    schema: Schema;
}

export interface Operation {
    source: string;
    method: Method;
    /** the template, `/users/{user_id}` */
    path: string;
    operationId: string;
    summary: string;
    description: string;
    tags: string[];
    params: ParamSpec[];
    requestBody?: { required: boolean; schema: Schema };
    /** every 2xx that carries a body, in status order */
    responses: ResponseSpec[];
}

export interface ApiDoc {
    source: string;
    sha256: string;
    dialect: Dialect;
    title: string;
    version: string;
}

export interface Corpus {
    docs: ApiDoc[];
    operations: Operation[];
    /** every named component schema in the corpus, by its settled id */
    types: Record<string, Schema>;
    /** which document each type id came from */
    typeSource: Record<string, string>;
}

/** A `CliError` so an unreadable document exits 3 wherever it is raised. */
export class SpecError extends CliError {
    constructor(message: string, hint?: string) {
        super(message, EXIT.invalid, hint);
        this.name = 'SpecError';
    }
}

interface RawDoc {
    swagger?: string;
    openapi?: string;
    basePath?: string;
    info?: { title?: string; version?: string };
    paths?: Record<string, unknown>;
    definitions?: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
}

interface Loaded {
    doc: ApiDoc;
    slug: string;
    operations: Operation[];
    /** component name as written in the document -> normalized schema */
    types: Map<string, Schema>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadSpecs(files: readonly string[]): Promise<Corpus> {
    if (files.length === 0) {
        throw new SpecError('no document given', 'name at least one openapi/swagger file');
    }
    const loaded: Loaded[] = [];
    for (const file of files) {
        loaded.push(await loadSpec(file));
    }
    return settle(loaded);
}

async function loadSpec(file: string): Promise<Loaded> {
    let raw: RawDoc;
    try {
        raw = (await SwaggerParser.bundle(file)) as RawDoc;
    } catch (err) {
        throw new SpecError(
            `${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
            'the document must be a readable OpenAPI 3.x or Swagger 2.0 file',
        );
    }

    const dialect = dialectOf(raw, file);
    const source = raw.components?.schemas ?? raw.definitions ?? {};
    const types = new Map<string, Schema>();
    for (const [name, schema] of Object.entries(source)) {
        types.set(name, normalize(schema, dialect));
    }

    return {
        doc: {
            source: file,
            sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
            dialect,
            title: raw.info?.title?.trim() || basename(file),
            version: raw.info?.version?.trim() || '',
        },
        slug: slugOf(file),
        operations: operationsOf(raw, dialect, file),
        types,
    };
}

function dialectOf(doc: RawDoc, file: string): Dialect {
    if (doc.swagger?.startsWith('2.')) {
        return 'swagger-2.0';
    }
    if (doc.openapi?.startsWith('3.1')) {
        return 'openapi-3.1';
    }
    if (doc.openapi?.startsWith('3.')) {
        return 'openapi-3.0';
    }
    throw new SpecError(`${file}: neither \`swagger: 2.0\` nor \`openapi: 3.x\` is declared`);
}

function slugOf(file: string): string {
    const name = basename(file, extname(file));
    return name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'api';
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function operationsOf(raw: RawDoc, dialect: Dialect, file: string): Operation[] {
    const prefix = dialect === 'swagger-2.0' ? (raw.basePath ?? '') : '';
    const out: Operation[] = [];

    for (const [template, item] of Object.entries(raw.paths ?? {})) {
        if (!isObject(item)) {
            continue;
        }
        // Path-level parameters apply to every method on it, and an operation
        // may override one by repeating its name and location.
        const shared = paramsOf(item.parameters, dialect);
        for (const method of METHODS) {
            const op = item[method];
            if (!isObject(op)) {
                continue;
            }
            const path = join(prefix, template);
            const own = paramsOf(op.parameters, dialect);
            out.push({
                source: file,
                method,
                path,
                operationId: text(op.operationId) || synthesizeId(method, path),
                summary: text(op.summary),
                description: text(op.description),
                tags: Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string') : [],
                params: override(shared, own).filter((p): p is ParamSpec => p.in !== 'body'),
                requestBody: bodyOf(op, own, dialect),
                responses: responsesOf(op, dialect),
            });
        }
    }
    return out;
}

function join(prefix: string, template: string): string {
    const base = prefix.replace(/\/+$/, '');
    return `${base}${template.startsWith('/') ? '' : '/'}${template}` || '/';
}

function synthesizeId(method: Method, path: string): string {
    const tail = path
        .replace(/[{}]/g, '')
        .split('/')
        .filter(Boolean)
        .join('_')
        .replace(/[^A-Za-z0-9_]+/g, '_');
    return `${method}_${tail || 'root'}`;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Swagger 2.0 keeps its body in the parameter list; 3.x has `requestBody`. */
interface RawParam extends Omit<ParamSpec, 'in'> {
    in: ParamIn | 'body';
}

function paramsOf(value: unknown, dialect: Dialect): RawParam[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const out: RawParam[] = [];
    for (const entry of value) {
        if (!isObject(entry) || typeof entry.name !== 'string') {
            continue;
        }
        const where = entry.in;
        if (typeof where !== 'string') {
            continue;
        }
        // Swagger 2.0 puts the type keywords on the parameter itself; 3.x
        // wraps them in `schema`, which is the shape everything below wants.
        const schema = isObject(entry.schema) ? entry.schema : envelope(entry);
        out.push({
            name: entry.name,
            in: where as ParamIn | 'body',
            required: entry.required === true || where === 'path',
            doc: docOf(entry) || docOf(schema),
            schema: normalize(schema, dialect),
        });
    }
    return out;
}

/** What is left of a Swagger 2.0 parameter once it stops describing itself. */
const ENVELOPE = new Set([
    'name',
    'in',
    'required',
    'description',
    'allowEmptyValue',
    'collectionFormat',
    'schema',
]);

function envelope(entry: Schema): Schema {
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !ENVELOPE.has(key)));
}

/** An operation-level parameter replaces the path-level one it shadows. */
function override(shared: RawParam[], own: RawParam[]): RawParam[] {
    const key = (p: RawParam) => `${p.in}:${p.name}`;
    const taken = new Set(own.map(key));
    return [...shared.filter((p) => !taken.has(key(p))), ...own];
}

function bodyOf(
    op: Schema,
    params: RawParam[],
    dialect: Dialect,
): { required: boolean; schema: Schema } | undefined {
    const body = params.find((p) => p.in === 'body');
    if (body) {
        return { required: body.required, schema: body.schema };
    }
    const request = op.requestBody;
    if (!isObject(request)) {
        return undefined;
    }
    const schema = pickContent(request.content);
    return schema
        ? { required: request.required === true, schema: normalize(schema, dialect) }
        : undefined;
}

function responsesOf(op: Schema, dialect: Dialect): ResponseSpec[] {
    const responses = op.responses;
    if (!isObject(responses)) {
        return [];
    }
    const out: ResponseSpec[] = [];
    for (const [code, value] of Object.entries(responses)) {
        const status = Number(code);
        if (!Number.isInteger(status) || status < 200 || status > 299 || !isObject(value)) {
            continue;
        }
        // Swagger 2.0 hangs the schema straight off the response.
        const schema =
            pickContent(value.content) ?? (isObject(value.schema) ? value.schema : undefined);
        // A 204 says the call worked and nothing else; there is no node in it.
        if (!schema) {
            continue;
        }
        out.push({ status, doc: docOf(value), schema: normalize(schema, dialect) });
    }
    return out.sort((a, b) => a.status - b.status);
}

/** JSON first; anything else only if the operation speaks nothing else. */
function pickContent(content: unknown): Schema | undefined {
    if (!isObject(content)) {
        return undefined;
    }
    const entries = Object.entries(content).filter(([, v]) => isObject(v) && isObject(v.schema));
    const json = entries.find(([type]) => /\bjson\b/.test(type)) ?? entries[0];
    return json ? ((json[1] as Schema).schema as Schema) : undefined;
}

// ---------------------------------------------------------------------------
// Settling names
// ---------------------------------------------------------------------------

/**
 * Assigns every component schema its final id and rewrites the corpus to use
 * it. A name owned by one document keeps it; a name two documents both claim
 * becomes `<slug>.<Name>` on both sides, so an id never silently changes
 * meaning depending on which file was read first.
 */
function settle(loaded: Loaded[]): Corpus {
    const owners = new Map<string, number>();
    for (const one of loaded) {
        for (const name of one.types.keys()) {
            owners.set(name, (owners.get(name) ?? 0) + 1);
        }
    }

    const ids = loaded.map((one) => {
        const map = new Map<string, string>();
        for (const name of one.types.keys()) {
            map.set(name, owners.get(name) === 1 ? name : `${one.slug}.${name}`);
        }
        return map;
    });

    const types: Record<string, Schema> = {};
    const typeSource: Record<string, string> = {};
    const operations: Operation[] = [];
    const seenOps = new Set<string>();

    loaded.forEach((one, index) => {
        const map = ids[index]!;
        for (const [name, schema] of one.types) {
            const id = map.get(name)!;
            types[id] = rewrite(schema, map) as Schema;
            typeSource[id] = one.doc.source;
        }
        for (const op of one.operations) {
            operations.push({
                ...op,
                operationId: unique(op.operationId, one.slug, seenOps),
                params: op.params.map((p) => ({ ...p, schema: rewrite(p.schema, map) as Schema })),
                requestBody: op.requestBody && {
                    ...op.requestBody,
                    schema: rewrite(op.requestBody.schema, map) as Schema,
                },
                responses: op.responses.map((r) => ({
                    ...r,
                    schema: r.schema && (rewrite(r.schema, map) as Schema),
                })),
            });
        }
    });

    return { docs: loaded.map((one) => one.doc), operations, types, typeSource };
}

function unique(id: string, slug: string, seen: Set<string>): string {
    let candidate = seen.has(id) ? `${slug}.${id}` : id;
    for (let n = 2; seen.has(candidate); n++) {
        candidate = `${slug}.${id}_${n}`;
    }
    seen.add(candidate);
    return candidate;
}

/** Points every internal `$ref` at the settled id, in one flat `$defs` space. */
function rewrite(value: unknown, ids: Map<string, string>): unknown {
    if (Array.isArray(value)) {
        return value.map((v) => rewrite(v, ids));
    }
    if (!isObject(value)) {
        return value;
    }
    const out: Schema = {};
    for (const [key, inner] of Object.entries(value)) {
        if (key === '$ref' && typeof inner === 'string') {
            const name = /^#\/(?:components\/schemas|definitions|\$defs)\/(.+)$/.exec(inner)?.[1];
            const decoded =
                name && decodeURIComponent(name.replace(/~1/g, '/').replace(/~0/g, '~'));
            out.$ref = decoded ? `#/$defs/${ids.get(decoded) ?? decoded}` : inner;
        } else {
            out[key] = rewrite(inner, ids);
        }
    }
    return out;
}
