import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModel, runProcess } from '@zenera/neo';
import { Box } from '../src/box.ts';
import { Cache } from '../src/cache.ts';
import { ensureImage } from '../src/image.ts';
import { loadSpec, type Operation } from '../src/spec.ts';
import { Checks } from '../src/validate.ts';

// ---------------------------------------------------------------------------
// The only test that starts a real container and spends a token.
//
// It is here because everything below it is stubbed, and a stub cannot tell you
// that the image actually has `faker` in it, that `podman exec` finds the file
// where the mount says it is, or that a model handed this prompt writes Python
// that runs. Self-skips without podman or a key; excluded by `--exclude
// '**/live-*'` like every other live test in this repo.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.ZENERA_FAKER_MODEL ?? 'vertex:gemini-3.5-flash';

const hasKey = (): boolean =>
    Boolean(
        process.env.OPENAI_API_KEY ??
        process.env.GEMINI_API_KEY ??
        process.env.ANTHROPIC_API_KEY ??
        process.env.GOOGLE_APPLICATION_CREDENTIALS ??
        process.env.OPENROUTER_API_KEY,
    );

async function hasPodman(): Promise<boolean> {
    return runProcess('podman', ['info'], { timeoutMs: 30_000 })
        .then((r) => r.code === 0)
        .catch(() => false);
}

const enabled = hasKey() && (await hasPodman());

describe.runIf(enabled)('a generator, for real', () => {
    let root: string;
    let box: Box;
    let cache: Cache;
    let operation: Operation;

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'faker-live-'));
        const image = await ensureImage({ root });
        box = new Box({ root, image, timeout: 60 });
        const checks = new Checks();
        cache = new Cache({ box, checks, model: createModel(MODEL), attempts: 3 });
        operation = (await loadSpec(join(here, 'specs', 'petstore.yaml'))).find(
            (o) => o.operationId === 'getUserById',
        )!;
    }, 900_000);

    afterAll(async () => {
        await box?.dispose();
        rmSync(root, { recursive: true, force: true });
    });

    it('has the libraries the prompt promises', async () => {
        const res = await box.sandbox.exec(
            'python3 -c "import faker, exrex, jsonschema, dateutil; print(\'ok\')"',
        );
        expect(res.stdout.trim()).toBe('ok');
        expect(res.exit_code).toBe(0);
    }, 180_000);

    it('cannot reach the network', async () => {
        const res = await box.sandbox.exec(
            'python3 -c "import socket; socket.create_connection((\'1.1.1.1\', 80), 3)" 2>&1; echo rc=$?',
        );
        expect(res.stdout).toContain('rc=1');
    }, 120_000);

    it('writes one that echoes the id it was asked about', async () => {
        await cache.ensure(operation);

        const outcome = await box.run(operation.key, {
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            pathParams: { user_id: '12324' },
            query: {},
            headers: {},
            body: undefined,
            seed: 99,
        });

        expect(outcome.ok, outcome.stderr).toBe(true);
        const body = outcome.value as Record<string, unknown>;
        expect(body.user_id).toBe(12324);
        expect(String(body.email)).toContain('@');
    }, 600_000);

    it('answers the same seed the same way', async () => {
        const input = {
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            pathParams: { user_id: '7' },
            query: {},
            headers: {},
            body: undefined,
            seed: 4242,
        };
        const first = await box.run(operation.key, input);
        const second = await box.run(operation.key, input);
        expect(second.value).toEqual(first.value);
    }, 180_000);
});
