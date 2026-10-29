import { cacheItems } from '@zenera/cli/lib';
import type { Model } from '@zenera/neo';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GYM_KIND } from '../src/cache.ts';
import { build, BuildFailed, reason, unfence, type BuildOptions } from '../src/generate.ts';
import {
    call,
    GET_USER,
    GET_USER_CONSTANT,
    GET_USER_NO_EMAIL,
    op,
    rig,
    say,
    scripted,
    writes,
    type Rig,
} from './helpers.ts';

const options = (r: Rig, model: Model, attempts = 3): BuildOptions => ({
    model,
    box: r.box,
    checks: r.checks,
    catalog: r.catalog,
    world: r.world,
    operations: r.operations,
    sourceOf: (o) => r.cache.getSource(o.key),
    attempts,
});

describe('the handler agent', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    it('keeps the first handler the judge passes', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        const built = await build(op(r, 'getUserById'), options(r, model));
        expect(built).toMatchObject({ source: GET_USER.trim(), attempts: 1 });
        // A pass ends the run: nobody waits on a closing remark.
        expect(model.builder).toHaveLength(1);
    });

    it('is briefed in TypeScript, with the world and the siblings', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        await build(op(r, 'getUserById'), options(r, model));
        const brief = model.builder[0]!.brief;
        expect(brief).toContain('OPERATION  GET /users/{user_id}');
        expect(brief).toContain('export interface User');
        expect(brief).toContain('RELATED OPERATIONS');
        expect(brief).toContain('createUser');
        expect(brief).toContain('THE WORLD SO FAR');
    });

    it('hands every problem back, and a fix is tested again', async () => {
        const model = scripted({ builder: writes(GET_USER_NO_EMAIL, GET_USER) });
        r = await rig('petstore.yaml', model);
        const built = await build(op(r, 'getUserById'), options(r, model));
        expect(built.attempts).toBe(2);
        const verdict = model.builder[1]!.results.at(-1)!.content;
        expect(verdict).toContain('"ok":false');
        expect(verdict).toContain('email');
    });

    // The rule schema validation cannot see: a body can be perfectly shaped
    // and still be about somebody else.
    it('rejects a handler that ignores the request and answers about someone else', async () => {
        const model = scripted({ builder: writes(GET_USER_CONSTANT, GET_USER_CONSTANT) });
        r = await rig('petstore.yaml', model);
        const failed = await build(op(r, 'getUserById'), options(r, model, 2)).catch(
            (e: unknown) => e,
        );
        expect(failed).toBeInstanceOf(BuildFailed);
        expect((failed as BuildFailed).diagnostics.join('\n')).toContain('echo the path parameter');
    });

    it('gives up after the attempt limit rather than looping', async () => {
        const broken = 'export default () => { throw new Error("boom"); };';
        const model = scripted({ builder: writes(broken, broken, broken, broken) });
        r = await rig('petstore.yaml', model);
        const failed = await build(op(r, 'getUserById'), options(r, model, 2)).catch(
            (e: unknown) => e,
        );
        expect(failed).toBeInstanceOf(BuildFailed);
        expect((failed as BuildFailed).diagnostics.join('\n')).toContain('boom');
        const tests = model.builder
            .flatMap((t) => t.req.messages)
            .filter((m) => m.role === 'assistant' && JSON.stringify(m).includes('test_handler'));
        expect(tests.length).toBeLessThanOrEqual(2);
    });

    it('starts again when the agent stops without passing', async () => {
        let runs = 0;
        const model = scripted({
            builder: (turn) => {
                if (turn.call === 1) {
                    runs++;
                }
                return runs === 1
                    ? say('I think it is fine.')
                    : call('test_handler', { source: GET_USER });
            },
        });
        r = await rig('petstore.yaml', model);
        await expect(build(op(r, 'getUserById'), options(r, model))).resolves.toMatchObject({
            source: GET_USER.trim(),
        });
        expect(model.builder.at(-1)!.brief).toContain('has not passed test_handler');
    });

    // Judging writes content into a copy: probe traffic must not become part
    // of the world real requests see.
    it('judges in a copy of the world', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        await build(op(r, 'getUserById'), options(r, model));
        expect(r.store.collections()).toEqual([]);
    });

    it('can read the handlers its siblings already have', async () => {
        const model = scripted({
            builder: (turn) =>
                turn.call === 1
                    ? call('read_handler', { operationId: 'getUserById' })
                    : call('test_handler', { source: GET_USER }),
        });
        r = await rig('petstore.yaml', model);
        vi.spyOn(r.cache, 'getSource').mockResolvedValue(GET_USER);
        await build(op(r, 'getSelf'), options(r, model)).catch(() => undefined);
        expect(model.builder[1]!.results[0]!.content).toContain("ctx.lookup('users'");
    });

    it('rejects pages that answer with the token they were given', async () => {
        const looping = `export default () => ({ results: [], cursor: 'same', has_more: true });`;
        const model = scripted({ builder: writes(looping, looping) });
        r = await rig('paged.yaml', model);
        const failed = await build(op(r, 'listMachines'), options(r, model, 1)).catch(
            (e: unknown) => e,
        );
        expect((failed as BuildFailed).diagnostics.join('\n')).toMatch(
            /the token the request sent|never run out|cycle/,
        );
    });

    it('accepts pages made with ctx.page', async () => {
        const paged = `
export default async function handle(req: any, ctx: any) {
    const all = await ctx.ensure('machines', { type: 'Machine', min: 5, count: 5 });
    const p = ctx.page(all, { token: req.query.cursor, size: req.query.page_size });
    return { results: p.items, cursor: p.nextToken, has_more: p.hasMore };
}`;
        const model = scripted({ builder: writes(paged) });
        r = await rig('paged.yaml', model);
        await expect(build(op(r, 'listMachines'), options(r, model))).resolves.toMatchObject({
            attempts: 1,
        });
    });
});

describe('the cache', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    it('builds once for however many callers arrive at the same time', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        const all = await Promise.all(
            Array.from({ length: 10 }, () => r!.cache.ensure(op(r!, 'getUserById'))),
        );
        expect(model.builder).toHaveLength(1);
        expect(new Set(all.map((g) => g.source)).size).toBe(1);
    });

    it('reads what is cached on a later start instead of asking again', async () => {
        const first = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', first);
        await r.cache.ensure(op(r, 'getUserById'));

        const second = scripted({});
        const again = await rig('petstore.yaml', second, {
            root: r.root,
            cacheDir: join(r.root, 'store'),
        });
        try {
            const got = await again.cache.ensure(op(again, 'getUserById'));
            expect(got.cached).toBe(true);
            expect(second.builder).toHaveLength(0);
            // A hit is copied back into the box, which runs only what is on its disk.
            expect(readFileSync(again.box.sourceOf(got.key), 'utf8')).toContain(
                "ctx.lookup('users'",
            );
        } finally {
            await again.box.dispose();
        }
    });

    it('records what wrote it', async () => {
        const model = scripted({ builder: writes(GET_USER) });
        r = await rig('petstore.yaml', model);
        await r.cache.ensure(op(r, 'getUserById'));
        const { rows } = cacheItems(GYM_KIND, { dir: join(r.root, 'store') });
        const meta = (rows[0]!.value as { meta: Record<string, unknown> }).meta;
        expect(meta).toMatchObject({
            model: 'scripted',
            operationId: 'getUserById',
            rulesVersion: 3,
        });
    });

    it('does not re-ask a model that already gave up', async () => {
        const broken = 'export default () => { throw new Error("boom"); };';
        const model = scripted({ builder: writes(broken, broken, broken) });
        r = await rig('petstore.yaml', model, { attempts: 1 });
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toBeInstanceOf(BuildFailed);
        const asked = model.builder.length;
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toBeInstanceOf(BuildFailed);
        expect(model.builder).toHaveLength(asked);
    });

    it('writes one report per failed build, source and all', async () => {
        const broken = 'export default () => { throw new Error("boom"); };';
        const model = scripted({ builder: writes(broken, broken) });
        let failure: { error: Error; dump?: string } | undefined;
        r = await rig('petstore.yaml', model, {
            attempts: 2,
            onFail: (e) => {
                failure = e;
            },
        });
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toBeInstanceOf(BuildFailed);
        const report = readFileSync(failure!.dump!, 'utf8');
        expect(report).toContain('getUserById');
        expect(report).toContain('gave up after 2 of 2');
        expect(report).toContain('## Attempt 2 of 2');
        expect(report).toContain('```ts');
        expect(report).toContain('boom');
    });

    // A rate limit is about this minute, not about this operation.
    it('forgets a transient failure and tries again on the next request', async () => {
        let calls = 0;
        const model = scripted({
            builder: (turn) => {
                calls++;
                if (calls === 1) {
                    throw Object.assign(new Error('429 rate limited'), { status: 429 });
                }
                return writes(GET_USER)(turn);
            },
        });
        r = await rig('petstore.yaml', model);
        await expect(r.cache.ensure(op(r, 'getUserById'))).rejects.toThrow(/rate limited/);
        await expect(r.cache.ensure(op(r, 'getUserById'))).resolves.toMatchObject({
            cached: false,
        });
    });

    it('writes no more than `concurrency` handlers at once', async () => {
        let inFlight = 0;
        let peak = 0;
        const model = scripted({
            builder: async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((res) => setTimeout(res, 5));
                inFlight--;
                return say('giving up');
            },
        });
        r = await rig('petstore.yaml', model, { concurrency: 2, attempts: 1 });
        await Promise.allSettled(r.operations.map((o) => r!.cache.ensure(o)));
        expect(peak).toBeLessThanOrEqual(2);
    });
});

describe('unfencing an answer', () => {
    it('leaves a bare module alone', () => {
        expect(unfence('export default () => 1;\n')).toBe('export default () => 1;');
    });

    it('strips a fence the model added anyway', () => {
        expect(unfence('```ts\nexport default () => 1;\n```')).toBe('export default () => 1;');
    });
});

describe('reporting why something failed', () => {
    it('unwraps the cause chain, which is where the real reason hides', () => {
        const inner = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), {
            code: 'ETIMEDOUT',
        });
        expect(reason(new Error('fetch failed', { cause: inner }))).toBe(
            'fetch failed — ETIMEDOUT connect ETIMEDOUT 1.2.3.4:443',
        );
    });

    it('names the status a provider answered with', () => {
        expect(reason(Object.assign(new Error('Rate limit reached'), { status: 429 }))).toBe(
            '429 Rate limit reached',
        );
    });

    it('survives a cause that points back at itself', () => {
        const loop = new Error('round');
        (loop as Error & { cause?: unknown }).cause = loop;
        expect(reason(loop)).toBe('round');
    });
});
