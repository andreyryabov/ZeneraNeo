import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Box } from './box.ts';
import { BuildFailed, type Cache } from './cache.ts';
import type { GeneratorInput } from './envelope.ts';
import { reason } from './generate.ts';
import {
    formatLogLine,
    formatRegenerated,
    formatRegenerating,
    formatRegenLimitHit,
    RegenerationLimiter,
    RequestHistory,
    saveRequestDump,
    type ErrorKind,
    type RequestDumpData,
} from './logger.ts';
import { indexPage } from './page.ts';
import { cutLoop, pagingSeen } from './paging.ts';
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
    requestsDir?: string;
    regenLimit?: number;
    history?: RequestHistory;
    limiter?: RegenerationLimiter;
}

export interface Listening {
    server: Server;
    port: number;
    close(): Promise<void>;
}

export function build(opts: ServerOptions): Server {
    const history = opts.history ?? new RequestHistory();
    const limiter = opts.limiter ?? new RegenerationLimiter(opts.regenLimit ?? 3);
    const requestsDir = opts.requestsDir ?? join(opts.box.root, 'requests');
    const enriched: ServerOptions = { ...opts, history, limiter, requestsDir };

    return createServer((req, res) => {
        handle(req, res, enriched).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            send(res, 500, { error: message });
            opts.onRequest?.(
                `${req.method ?? 'GET'} ${req.url ?? '/'} 500 [SERVER_INTERNAL_ERROR] ${message}`,
            );
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
    const timestamp = new Date(started);
    const id = randomUUID().slice(0, 8);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toLowerCase();

    const finish = async (
        status: number,
        meta: {
            errorKind?: ErrorKind;
            errorMessage?: string;
            stderr?: string;
            issues?: readonly unknown[];
            note?: string;
            operationId?: string;
            routePath?: string;
            pathParams?: Record<string, string>;
            query?: Record<string, string>;
            requestBody?: unknown;
            responseBody?: unknown;
            cacheStatus?: 'hit' | 'miss' | 'regenerated';
            regenerated?: boolean;
            regenAttempts?: number;
            regenLimitHit?: boolean;
        },
    ): Promise<void> => {
        const responseHeaders = Object.fromEntries(
            Object.entries(res.getHeaders()).map(([k, v]) => [k, String(v)]),
        );

        const dumpData: RequestDumpData = {
            id,
            timestamp,
            durationMs: Date.now() - started,
            method,
            url: req.url ?? '/',
            pathname: url.pathname,
            search: url.search,
            operationId: meta.operationId,
            routePath: meta.routePath,
            pathParams: meta.pathParams,
            query: meta.query ?? Object.fromEntries(url.searchParams),
            requestHeaders: safeHeaders(req),
            requestBody: meta.requestBody,
            status,
            responseHeaders,
            responseBody: meta.responseBody,
            errorKind: meta.errorKind,
            errorMessage: meta.errorMessage,
            stderr: meta.stderr,
            cacheStatus: meta.cacheStatus,
            regenerated: meta.regenerated,
            regenAttempts: meta.regenAttempts,
            regenLimitHit: meta.regenLimitHit,
            regenLimit: opts.limiter?.limit,
            issues: meta.issues,
            note: meta.note,
        };

        let dumpPath = '';
        const shouldDump = Boolean(
            opts.requestsDir &&
            url.pathname !== '/' &&
            !url.pathname.startsWith('/__faker/') &&
            meta.operationId,
        );
        if (shouldDump) {
            try {
                dumpPath = await saveRequestDump(opts.requestsDir!, dumpData);
            } catch {
                // Ignore filesystem dump write failures so server remains operational
            }
        }
        if (opts.onRequest) {
            opts.onRequest(formatLogLine(dumpData, dumpPath));
        }
    };

    if (url.pathname.startsWith('/__faker/')) {
        introspect(url.pathname, res, opts);
        await finish(200, { note: 'introspection' });
        return;
    }

    const match = opts.router.match(method, url.pathname, url.searchParams);
    if (!match) {
        // The document owns `/` only when it declares it. Otherwise the root is
        // the contents page, which is what a browser pointed here came for.
        if (url.pathname === '/' && (method === 'get' || method === 'head')) {
            const end = prepareHtml(res, indexPage(opts.router.operations));
            await finish(200, { note: 'index' });
            end();
            return;
        }
        // The path matched and the query did not, which no one guesses unaided
        // — and it is not a 405 either, since the method is defined here.
        const expects = opts.router.expects(method, url.pathname);
        if (expects.length > 0) {
            const bodyObj = {
                error: `${req.method} ${url.pathname} is only defined with a query`,
                expects,
            };
            const end = prepareSend(res, 404, bodyObj);
            await finish(404, {
                errorKind: 'CLIENT_ERROR: NOT_FOUND',
                errorMessage: `expects ${expects.join(' ')}`,
                responseBody: bodyObj,
                note: `expects ${expects.join(' ')}`,
            });
            end();
            return;
        }
        const allowed = opts.router.allowed(url.pathname, url.searchParams);
        if (allowed.length > 0) {
            res.setHeader('allow', allowed.map((m) => m.toUpperCase()).join(', '));
            const bodyObj = { error: `${req.method} is not defined for ${url.pathname}` };
            const end = prepareSend(res, 405, bodyObj);
            await finish(405, {
                errorKind: 'CLIENT_ERROR: METHOD_NOT_ALLOWED',
                errorMessage: 'no such method',
                responseBody: bodyObj,
                note: 'no such method',
            });
            end();
            return;
        }
        const bodyObj = {
            error: `no operation matches ${req.method} ${url.pathname}`,
        };
        const end = prepareSend(res, 404, bodyObj);
        await finish(404, {
            errorKind: 'CLIENT_ERROR: NOT_FOUND',
            errorMessage: 'no route',
            responseBody: bodyObj,
            note: 'no route',
        });
        end();
        return;
    }

    const { operation, pathParams } = match;
    res.setHeader('x-faker-operation', operation.operationId);

    let body: unknown;
    try {
        body = await readBody(req, opts.maxBody ?? DEFAULT_MAX_BODY);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes('too large') ? 413 : 400;
        const errorKind: ErrorKind =
            status === 413 ? 'CLIENT_ERROR: PAYLOAD_TOO_LARGE' : 'CLIENT_ERROR: BAD_REQUEST';
        const bodyObj = { error: message };
        const end = prepareSend(res, status, bodyObj);
        await finish(status, {
            operationId: operation.operationId,
            routePath: operation.path,
            pathParams,
            errorKind,
            errorMessage: message,
            responseBody: bodyObj,
            note: status === 413 ? 'body too large' : 'bad body',
        });
        end();
        return;
    }

    const problems = check(operation, opts.checks, pathParams, url.searchParams, body);
    if (problems.length > 0) {
        const desc = describeIssues(problems);
        const bodyObj = { error: desc, issues: problems };
        const end = prepareSend(res, 400, bodyObj);
        await finish(400, {
            operationId: operation.operationId,
            routePath: operation.path,
            pathParams,
            requestBody: body,
            errorKind: 'CLIENT_ERROR: VALIDATION_FAILED',
            errorMessage: desc,
            issues: problems,
            responseBody: bodyObj,
            note: desc,
        });
        end();
        return;
    }

    if (!operation.success.schema) {
        res.statusCode = operation.success.status;
        await finish(operation.success.status, {
            operationId: operation.operationId,
            routePath: operation.path,
            pathParams,
            requestBody: body,
            note: 'no body declared',
        });
        res.end();
        return;
    }

    let generator;
    try {
        generator = await opts.cache.ensure(operation);
    } catch (err) {
        const status = err instanceof BuildFailed ? 501 : 500;
        const detail = reason(err);
        const bodyObj = {
            error: `no generator for ${operation.operationId}`,
            detail,
            diagnostics: err instanceof BuildFailed ? err.diagnostics : undefined,
        };
        const end = prepareSend(res, status, bodyObj);
        await finish(status, {
            operationId: operation.operationId,
            routePath: operation.path,
            pathParams,
            requestBody: body,
            errorKind: 'GENERATOR_BUILD_FAILED',
            errorMessage: `no generator: ${detail}`,
            responseBody: bodyObj,
            note: `no generator: ${detail}`,
        });
        end();
        return;
    }
    res.setHeader('x-faker-cache', generator.cached ? 'hit' : 'miss');
    let cacheStatus: 'hit' | 'miss' | 'regenerated' = generator.cached ? 'hit' : 'miss';

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

    let outcome = await opts.box.run(operation.key, input);

    const responseValidator = opts.checks.for(operation).response;
    let schemaMismatch = false;
    if (outcome.ok && responseValidator && !responseValidator(outcome.value)) {
        schemaMismatch = true;
        const desc = describeIssues(issues('', responseValidator.errors));
        outcome = {
            ok: false,
            fault: `output does not match response schema — ${desc}`,
            stderr: outcome.stderr,
            durationMs: outcome.durationMs,
            value: outcome.value,
        };
    }

    if (!outcome.ok) {
        const urlKey = url.pathname;
        const errorKind: ErrorKind = outcome.fault?.includes('longer than')
            ? 'GENERATOR_TIMEOUT'
            : schemaMismatch
              ? 'GENERATOR_SCHEMA_MISMATCH'
              : 'GENERATOR_FAULT';

        // Check regeneration limit for this URL
        if (opts.limiter!.isLimitHit(urlKey)) {
            opts.onRequest?.(
                formatRegenLimitHit(urlKey, opts.limiter!.limit, operation.operationId),
            );
            const bodyObj = {
                error: `the generator for ${operation.operationId} ${outcome.fault}`,
                stderr: outcome.stderr || undefined,
                regenerationLimitHit: true,
                regenerationLimit: opts.limiter!.limit,
            };
            const end = prepareSend(res, 502, bodyObj);
            await finish(502, {
                operationId: operation.operationId,
                routePath: operation.path,
                pathParams,
                requestBody: body,
                errorKind,
                errorMessage: `${outcome.fault} (regeneration limit reached)`,
                stderr: outcome.stderr,
                responseBody: bodyObj,
                cacheStatus,
                regenLimitHit: true,
                note: 'generator faulted (limit hit)',
            });
            end();
            return;
        }

        const attempt = opts.limiter!.increment(urlKey);
        opts.onRequest?.(
            formatRegenerating(
                urlKey,
                attempt,
                opts.limiter!.limit,
                operation.operationId,
                outcome.fault,
            ),
        );

        const regenStarted = Date.now();
        let currentSource = generator.source;
        if (!currentSource?.trim()) {
            currentSource = (await opts.cache.getSource?.(operation.key)) ?? '';
        }
        if (!currentSource?.trim()) {
            try {
                currentSource = await readFile(opts.box.sourceOf(operation.key), 'utf8');
            } catch {
                currentSource = '# generator';
            }
        }

        const examples = opts.history!.getSuccessful(operation.key, 2);

        try {
            await opts.cache.regenerate(operation, {
                currentSource,
                failingInput: input,
                fault: outcome.fault ?? 'generator faulted',
                stderr: outcome.stderr,
                examples,
            });

            cacheStatus = 'regenerated';
            res.setHeader('x-faker-cache', 'regenerated');
            opts.onRequest?.(
                formatRegenerated(
                    urlKey,
                    attempt,
                    Date.now() - regenStarted,
                    operation.operationId,
                ),
            );

            // Re-run the request with the newly regenerated generator
            outcome = await opts.box.run(operation.key, input);
            if (outcome.ok && responseValidator && !responseValidator(outcome.value)) {
                outcome = {
                    ok: false,
                    fault: 'output does not match response schema after regeneration',
                    stderr: outcome.stderr,
                    durationMs: outcome.durationMs,
                };
            }
        } catch (regenErr) {
            const detail = reason(regenErr);
            const bodyObj = {
                error: `regeneration failed for ${operation.operationId}: ${detail}`,
                stderr: outcome.stderr || undefined,
                regenerated: false,
            };
            const end = prepareSend(res, 502, bodyObj);
            await finish(502, {
                operationId: operation.operationId,
                routePath: operation.path,
                pathParams,
                requestBody: body,
                errorKind: 'REGENERATION_FAILED',
                errorMessage: `regeneration failed: ${detail}`,
                stderr: outcome.stderr,
                responseBody: bodyObj,
                cacheStatus,
                regenAttempts: attempt,
                note: 'regeneration failed',
            });
            end();
            return;
        }

        if (!outcome.ok) {
            const bodyObj = {
                error: `the regenerated generator for ${operation.operationId} ${outcome.fault}`,
                stderr: outcome.stderr || undefined,
                regenerated: true,
            };
            const end = prepareSend(res, 502, bodyObj);
            await finish(502, {
                operationId: operation.operationId,
                routePath: operation.path,
                pathParams,
                requestBody: body,
                errorKind,
                errorMessage: `regenerated generator ${outcome.fault}`,
                stderr: outcome.stderr,
                responseBody: bodyObj,
                cacheStatus,
                regenerated: true,
                regenAttempts: attempt,
                note: 'regenerated generator faulted',
            });
            end();
            return;
        }
    }

    const note = cacheStatus;
    const looped = cut(operation, outcome.value, url.searchParams);
    opts.history!.recordSuccess(operation.key, input, outcome.value);
    const end = prepareSend(res, operation.success.status, outcome.value);
    await finish(operation.success.status, {
        operationId: operation.operationId,
        routePath: operation.path,
        pathParams,
        requestBody: body,
        responseBody: outcome.value,
        cacheStatus,
        regenerated: cacheStatus === 'regenerated',
        note: looped ? `${note} · cut a looping page token` : note,
    });
    end();
}

/**
 * The generator on disk was written before the pagination rule existed, and a
 * cache is not rebuilt just because the rule changed. A body offering back the
 * token it was handed is therefore still possible, and it is the one bug here
 * that costs the client rather than the mock: it hangs.
 */
function cut(operation: Operation, value: unknown, query: URLSearchParams): boolean {
    const paging =
        operation.paging ?? pagingSeen(operation.params, operation.success.schema, query);
    if (!paging) {
        return false;
    }
    const sent = query.get(paging.param);
    return sent !== null && cutLoop(value, paging, sent);
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
                paging: o.paging,
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

function prepareSend(res: ServerResponse, status: number, value: unknown): () => void {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(text));
    return () => res.end(text);
}

function send(res: ServerResponse, status: number, value: unknown): void {
    prepareSend(res, status, value)();
}

function prepareHtml(res: ServerResponse, text: string): () => void {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-length', Buffer.byteLength(text));
    return () => res.end(text);
}

/** Node drops the body itself when the request was a HEAD. */
function html(res: ServerResponse, text: string): void {
    prepareHtml(res, text)();
}
