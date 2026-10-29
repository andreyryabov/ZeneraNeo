import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GeneratorInput } from '../src/envelope.ts';
import { populatedKey } from '../src/runtime.ts';
import { openStory } from '../src/story.ts';
import { call, idsAsked, rig, say, scripted, type Rig, type Script } from './helpers.ts';

const request: GeneratorInput = {
    operationId: 'getUserById',
    method: 'get',
    path: '/users/{user_id}',
    pathParams: { user_id: '7' },
    query: {},
    headers: {},
    body: undefined,
    seed: 3,
};

describe('the story', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'gym-story-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('quotes a short story whole', async () => {
        writeFileSync(join(dir, 'world.md'), '# Acme\n\nAda Lovelace runs ops.\n');
        const story = await openStory('world.md', dir);
        expect(story.brief).toContain('Ada Lovelace runs ops.');
        expect(story.tools.map((t) => t.name)).toEqual(['list_docs', 'grep_docs', 'read_docs']);
    });

    it('lists a long one, and reads it with tools', async () => {
        mkdirSync(join(dir, 'lore'));
        const long = `# People\n\n${'Grace Hopper writes compilers.\n'.repeat(800)}`;
        writeFileSync(join(dir, 'lore', 'people.md'), long);
        writeFileSync(join(dir, 'lore', 'places.md'), '# Places\n\nThe lab is in Zurich.\n');
        const story = await openStory('lore', dir);
        expect(story.brief).not.toContain('Grace Hopper writes compilers.');
        expect(story.brief).toContain('people.md');
        const grep = story.tools.find((t) => t.name === 'grep_docs')!;
        const found = (await grep.execute({ pattern: 'Zurich' }, {} as never)) as {
            found: number;
            lines: { file: string }[];
        };
        expect(found.found).toBe(1);
        expect(found.lines[0]!.file).toBe('places.md');
    });

    // Two processes handed the same story must land in the same world.
    it('is named by what it says, not where it is', async () => {
        writeFileSync(join(dir, 'a.md'), '# Same\n');
        mkdirSync(join(dir, 'copy'));
        writeFileSync(join(dir, 'copy', 'a.md'), '# Same\n');
        writeFileSync(join(dir, 'b.md'), '# Different\n');
        const [a, copy, b] = await Promise.all([
            openStory('a.md', dir),
            openStory('copy/a.md', dir),
            openStory('b.md', dir),
        ]);
        expect(a.digest).toBe(copy.digest);
        expect(a.digest).not.toBe(b.digest);
    });
});

describe('the world agent', () => {
    let r: Rig | undefined;
    afterEach(async () => {
        await r?.close();
        r = undefined;
    });

    const synth = (rr: Rig, req: Parameters<Rig['world']['synthesize']>[0], probe = false) =>
        rr.world.synthesize(req, { db: rr.store.path, probe, input: request });

    it('writes the records asked for, validated against the type, and keeps them', async () => {
        const world: Script = (turn) =>
            turn.results.length > 0
                ? say('done')
                : call('save_records', {
                      records: idsAsked(turn.brief).map((id) => ({
                          user_id: Number(id),
                          email: `u${id}@acme.io`,
                      })),
                  });
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        const made = await synth(r, {
            collection: 'users',
            type: 'User',
            idField: 'user_id',
            ids: ['7'],
        });
        expect(made).toEqual([{ user_id: 7, email: 'u7@acme.io' }]);
        expect(r.store.collection('users').get('7')).toEqual({ user_id: 7, email: 'u7@acme.io' });
        expect(model.world[0]!.brief).toContain('export interface User');
    });

    it('hands invalid records back with what is wrong, and saves the fixed ones', async () => {
        const world: Script = (turn) => {
            const saves = turn.results.filter((x) => x.name === 'save_records').length;
            if (saves === 0) {
                return call('save_records', { records: [{ user_id: 7, email: 'not-an-email' }] });
            }
            if (saves === 1) {
                return call('save_records', { records: [{ user_id: 7, email: 'u7@acme.io' }] });
            }
            return say('done');
        };
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        await synth(r, { collection: 'users', type: 'User', idField: 'user_id', ids: ['7'] });
        const first = model.world[1]!.results[0]!.content;
        expect(first).toContain('"saved":0');
        expect(first).toContain('/email');
        expect(r.store.collection('users').get('7')).toMatchObject({ email: 'u7@acme.io' });
    });

    it('is briefed with the story and with what the world already holds', async () => {
        const world: Script = () => say('nothing to do');
        const model = scripted({ world });
        r = await rig('petstore.yaml', model, {
            story: {
                digest: 'x',
                brief: 'THE STORY: everyone works at Acme.',
                tools: [],
                close: () => {},
            },
        });
        r.store.collection('accounts').put('@me', { id: '@me', email: 'a@acme.io' });
        await synth(r, { collection: 'users', type: 'User', idField: 'user_id', count: 2 });
        expect(model.world[0]!.req.system).toContain('THE STORY: everyone works at Acme.');
        expect(model.world[0]!.brief).toContain('accounts: 1 records');
    });

    // A failed agent costs realism, not the request.
    it('stands sampled records in for what the agent did not deliver', async () => {
        const model = scripted({ world: () => say('I would rather not.') });
        r = await rig('petstore.yaml', model);
        const made = await synth(r, {
            collection: 'users',
            type: 'User',
            idField: 'user_id',
            ids: ['12'],
        });
        expect(made).toHaveLength(1);
        expect(made[0]!.user_id).toBe(12);
        expect(r.store.collection('users').has('12')).toBe(true);
    });

    it('answers a judgement from the schema, without an agent', async () => {
        const model = scripted({});
        r = await rig('petstore.yaml', model);
        const made = await synth(
            r,
            { collection: 'users', type: 'User', idField: 'user_id', count: 3 },
            true,
        );
        expect(made).toHaveLength(3);
        expect(model.world).toHaveLength(0);
        expect(r.catalog.validator('User')!(made[0])).toBe(true);
        expect(r.store.getMeta(populatedKey('users'))).toBe(true);
    });

    // Two requests that both found the inbox empty must not both fill it.
    it('makes a collection once for requests that arrive together', async () => {
        const world: Script = async (turn) => {
            await new Promise((res) => setTimeout(res, 20));
            return turn.results.length > 0
                ? say('done')
                : call('save_records', {
                      records: [1, 2].map((n) => ({ user_id: n, email: `u${n}@acme.io` })),
                  });
        };
        const model = scripted({ world });
        r = await rig('petstore.yaml', model);
        const ask = () =>
            synth(r!, {
                collection: 'users',
                type: 'User',
                idField: 'user_id',
                count: 2,
                min: 2,
                populate: true,
            });
        await Promise.all([ask(), ask(), ask()]);
        expect(model.world.filter((t) => t.call === 1)).toHaveLength(1);
        expect(r.store.collection('users').count()).toBe(2);
    });
});
