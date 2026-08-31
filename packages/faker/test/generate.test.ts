import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_MOUNT, type Model, type ProcResult, type Runner } from '@zenera/neo';
import { Box } from '../src/box.ts';
import { Cache } from '../src/cache.ts';
import { build, BuildFailed, reason, unfence } from '../src/generate.ts';
import { loadSpec, type Operation } from '../src/spec.ts';
import { Checks } from '../src/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Stubs
//
// Neither podman nor a model is started. The seam for the first is
// `SandboxOptions.exec`, the same one `packages/neo/test/sandbox.test.ts` uses;
// the seam for the second is that `Model` is an interface with one method.
// ---------------------------------------------------------------------------

const ok = (stdout = ''): ProcResult => ({
    code: 0,
    stdout,
    stderr: '',
    truncated: false,
    timedOut: false,
});

/** What a generator "does" on a given attempt. */
type Behaviour = (input: Record<string, unknown>, attempt: number) => unknown | Crash;

interface Crash {
    crash: string;
}

const isCrash = (v: unknown): v is Crash =>
    typeof v === 'object' && v !== null && 'crash' in (v as Crash);

/**
 * Stands in for the container. The script the box builds names two paths under
 * the mount, and the mount *is* the root directory — so translating one to the
 * other is the whole of the emulation.
 */
function fakeEngine(root: string, behave: Behaviour): { exec: Runner; runs: number } {
    const state = { runs: 0 };
    const exec: Runner = (_bin, args, opts) => {
        if (args[0] === 'container' || args[0] === 'run' || args[0] === 'start') {
            return Promise.resolve(ok('running'));
        }
        const script = opts?.input ?? '';
        const [, inPath, outPath] = script.split(/\s+/).slice(-3);
        const host = (p: string): string => join(root, p.slice(SANDBOX_MOUNT.length + 1));

        state.runs += 1;
        const input = JSON.parse(readFileSync(host(inPath), 'utf8')) as Record<string, unknown>;
        const answer = behave(input, state.runs);
        if (isCrash(answer)) {
            return Promise.resolve({ ...ok(), code: 1, stderr: answer.crash });
        }
        writeFileSync(host(outPath), JSON.stringify(answer));
        return Promise.resolve(ok());
    };
    return {
        exec,
        get runs() {
            return state.runs;
        },
    };
}

function fakeModel(answers: readonly string[]): Model & { seen: string[] } {
    const seen: string[] = [];
    let at = 0;
    return {
        id: 'stub',
        seen,
        generate: (req) => {
            const last = req.messages.at(-1);
            seen.push(
                typeof last?.content === 'string'
                    ? last.content
                    : JSON.stringify(last?.content ?? ''),
            );
            return Promise.resolve({
                text: answers[Math.min(at++, answers.length - 1)],
                toolCalls: [],
            });
        },
    };
}

// ---------------------------------------------------------------------------

describe('the build loop', () => {
    let root: string;
    let operation: Operation;
    let checks: Checks;

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'faker-'));
        const ops = await loadSpec(join(here, 'specs', 'petstore.yaml'));
        operation = ops.find((o) => o.operationId === 'getUserById')!;
        checks = new Checks();
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const boxWith = (behave: Behaviour) => {
        const engine = fakeEngine(root, behave);
        return { box: new Box({ root, image: 'stub', exec: engine.exec }), engine };
    };

    it('accepts a generator whose output validates and echoes the request', async () => {
        const { box } = boxWith((input) => ({
            user_id: Number((input.pathParams as Record<string, unknown>).user_id),
            email: 'a@b.com',
        }));
        const model = fakeModel(['# fine']);

        const built = await build(operation, { model, box, checks });
        expect(built.attempts).toBe(1);
        expect(model.seen).toHaveLength(1);
    });

    it('rejects output that does not match the response schema, and says why', async () => {
        // `email` is required; the first answer forgets it.
        const { box } = boxWith((input, attempt) =>
            attempt <= 2
                ? { user_id: Number((input.pathParams as Record<string, unknown>).user_id) }
                : {
                      user_id: Number((input.pathParams as Record<string, unknown>).user_id),
                      email: 'a@b.com',
                  },
        );
        const model = fakeModel(['# first', '# second']);

        const built = await build(operation, { model, box, checks });
        expect(built.attempts).toBe(2);
        expect(model.seen[1]).toContain('email');
    });

    // The rule schema validation cannot see: a body can be perfectly shaped
    // and still be about somebody else.
    it('rejects a generator that ignores the request and invents an id', async () => {
        const { box } = boxWith(() => ({ user_id: 999, email: 'a@b.com' }));
        const model = fakeModel(['# constant']);

        await expect(build(operation, { model, box, checks, attempts: 2 })).rejects.toBeInstanceOf(
            BuildFailed,
        );
        expect(model.seen[1]).toContain('echo the path parameter');
    });

    it('feeds stderr back when the file will not run', async () => {
        const { box } = boxWith(() => ({ crash: 'NameError: fakerr is not defined' }));
        const model = fakeModel(['# broken']);

        await expect(build(operation, { model, box, checks, attempts: 2 })).rejects.toThrow(
            /could not write a generator/,
        );
        expect(model.seen[1]).toContain('NameError');
    });

    it('gives up after the attempt limit rather than looping', async () => {
        const { box } = boxWith(() => ({ crash: 'boom' }));
        const model = fakeModel(['# broken']);

        await expect(build(operation, { model, box, checks, attempts: 3 })).rejects.toBeInstanceOf(
            BuildFailed,
        );
        expect(model.seen).toHaveLength(3);
    });

    it('varies the probes, so a generator cannot pass by hard-coding one id', async () => {
        const seen: unknown[] = [];
        const { box } = boxWith((input) => {
            seen.push((input.pathParams as Record<string, unknown>).user_id);
            return {
                user_id: Number((input.pathParams as Record<string, unknown>).user_id),
                email: 'a@b.com',
            };
        });
        await build(operation, { model: fakeModel(['# fine']), box, checks });
        expect(new Set(seen).size).toBeGreaterThan(1);
    });

    // Not for progress — nothing renders the deltas. A non-streaming call sends
    // nothing for a minute while the model thinks and the connection gets
    // closed upstream.
    it('streams when the adapter can, and falls back when it cannot', async () => {
        const { box } = boxWith((input) => ({
            user_id: Number((input.pathParams as Record<string, unknown>).user_id),
            email: 'a@b.com',
        }));
        const plain = fakeModel(['# fine']);
        const streaming: Model = {
            id: 'streamer',
            generate: () => Promise.reject(new Error('should have streamed')),
            stream: () => Promise.resolve({ text: '# fine', toolCalls: [] }),
        };

        await expect(build(operation, { model: streaming, box, checks })).resolves.toMatchObject({
            attempts: 1,
        });
        await expect(build(operation, { model: plain, box, checks })).resolves.toMatchObject({
            attempts: 1,
        });
    });
});

describe('the cache', () => {
    let root: string;
    let operation: Operation;

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'faker-'));
        const ops = await loadSpec(join(here, 'specs', 'petstore.yaml'));
        operation = ops.find((o) => o.operationId === 'getUserById')!;
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const good: Behaviour = (input) => ({
        user_id: Number((input.pathParams as Record<string, unknown>).user_id ?? 1),
        email: 'a@b.com',
    });

    it('builds once for however many callers arrive at the same time', async () => {
        const engine = fakeEngine(root, good);
        const box = new Box({ root, image: 'stub', exec: engine.exec });
        const model = fakeModel(['# fine']);
        const generate = vi.spyOn(model, 'generate');
        const cache = new Cache({ box, checks: new Checks(), model });

        const all = await Promise.all(Array.from({ length: 10 }, () => cache.ensure(operation)));
        expect(generate).toHaveBeenCalledTimes(1);
        expect(new Set(all.map((g) => g.source)).size).toBe(1);
    });

    it('reads the file back on a later start instead of asking again', async () => {
        const engine = fakeEngine(root, good);
        const first = new Cache({
            box: new Box({ root, image: 'stub', exec: engine.exec }),
            checks: new Checks(),
            model: fakeModel(['# fine']),
        });
        await first.ensure(operation);

        const model = fakeModel(['# should not be asked']);
        const generate = vi.spyOn(model, 'generate');
        const second = new Cache({
            box: new Box({ root, image: 'stub', exec: engine.exec }),
            checks: new Checks(),
            model,
        });

        const got = await second.ensure(operation);
        expect(got.cached).toBe(true);
        expect(generate).not.toHaveBeenCalled();
    });

    it('records what wrote it', async () => {
        const engine = fakeEngine(root, good);
        const box = new Box({ root, image: 'stub', exec: engine.exec });
        await new Cache({ box, checks: new Checks(), model: fakeModel(['# fine']) }).ensure(
            operation,
        );

        const meta = JSON.parse(
            readFileSync(join(root, 'generators', operation.key, 'meta.json'), 'utf8'),
        );
        expect(meta.model).toBe('stub');
        expect(meta.operationId).toBe('getUserById');
    });

    it('does not re-ask a model that already gave up', async () => {
        const engine = fakeEngine(root, () => ({ crash: 'boom' }));
        const box = new Box({ root, image: 'stub', exec: engine.exec });
        const model = fakeModel(['# broken']);
        const generate = vi.spyOn(model, 'generate');
        const cache = new Cache({ box, checks: new Checks(), model, attempts: 1 });

        await expect(cache.ensure(operation)).rejects.toBeInstanceOf(BuildFailed);
        await expect(cache.ensure(operation)).rejects.toBeInstanceOf(BuildFailed);
        expect(generate).toHaveBeenCalledTimes(1);
    });

    // A rate limit is about this minute, not about this operation. Remembering
    // it would leave the route permanently 500 until the process restarts.
    it('forgets a transient failure and tries again on the next request', async () => {
        const engine = fakeEngine(root, good);
        const box = new Box({ root, image: 'stub', exec: engine.exec });
        let calls = 0;
        const model: Model = {
            id: 'flaky',
            generate: () => {
                calls += 1;
                return calls === 1
                    ? Promise.reject(Object.assign(new Error('429 rate limited'), { status: 429 }))
                    : Promise.resolve({ text: '# fine', toolCalls: [] });
            },
        };
        const cache = new Cache({ box, checks: new Checks(), model });

        await expect(cache.ensure(operation)).rejects.toThrow(/rate limited/);
        await expect(cache.ensure(operation)).resolves.toMatchObject({ cached: false });
        expect(calls).toBe(2);
    });

    it('writes no more than `concurrency` generators at once', async () => {
        const engine = fakeEngine(root, good);
        const box = new Box({ root, image: 'stub', exec: engine.exec });
        let inFlight = 0;
        let peak = 0;
        const model: Model = {
            id: 'slow',
            generate: async () => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight -= 1;
                return { text: '# fine', toolCalls: [] };
            },
        };
        const cache = new Cache({ box, checks: new Checks(), model, concurrency: 2 });

        const many = await loadSpec(join(here, 'specs', 'petstore.yaml'));
        await Promise.all(many.filter((o) => o.success.schema).map((o) => cache.ensure(o)));
        expect(peak).toBeLessThanOrEqual(2);
    });
});

describe('unfencing an answer', () => {
    it('leaves a bare file alone', () => {
        expect(unfence('import sys\n')).toBe('import sys');
    });

    it('strips a fence the model added anyway', () => {
        expect(unfence('```python\nimport sys\n```')).toBe('import sys');
    });
});

describe('reporting why something failed', () => {
    // `fetch failed` is undici's word for a dozen different problems and the
    // only place the real one appears is `cause`.
    it('unwraps the cause chain, which is where the real reason hides', () => {
        const inner = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), {
            code: 'ETIMEDOUT',
        });
        const outer = new Error('fetch failed', { cause: inner });
        expect(reason(outer)).toBe('fetch failed — ETIMEDOUT connect ETIMEDOUT 1.2.3.4:443');
    });

    it('names the status a provider answered with', () => {
        expect(reason(Object.assign(new Error('Rate limit reached'), { status: 429 }))).toBe(
            '429 Rate limit reached',
        );
    });

    it('carries the diagnostics when the model simply could not do it', async () => {
        const ops = await loadSpec(join(here, 'specs', 'petstore.yaml'));
        const failed = new BuildFailed(ops[0], ['- the file exited 1.']);
        expect(reason(failed)).toContain('the file exited 1.');
    });

    it('survives a cause that points back at itself', () => {
        const loop = new Error('round');
        (loop as Error & { cause?: unknown }).cause = loop;
        expect(reason(loop)).toBe('round');
    });
});
