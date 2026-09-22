import { Cache as Store } from '@zenera/cli/lib';
import {
    SANDBOX_MOUNT,
    type Model,
    type ModelRequest,
    type ProcResult,
    type Runner,
} from '@zenera/neo';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from '../src/box.ts';
import { Cache, FAKER_KIND } from '../src/cache.ts';
import { Router } from '../src/router.ts';
import { listen, type Listening } from '../src/server.ts';
import { loadSpec } from '../src/spec.ts';
import { Checks } from '../src/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));

function engineWith(
    answer: (input: Record<string, unknown>, source: string) => unknown,
    root: string,
): Runner {
    return (_bin, args, opts) => {
        const base: ProcResult = {
            code: 0,
            stdout: '',
            stderr: '',
            truncated: false,
            timedOut: false,
        };
        if (args[0] === 'container' || args[0] === 'run' || args[0] === 'start') {
            return Promise.resolve(base);
        }
        const [, inPath, outPath] = (opts?.input ?? '').split(/\s+/).slice(-3);
        const host = (p: string): string => join(root, p.slice(SANDBOX_MOUNT.length + 1));
        const input = JSON.parse(readFileSync(host(inPath), 'utf8')) as Record<string, unknown>;

        // Find generator source for this operation
        let source = '';
        try {
            const matches = (opts?.input ?? '').match(/generators\/([^/]+)\/gen\.py/);
            if (matches) {
                source = readFileSync(join(root, 'generators', matches[1], 'gen.py'), 'utf8');
            }
        } catch {
            // ignore
        }

        const val = answer(input, source);
        if (val === undefined) {
            return Promise.resolve({
                ...base,
                code: 1,
                stderr: 'ZeroDivisionError: division by zero',
            });
        }
        writeFileSync(host(outPath), JSON.stringify(val));
        return Promise.resolve(base);
    };
}

describe('faker logging, markdown dump, error distinction and regeneration', () => {
    let root: string;
    let live: Listening;
    let base: string;
    let log: string[];
    let requestsDir: string;
    let lastPromptText = '';
    let modelCalls = 0;

    const mockModel: Model = {
        id: 'test-model',
        generate: (req: ModelRequest) => {
            modelCalls++;
            const userMsg = req.messages.find((m) => m.role === 'user');
            if (userMsg && Array.isArray(userMsg.content)) {
                lastPromptText = userMsg.content
                    .map((c) => (c.type === 'text' ? c.text : ''))
                    .join('');
            } else if (userMsg && typeof userMsg.content === 'string') {
                lastPromptText = userMsg.content;
            }
            return Promise.resolve({
                text: '# regenerated python code',
                toolCalls: [],
            });
        },
    };

    const bootServer = async (
        answer: (input: Record<string, unknown>, source: string) => unknown,
        opts: { regenLimit?: number; attempts?: number } = {},
    ): Promise<void> => {
        const operations = await loadSpec(join(here, 'specs', 'petstore.yaml'));
        requestsDir = join(root, 'req_dumps');
        const box = new Box({
            root,
            image: 'stub',
            exec: engineWith(answer, root),
        });
        const checks = new Checks();
        const cacheDir = join(root, 'store');
        const store = new Store(FAKER_KIND, { dir: cacheDir });
        for (const op of operations) {
            store.put(op.key, {
                source: '# initial code\ndef handler(): pass',
                meta: { model: 'test-model' },
            });
        }
        const cache = new Cache({
            box,
            checks,
            model: mockModel,
            cacheDir,
            attempts: opts.attempts ?? 1,
        });
        live = await listen(
            {
                router: new Router(operations),
                checks,
                box,
                cache,
                seed: 42,
                requestsDir,
                regenLimit: opts.regenLimit ?? 3,
                onRequest: (line) => log.push(line),
            },
            '127.0.0.1',
            0,
        );
        base = `http://127.0.0.1:${live.port}`;
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'faker-test-'));
        log = [];
        lastPromptText = '';
        modelCalls = 0;
    });

    afterEach(async () => {
        await live?.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('outputs detailed colored log with timestamp and creates markdown dump file on success', async () => {
        await bootServer((input) => ({
            user_id: Number((input.pathParams as Record<string, unknown>).user_id),
            email: 'alice@example.com',
        }));

        const res = await fetch(`${base}/users/100`);
        expect(res.status).toBe(200);

        // Check log output
        expect(log.length).toBeGreaterThan(0);
        const lastLine = log.at(-1)!;

        // Timestamp check (e.g. [202...])
        expect(lastLine).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/);
        // Method and path
        expect(lastLine).toContain('GET');
        expect(lastLine).toContain('/users/100');
        // Status code and success tag
        expect(lastLine).toContain('200');
        expect(lastLine).toContain('[SUCCESS]');
        // Link to file
        expect(lastLine).toContain('↳ dump:');
        expect(lastLine).toContain('file://');

        // Extract file path from dump line
        const match = lastLine.match(/file:\/\/(.+?\.md)/);
        expect(match).not.toBeNull();
        const filePath = match![1];
        expect(existsSync(filePath)).toBe(true);

        // Verify markdown file contents
        const md = readFileSync(filePath, 'utf8');
        expect(md).toContain('# Request: GET /users/100');
        expect(md).toContain('**Status**: 200 OK');
        expect(md).toContain('### Path Parameters');
        expect(md).toContain('"user_id": "100"');
        expect(md).toContain('### Response Body');
        expect(md).toContain('"email": "alice@example.com"');
    });

    it('distinguishes 4xx validation errors and does NOT trigger generator regeneration', async () => {
        await bootServer(() => ({
            user_id: 1,
            email: 'a@b.com',
        }));

        // Send invalid path param: string instead of integer
        const res = await fetch(`${base}/users/not-an-integer`);
        expect(res.status).toBe(400);

        // No model call for regeneration should happen
        expect(modelCalls).toBe(0);

        const lastLine = log.at(-1)!;
        expect(lastLine).toContain('400');
        expect(lastLine).toContain('[CLIENT_ERROR: VALIDATION_FAILED]');
        expect(lastLine).toContain('path/user_id');

        // Markdown file created
        const match = lastLine.match(/file:\/\/(.+?\.md)/);
        expect(match).not.toBeNull();
        const md = readFileSync(match![1], 'utf8');
        expect(md).toContain('CLIENT_ERROR: VALIDATION_FAILED');
        expect(md).toContain('path/user_id');
    });

    it('distinguishes 404 route not found and 405 method not allowed without regeneration', async () => {
        await bootServer(() => ({}));

        const res404 = await fetch(`${base}/unknown/route`);
        expect(res404.status).toBe(404);
        expect(modelCalls).toBe(0);
        expect(log.at(-1)).toContain('[CLIENT_ERROR: NOT_FOUND]');

        const res405 = await fetch(`${base}/users/123`, { method: 'DELETE' });
        expect(res405.status).toBe(405);
        expect(modelCalls).toBe(0);
        expect(log.at(-1)).toContain('[CLIENT_ERROR: METHOD_NOT_ALLOWED]');
    });

    it('regenerates when generator errors, passing current code + failing input + previous successful requests', async () => {
        let shouldFail = false;

        await bootServer((input, source) => {
            const uid = Number((input.pathParams as Record<string, unknown>).user_id);
            if (shouldFail && uid === 999 && !source.includes('regenerated')) {
                return undefined; // simulate Python exception before regeneration
            }
            return {
                user_id: uid,
                email: `user${uid}@example.com`,
            };
        });

        // Step 1: Send two successful requests first to populate history
        const res1 = await fetch(`${base}/users/1`);
        expect(res1.status).toBe(200);

        const res2 = await fetch(`${base}/users/2`);
        expect(res2.status).toBe(200);

        expect(modelCalls).toBe(0);

        // Step 2: Now trigger error on generator for /users/999
        shouldFail = true;
        const res3 = await fetch(`${base}/users/999`);
        expect(res3.status).toBe(200);
        expect(await res3.json()).toEqual({
            user_id: 999,
            email: 'user999@example.com',
        });

        // Model should have been called for regeneration!
        expect(modelCalls).toBe(1);

        // Check the prompt passed to the model:
        // Must contain: current code, failing request input, fault / traceback, and previous successful requests
        expect(lastPromptText).toContain('CURRENT GENERATOR CODE:');
        expect(lastPromptText).toContain('# initial code');
        expect(lastPromptText).toContain('THE GENERATOR FAILED ON THIS REQUEST:');
        expect(lastPromptText).toContain('"user_id": "999"');
        expect(lastPromptText).toContain('PREVIOUS SUCCESSFUL REQUESTS (use as examples):');
        expect(lastPromptText).toContain('Example 1:');
        expect(lastPromptText).toContain('"user_id": "1"');
        expect(lastPromptText).toContain('Example 2:');
        expect(lastPromptText).toContain('"user_id": "2"');

        // Check log messages:
        const logText = log.join('\n');
        expect(logText).toContain('[REGENERATING]');
        expect(logText).toContain('[REGENERATED]');
        expect(logText).toContain('regenerated');

        // Check dump file
        const lastLog = log.at(-1)!;
        const match = lastLog.match(/file:\/\/(.+?\.md)/);
        expect(match).not.toBeNull();
        const md = readFileSync(match![1], 'utf8');
        expect(md).toContain('**Regenerated**: Yes');
    });

    it('limits number of regenerations per url and outputs special log message when limit is hit', async () => {
        // Always fail for /users/error
        await bootServer(
            (input) => {
                const uid = Number((input.pathParams as Record<string, unknown>).user_id);
                if (uid === 666) {
                    return undefined; // always fail
                }
                return { user_id: uid, email: 'ok@example.com' };
            },
            { regenLimit: 2 },
        );

        // Request 1: fails, attempt 1 regeneration (which also fails because generator still fails)
        const res1 = await fetch(`${base}/users/666`);
        expect(res1.status).toBe(502);
        expect(modelCalls).toBe(1);

        // Request 2: fails, attempt 2 regeneration
        const res2 = await fetch(`${base}/users/666`);
        expect(res2.status).toBe(502);
        expect(modelCalls).toBe(2);

        // Request 3: Limit of 2 is now reached for /users/666!
        // Should NOT call model again!
        const res3 = await fetch(`${base}/users/666`);
        expect(res3.status).toBe(502);
        expect(modelCalls).toBe(2); // no additional call!

        const json = (await res3.json()) as {
            regenerationLimitHit?: boolean;
            regenerationLimit?: number;
        };
        expect(json.regenerationLimitHit).toBe(true);
        expect(json.regenerationLimit).toBe(2);

        // Special log message check!
        const logText = log.join('\n');
        expect(logText).toContain('[REGENERATION_LIMIT_HIT]');
        expect(logText).toContain('Maximum regeneration limit (2) reached for URL "/users/666"');

        // Markdown file records limit hit
        const lastLog = log.at(-1)!;
        const match = lastLog.match(/file:\/\/(.+?\.md)/);
        expect(match).not.toBeNull();
        const md = readFileSync(match![1], 'utf8');
        expect(md).toContain('**Regeneration Limit**: Hit (limit: 2)');
    });

    it('handles non-JSON body as 400 Bad Request without regeneration', async () => {
        await bootServer(() => ({ user_id: 1, email: 'test@example.com' }));

        const res = await fetch(`${base}/users`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{invalid json',
        });
        expect(res.status).toBe(400);
        expect(modelCalls).toBe(0);

        const lastLine = log.at(-1)!;
        expect(lastLine).toContain('[CLIENT_ERROR: BAD_REQUEST]');
        expect(lastLine).toContain('not JSON');
    });

    it('triggers regeneration when generator output does not match response schema', async () => {
        let shouldBreakSchema = true;

        await bootServer((input, source) => {
            const uid = Number((input.pathParams as Record<string, unknown>).user_id);
            if (shouldBreakSchema && !source.includes('regenerated')) {
                // Returns an invalid schema: email is missing or wrong type
                return { user_id: uid, email: 12345 };
            }
            return { user_id: uid, email: 'fixed@example.com' };
        });

        const res = await fetch(`${base}/users/50`);
        expect(res.status).toBe(200);
        expect(modelCalls).toBe(1);
        expect(lastPromptText).toContain('CURRENT GENERATOR CODE:');
        expect(lastPromptText).toContain('Fault: output does not match response schema');
        expect(await res.json()).toEqual({ user_id: 50, email: 'fixed@example.com' });
    });

    it('does not dump file for queries to / or introspection, only for actual generated endpoints', async () => {
        await bootServer(() => ({ user_id: 1, email: 'test@example.com' }));

        // Query to /
        const resRoot = await fetch(`${base}/`);
        expect(resRoot.status).toBe(200);
        expect(log.at(-1)).not.toContain('↳ dump:');

        // Query to introspection
        const resHealth = await fetch(`${base}/__faker/health`);
        expect(resHealth.status).toBe(200);
        expect(log.at(-1)).not.toContain('↳ dump:');

        // Query to unknown path (not an actual endpoint)
        const resUnknown = await fetch(`${base}/not-a-route`);
        expect(resUnknown.status).toBe(404);
        expect(log.at(-1)).not.toContain('↳ dump:');

        // No files in requestsDir yet
        const filesBefore = existsSync(requestsDir) ? readdirSync(requestsDir) : [];
        expect(filesBefore).toEqual([]);

        // Query to actual generated endpoint
        const resUser = await fetch(`${base}/users/1`);
        expect(resUser.status).toBe(200);
        expect(log.at(-1)).toContain('↳ dump:');

        const filesAfter = readdirSync(requestsDir);
        expect(filesAfter.length).toBe(1);
        expect(filesAfter[0]).toContain('GET-users_1');
    });
});
