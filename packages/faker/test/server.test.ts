import { SANDBOX_MOUNT, type Model, type ProcResult, type Runner } from '@zenera/neo';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box } from '../src/box.ts';
import { Cache } from '../src/cache.ts';
import { Router } from '../src/router.ts';
import { listen, type Listening } from '../src/server.ts';
import { loadSpec } from '../src/spec.ts';
import { Checks } from '../src/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A generator that echoes what it is given. Nothing here exercises the model or
 * podman — the question is only what the HTTP layer does with each outcome.
 */
function engineThat(answer: (input: Record<string, unknown>) => unknown, root: string): Runner {
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
        const value = answer(input);
        if (value === undefined) {
            return Promise.resolve({ ...base, code: 1, stderr: 'ValueError: nope' });
        }
        writeFileSync(host(outPath), JSON.stringify(value));
        return Promise.resolve(base);
    };
}

const model: Model = {
    id: 'stub',
    generate: () => Promise.resolve({ text: '# generator', toolCalls: [] }),
};

describe('the server', () => {
    let root: string;
    let live: Listening;
    let base: string;
    let lastInput: Record<string, unknown> | undefined;

    const boot = async (answer: (input: Record<string, unknown>) => unknown): Promise<void> => {
        const operations = await loadSpec(join(here, 'specs', 'petstore.yaml'));
        const box = new Box({
            root,
            image: 'stub',
            exec: engineThat((input) => {
                lastInput = input;
                return answer(input);
            }, root),
        });
        const checks = new Checks();
        live = await listen(
            {
                router: new Router(operations),
                checks,
                box,
                cache: new Cache({ box, checks, model }),
                seed: 7,
            },
            '127.0.0.1',
            0,
        );
        base = `http://127.0.0.1:${live.port}`;
    };

    const echoing = (input: Record<string, unknown>): unknown => ({
        user_id: Number((input.pathParams as Record<string, unknown>).user_id),
        email: 'a@b.com',
    });

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'faker-'));
        lastInput = undefined;
    });

    afterEach(async () => {
        await live?.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('answers with the generated body and the declared status', async () => {
        await boot(echoing);
        const res = await fetch(`${base}/users/12324`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ user_id: 12324, email: 'a@b.com' });
    });

    it('reports whether the generator came out of the cache', async () => {
        await boot(echoing);
        expect((await fetch(`${base}/users/1`)).headers.get('x-faker-cache')).toBe('miss');
        expect((await fetch(`${base}/users/2`)).headers.get('x-faker-cache')).toBe('hit');
    });

    it('rejects a path parameter of the wrong type before generating anything', async () => {
        await boot(echoing);
        const res = await fetch(`${base}/users/not-a-number`);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ issues: [{ where: 'path/user_id' }] });
    });

    it('404s an unknown path and 405s a known one', async () => {
        await boot(echoing);
        expect((await fetch(`${base}/nope`)).status).toBe(404);
        const wrong = await fetch(`${base}/users`, { method: 'PUT' });
        expect(wrong.status).toBe(405);
        expect(wrong.headers.get('allow')).toBe('POST');
    });

    it('answers 204 with no body where the document declares none', async () => {
        await boot(echoing);
        const res = await fetch(`${base}/ping`, { method: 'DELETE' });
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
    });

    it('502s when the generator faults, and says what it said', async () => {
        await boot((input) =>
            (input.pathParams as Record<string, unknown>).user_id === '9'
                ? undefined
                : echoing(input),
        );
        expect((await fetch(`${base}/users/1`)).status).toBe(200);
        const res = await fetch(`${base}/users/9`);
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ stderr: expect.stringContaining('ValueError') });
    });

    it('checks a request body against the document', async () => {
        await boot(() => ({ user_id: 1, email: 'a@b.com' }));
        const res = await fetch(`${base}/users`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ user_id: 'not-a-number' }),
        });
        expect(res.status).toBe(400);
    });

    // The envelope becomes a file inside a container, so this is the one test
    // that is about what does *not* travel.
    it('keeps credentials out of the envelope the generator reads', async () => {
        await boot(echoing);
        await fetch(`${base}/users/1`, {
            headers: {
                authorization: 'Bearer sk-secret',
                cookie: 'session=1',
                'x-api-key': 'nope',
                'accept-language': 'en-GB',
            },
        });
        const headers = lastInput?.headers as Record<string, string>;
        expect(headers['accept-language']).toBe('en-GB');
        expect(headers.authorization).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        expect(headers['x-api-key']).toBeUndefined();
    });

    it('gives the generator the template and the matched parameters', async () => {
        await boot(echoing);
        await fetch(`${base}/users/12324?verbose=true`);
        expect(lastInput).toMatchObject({
            path: '/users/{user_id}',
            pathParams: { user_id: '12324' },
            query: { verbose: 'true' },
            operationId: 'getUserById',
        });
    });

    it('seeds the same request the same way when a base seed is set', async () => {
        await boot(echoing);
        await fetch(`${base}/users/12324`);
        const first = lastInput?.seed;
        await fetch(`${base}/users/12324`);
        expect(lastInput?.seed).toBe(first);
        await fetch(`${base}/users/999`);
        expect(lastInput?.seed).not.toBe(first);
    });

    it('refuses a body larger than the cap', async () => {
        await boot(echoing);
        const res = await fetch(`${base}/users`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ user_id: 1, email: 'a@b.com', nickname: 'x'.repeat(2_000_000) }),
        });
        expect(res.status).toBe(413);
    });

    it('lists what it serves', async () => {
        await boot(echoing);
        const routes = (await (await fetch(`${base}/__faker/routes`)).json()) as unknown[];
        expect(routes).toHaveLength(4);
    });
});

// ---------------------------------------------------------------------------
// The backstop
//
// A generator written before the pagination rule existed is still on somebody's
// disk, and a cache is not rebuilt because a rule changed. This is the only
// thing here that edits what a generator produced, so it is deliberately the
// smallest edit that ends the loop.
// ---------------------------------------------------------------------------

describe('a looping page token', () => {
    let root: string;
    let live: Listening;
    let base: string;
    let log: string[];

    /**
     * The generator is put on disk rather than built, because that is the whole
     * scenario: it was written before the pagination rule existed, and the walk
     * in the build loop would refuse to write it today.
     */
    const boot = async (answer: (input: Record<string, unknown>) => unknown): Promise<void> => {
        const box = new Box({ root, image: 'stub', exec: engineThat(answer, root) });
        const checks = new Checks();
        const operations = await loadSpec(join(here, 'specs', 'paged.yaml'));
        for (const operation of operations) {
            await box.write(operation.key, '# written before the rule existed');
        }
        live = await listen(
            {
                router: new Router(operations),
                checks,
                box,
                cache: new Cache({ box, checks, model }),
                onRequest: (line) => log.push(line),
            },
            '127.0.0.1',
            0,
        );
        base = `http://127.0.0.1:${live.port}`;
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'faker-'));
        log = [];
    });

    afterEach(async () => {
        await live?.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('is cut back to the last page, and narrated', async () => {
        await boot(() => ({ results: [], cursor: '8fde793b', has_more: true }));
        const res = await fetch(`${base}/machines?cursor=8fde793b`);
        expect(await res.json()).toEqual({ results: [], cursor: null, has_more: false });
        expect(log.at(-1)).toContain('cut a looping page token');
    });

    it('is left alone when it advanced', async () => {
        await boot(() => ({ results: [], cursor: 'page-2', has_more: true }));
        const res = await fetch(`${base}/machines?cursor=page-1`);
        expect(await res.json()).toMatchObject({ cursor: 'page-2' });
        expect(log.at(-1)).not.toContain('cut');
    });

    // The document never declared `cursor`, so only the request itself says
    // this is a page turn at all.
    it('is cut even where the document never declared the parameter', async () => {
        await boot(() => ({ results: [], cursor: 'eyJwIjoyfQ==' }));
        const res = await fetch(`${base}/alarms?cursor=${encodeURIComponent('eyJwIjoyfQ==')}`);
        expect(await res.json()).toEqual({ results: [], cursor: null });
        expect(log.at(-1)).toContain('cut a looping page token');
    });

    // Nothing revalidates a generator's output on the way out, so a required,
    // non-nullable token stays where it is: a hang is better than a lie.
    it('is left alone when the schema leaves no room', async () => {
        await boot(() => ({ data: [], next_offset: 40 }));
        const res = await fetch(`${base}/events?offset=40`);
        expect(await res.json()).toMatchObject({ next_offset: 40 });
        expect(log.at(-1)).not.toContain('cut');
    });
});
