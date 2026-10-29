import { createModel } from '@zenera/neo';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStory } from '../src/story.ts';
import { op, rig, type Rig } from './helpers.ts';

// ---------------------------------------------------------------------------
// The only test that spends tokens.
//
// Everything else is scripted, and a script cannot tell you that a real model
// handed these prompts writes a handler that passes the judge, or that the
// world agent actually reads the story. Self-skips without a key; excluded by
// `--exclude '**/live-*'` like every other live test in this repo.
// ---------------------------------------------------------------------------

const MODEL =
    process.env.ZENERA_GYM_MODEL ??
    (process.env.OPENAI_API_KEY
        ? 'openai/responses:gpt-5.6-sol'
        : process.env.ANTHROPIC_API_KEY
          ? 'anthropic:claude-opus-5'
          : undefined);

describe.runIf(Boolean(MODEL))('a handler and a world, for real', () => {
    let r: Rig;
    let dir: string;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'gym-live-'));
        writeFileSync(
            join(dir, 'story.md'),
            [
                '# Orbital Bakery',
                '',
                'Every user of this API works at Orbital Bakery, and every email address',
                'is at the domain orbital-bakery.test. The owner of the account is',
                'Margit Kovacs, margit@orbital-bakery.test.',
            ].join('\n'),
        );
        r = await rig('petstore.yaml', createModel(MODEL!), {
            story: await openStory('story.md', dir),
            attempts: 4,
        });
    }, 60_000);

    afterAll(async () => {
        await r?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes a handler that passes the judge, and answers from the story', async () => {
        const operation = op(r, 'getUserById');
        await r.cache.ensure(operation);
        const outcome = await r.box.run(operation.key, {
            operationId: operation.operationId,
            method: operation.method,
            path: operation.path,
            pathParams: { user_id: '12324' },
            query: {},
            headers: {},
            body: undefined,
            seed: 99,
        });
        expect(outcome.ok, outcome.fault).toBe(true);
        const body = outcome.value as { user_id: number; email: string };
        expect(body.user_id).toBe(12324);
        expect(body.email).toMatch(/@orbital-bakery\.test$/);
    }, 600_000);
});
