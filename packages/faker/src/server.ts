import { createHash, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Box } from './box.ts';
import { BuildFailed, type Cache } from './cache.ts';
import type { GeneratorInput } from './envelope.ts';
import { reason } from './generate.ts';
import type { Router } from './router.ts';
import type { Operation } from './spec.ts';
import { describeIssues, issues, type Checks, type Issue } from './validate.ts';

// ---------------------------------------------------------------------------
// The server
//
// `node:http` and a switch. A framework would earn its place if there were
// middleware to compose, and there is not: one route table, one validation
// step, one generator.
//
// The rules that are not obvious from the code are the ones about what does not
// travel. Request headers are filtered before the envelope is written, because
// that envelope becomes a file inside a container. Request bodies never reach a
// prompt at all — the build loop uses probes it made up. And the listener binds
// to loopback unless somebody says otherwise in as many words.
// ---------------------------------------------------------------------------

/** Headers that are none of a generator's business. */
const REDACTED = /^(authorization|cookie|set-cookie|proxy-authorization)$/i;
const SECRETISH = /key|token|secret|password|credential/i;

const DEFAULT_MAX_BODY = 1024 * 1024;

export interface ServerOptions {
    router: Router;
    cache: Cache;
    checks: Checks;
    box: Box;
    /** fixed base seed — the same request then answers the same way */
    seed?: number;
    maxBody?: number;
    onRequest?: (line: string) => void;
}

export interface Listening {
    server: Server;
    port: number;
    close(): Promise<void>;
}

export function build(opts: ServerOptions): Server {
    return createServer((req, res) => {
        handle(req, res, opts).catch((err: unknown) => {
            // Nothing below is expected to throw; if it does, the client still
            // gets an answer and the operator still gets the reason.
            send(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
    });
}

export async function listen(opts: ServerOptions, host: string, port: number): Promise<Listening> {
    const server = build(opts);
    await new Promise<void>((settle, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => {
            server.off('error', fail);
            settle();
        });
    });
    return {
        server,
        port: (server.address() as AddressInfo).port,
        close: () =>
            new Promise<void>((settle) => {
                server.close(() => settle());
                server.closeIdleConnections();
            }),
    };
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    opts: ServerOptions,
): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toLowerCase();
    // The search string is part of the request: without it a 400 caused by a
    // query parameter is unexplainable from the log.
    const say = (status: number, what: string): void =>
        opts.onRequest?.(
            `${req.method} ${url.pathname}${url.search} ${status} ${Date.now() - started}ms ${what}`,
        );

    if (url.pathname.startsWith('/__faker/')) {
        introspect(url.pathname, res, opts);
        say(200, 'introspection');
        return;
    }

    const match = opts.router.match(method, url.pathname);
    if (!match) {
        const allowed = opts.router.allowed(url.pathname);
        if (allowed.length > 0) {
            res.setHeader('allow', allowed.map((m) => m.toUpperCase()).join(', '));
            send(res, 405, { error: `${req.method} is not defined for ${url.pathname}` });
            say(405, 'no such method');
            return;
        }
        send(res, 404, { error: `no operation matches ${req.method} ${url.pathname}` });
        say(404, 'no route');
        return;
    }

    const { operation, pathParams } = match;
    res.setHeader('x-faker-operation', operation.operationId);

    let body: unknown;
    try {
        body = await readBody(req, opts.maxBody ?? DEFAULT_MAX_BODY);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(res, message.includes('too large') ? 413 : 400, { error: message });
        say(400, 'bad body');
        return;
    }

    const problems = check(operation, opts.checks, pathParams, url.searchParams, body);
    if (problems.length > 0) {
        send(res, 400, { error: describeIssues(problems), issues: problems });
        say(400, describeIssues(problems));
        return;
    }

    if (!operation.success.schema) {
        res.statusCode = operation.success.status;
        res.end();
        say(operation.success.status, 'no body declared');
        return;
    }

    let generator;
    try {
        generator = await opts.cache.ensure(operation);
    } catch (err) {
        const status = err instanceof BuildFailed ? 501 : 500;
        const detail = reason(err);
        send(res, status, {
            error: `no generator for ${operation.operationId}`,
            detail,
            diagnostics: err instanceof BuildFailed ? err.diagnostics : undefined,
        });
        say(status, `no generator: ${detail}`);
        return;
    }
    res.setHeader('x-faker-cache', generator.cached ? 'hit' : 'miss');

    const input: GeneratorInput = {
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        pathParams,
        query: Object.fromEntries(url.searchParams),
        headers: safeHeaders(req),
        body,
        seed: seedFor(opts.seed, operation, pathParams, url.searchParams),
    };

    const outcome = await opts.box.run(operation.key, input);
    if (!outcome.ok) {
        send(res, 502, {
            error: `the generator for ${operation.operationId} ${outcome.fault}`,
            stderr: outcome.stderr || undefined,
        });
        say(502, 'generator faulted');
        return;
    }

    send(res, operation.success.status, outcome.value);
    say(operation.success.status, generator.cached ? 'hit' : 'miss');
}

function check(
    operation: Operation,
    checks: Checks,
    pathParams: Record<string, string>,
    query: URLSearchParams,
    body: unknown,
): Issue[] {
    const compiled = checks.for(operation);
    const out: Issue[] = [];

    // Coercion rewrites what it is given, so the copies are validated and the
    // originals are what reach the generator.
    if (!compiled.path({ ...pathParams })) {
        out.push(...issues('path', compiled.path.errors));
    }
    if (!compiled.query(Object.fromEntries(query))) {
        out.push(...issues('query', compiled.query.errors));
    }
    if (compiled.body) {
        if (body === undefined) {
            if (compiled.bodyRequired) {
                out.push({ where: 'body', message: 'is required' });
            }
        } else if (!compiled.body(body)) {
            out.push(...issues('body', compiled.body.errors));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Wire details
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
    const claimed = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(claimed) && claimed > max) {
        throw new Error(`the body is too large (${claimed} bytes, limit ${max})`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > max) {
            req.destroy();
            throw new Error(`the body is too large (limit ${max} bytes)`);
        }
        chunks.push(chunk as Buffer);
    }
    if (size === 0) {
        return undefined;
    }

    const text = Buffer.concat(chunks).toString('utf8');
    const type = String(req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim();
    if (type && type !== 'application/json' && !type.endsWith('+json')) {
        return text;
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(
            `the body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
}

/**
 * Headers reach the generator so it can vary on things like `accept-language`.
 * Credentials do not: the envelope is written to a file inside a container, and
 * a mock is exactly what people point a real bearer token at by accident.
 */
function safeHeaders(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || REDACTED.test(name) || SECRETISH.test(name)) {
            continue;
        }
        out[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
}

/**
 * Without a base seed every call is a fresh roll, which is what a demo wants.
 * With one, the seed is a function of the request, so polling the same URL
 * returns the same body and a test can assert on it.
 */
function seedFor(
    base: number | undefined,
    operation: Operation,
    pathParams: Record<string, string>,
    query: URLSearchParams,
): number {
    if (base === undefined) {
        return randomInt(1, 2 ** 31 - 1);
    }
    const shape = JSON.stringify([
        base,
        operation.key,
        Object.entries(pathParams).sort(),
        [...query.entries()].sort(),
    ]);
    return createHash('sha256').update(shape).digest().readUInt32BE(0) % 2 ** 31;
}

function introspect(pathname: string, res: ServerResponse, opts: ServerOptions): void {
    if (pathname === '/__faker/routes') {
        send(
            res,
            200,
            opts.router.operations.map((o) => ({
                method: o.method.toUpperCase(),
                path: o.path,
                operationId: o.operationId,
                status: o.success.status,
                body: Boolean(o.success.schema),
                key: o.key,
                source: o.source,
            })),
        );
        return;
    }
    if (pathname === '/__faker/health') {
        send(res, 200, { ok: true, operations: opts.router.operations.length });
        return;
    }
    send(res, 404, { error: `no such endpoint: ${pathname}` });
}

function send(res: ServerResponse, status: number, value: unknown): void {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(text));
    res.end(text);
}
