import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileMemoryStore, createMemoryStore } from '../src/memory-stores/index.ts';
import { memoryOpId } from '../src/memory.ts';
import { InMemoryPayloadStore } from '../src/payload-stores/in-memory.ts';
import { FilePayloadStore, createPayloadStore } from '../src/payload-stores/index.ts';
import { PayloadResolver, exportRun, hash, importRun } from '../src/payload.ts';
import { FileSkillProvider, createSkillProvider } from '../src/skill-providers/index.ts';
import { tool } from '../src/types.ts';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zenera-stores-'));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('FilePayloadStore', () => {
    it('round-trips and dedupes by content address', async () => {
        const store = new FilePayloadStore({ dir, id: 'blobs' });
        const a = await store.put('hello');
        const b = await store.put('hello');
        expect(b).toEqual(a);
        expect(a.store).toBe('blobs');
        expect(a.sha256).toBe(hash('hello'));
        expect(await store.get(a)).toBe('hello');
    });

    it('resolves a batch in declared order', async () => {
        const store = new FilePayloadStore(dir);
        const refs = await Promise.all(['one', 'two', 'three'].map((v) => store.put(v)));
        expect(await store.getMany(refs)).toEqual(['one', 'two', 'three']);
    });

    it('survives a process restart', async () => {
        const p = await new FilePayloadStore(dir).put('durable');
        expect(await new FilePayloadStore(dir).get(p)).toBe('durable');
    });

    it('rejects an address that is not a content hash', async () => {
        const store = new FilePayloadStore(dir);
        await expect(
            store.get({ store: 'file', sha256: '../../etc/passwd', size: 0 }),
        ).rejects.toThrow(/invalid payload address/);
    });

    it('reports a missing blob instead of an fs error', async () => {
        const store = new FilePayloadStore({ dir, id: 'blobs' });
        await expect(
            store.get({ store: 'blobs', sha256: hash('absent'), size: 6 }),
        ).rejects.toThrow(/payload not found/);
    });

    it('builds from a ref', () => {
        expect(createPayloadStore(`file:${dir}`)).toBeInstanceOf(FilePayloadStore);
        expect(createPayloadStore('mem').id).toBe('mem');
    });

    it('receives an imported bundle', async () => {
        const source = new PayloadResolver(new InMemoryPayloadStore());
        const state = { note: await source.put('exported note') };
        const bundle = await exportRun(state, source);

        const target = new FilePayloadStore({ dir, id: 'restored' });
        const restored = await importRun<typeof state>(bundle, target);
        expect(restored.note.store).toBe('restored');
        expect(await target.get(restored.note)).toBe('exported note');
    });
});

describe('FileMemoryStore', () => {
    it('writes, searches and updates across instances', async () => {
        const store = new FileMemoryStore({ dir, id: 'user' });
        const rec = await store.write(
            'user:u1',
            { text: 'the user prefers trains over planes' },
            memoryOpId('run-1', 'call-1'),
        );
        expect(rec.revision).toBe(1);

        const reopened = new FileMemoryStore({ dir, id: 'user' });
        const hits = await reopened.search('user:u1', { text: 'trains' });
        expect(hits).toHaveLength(1);
        expect(hits[0].record.id).toBe(rec.id);

        const updated = await reopened.update(
            'user:u1',
            rec.id,
            { text: 'the user prefers trains', expectedRevision: 1 },
            memoryOpId('run-1', 'call-2'),
        );
        expect(updated.revision).toBe(2);
    });

    it('makes a replayed write idempotent', async () => {
        const store = new FileMemoryStore(dir);
        const opId = memoryOpId('run-1', 'call-1');
        const first = await store.write('s', { text: 'once' }, opId);
        const replay = await store.write('s', { text: 'once' }, opId);
        expect(replay.id).toBe(first.id);
        expect(await store.search('s', {})).toHaveLength(1);
    });

    it('rejects a stale revision', async () => {
        const store = new FileMemoryStore(dir);
        const rec = await store.write('s', { text: 'v1' }, memoryOpId('r', 'c1'));
        await expect(
            store.update('s', rec.id, { text: 'v2', expectedRevision: 7 }, memoryOpId('r', 'c2')),
        ).rejects.toThrow(/memory conflict/);
    });

    it('deletes and keeps scopes isolated', async () => {
        const store = new FileMemoryStore(dir);
        const a = await store.write('a', { text: 'in a' }, memoryOpId('r', 'c1'));
        await store.write('b', { text: 'in b' }, memoryOpId('r', 'c2'));
        expect(await store.search('a', {})).toHaveLength(1);
        await store.delete('a', a.id, memoryOpId('r', 'c3'));
        expect(await store.search('a', {})).toHaveLength(0);
        expect(await store.search('b', {})).toHaveLength(1);
    });

    it('refuses a record id that would escape the scope directory', async () => {
        const store = new FileMemoryStore(dir);
        await expect(store.get('s', '../../etc/passwd')).rejects.toThrow(/invalid record id/);
    });

    it('returns nothing for an unknown scope', async () => {
        expect(await createMemoryStore(`file:${dir}`).search('never:written', {})).toEqual([]);
    });
});

describe('FileSkillProvider', () => {
    const cheapHotels = tool<Record<string, never>>({
        name: 'cheap_hotels',
        description: 'lists cheap hotels',
        parameters: { type: 'object', properties: {} },
        execute: () => ['hostel one'],
    });

    beforeEach(async () => {
        await writeFile(
            join(dir, 'quick_note.md'),
            '# Quick note\n\nJust a body, no frontmatter.\n',
            'utf8',
        );
        await mkdir(join(dir, 'budget_travel'), { recursive: true });
        await writeFile(
            join(dir, 'budget_travel', 'SKILL.md'),
            [
                '---',
                'description: plan on a budget',
                'tags: [travel, money]',
                'version: 1.2.0',
                'tools: [cheap_hotels]',
                '---',
                'Prefer trains. Book outside the centre.',
                '',
            ].join('\n'),
            'utf8',
        );
        await writeFile(join(dir, 'budget_travel', 'cities.md'), 'Lisbon, Porto', 'utf8');
    });

    it('indexes both layouts', async () => {
        const provider = new FileSkillProvider({ dir, tools: [cheapHotels] });
        expect((await provider.list()).map((s) => s.name)).toEqual(['budget_travel', 'quick_note']);
    });

    it('loads frontmatter, body and tools', async () => {
        const provider = new FileSkillProvider({ dir, id: 'disk', tools: [cheapHotels] });
        const skill = await provider.load('budget_travel');
        expect(skill.description).toBe('plan on a budget');
        expect(skill.tags).toEqual(['travel', 'money']);
        expect(skill.version).toBe('1.2.0');
        expect(skill.content).toBe('Prefer trains. Book outside the centre.');
        expect(skill.tools?.map((t) => t.name)).toEqual(['cheap_hotels']);
        // Nothing said where the catalog is reachable, so nothing claims a path.
        expect(skill.path).toBeUndefined();
    });

    /**
     * The files beside a SKILL.md are only useful if the agent can name them,
     * and the name is the host's to give: the same folder is `/skills/x` in a
     * container and something else entirely on disk.
     */
    it('names a folder skill by its mount when the host gives one', async () => {
        const provider = new FileSkillProvider({
            dir: { path: dir, at: '/skills' },
            tools: [cheapHotels],
        });
        expect((await provider.load('budget_travel')).path).toBe('/skills/budget_travel');
        // A flat `<name>.md` has no folder of its own to point at.
        expect((await provider.load('quick_note')).path).toBeUndefined();
    });

    it('falls back to the first body line for a bare markdown skill', async () => {
        const skill = await new FileSkillProvider(dir).load('quick_note');
        expect(skill.description).toBe('Quick note');
        expect(skill.tools).toBeUndefined();
    });

    it('searches by name, description and tag', async () => {
        const provider = createSkillProvider(`file:${dir}`);
        expect((await provider.search('money')).map((s) => s.name)).toEqual(['budget_travel']);
    });

    it('rejects a version mismatch and an unregistered tool', async () => {
        const provider = new FileSkillProvider(dir);
        await expect(provider.load('budget_travel', '2.0.0')).rejects.toThrow(/is at 1.2.0/);
        await expect(provider.load('budget_travel')).rejects.toThrow(/unknown tool "cheap_hotels"/);
        await expect(provider.load('nope')).rejects.toThrow(/unknown skill/);
    });

    it('unlocks a whole group from frontmatter', async () => {
        const roomService = tool<Record<string, never>>({
            name: 'room_service',
            group: 'hotel',
            description: 'orders room service',
            parameters: { type: 'object', properties: {} },
            execute: () => 'ordered',
        });
        await writeFile(
            join(dir, 'suite.md'),
            ['---', 'description: living large', 'tools: [hotel:*]', '---', 'Order in.'].join('\n'),
            'utf8',
        );
        const provider = new FileSkillProvider({ dir, tools: [cheapHotels, roomService] });
        expect((await provider.load('suite')).tools?.map((t) => t.name)).toEqual(['room_service']);
    });

    it('picks up new files after refresh', async () => {
        const provider = new FileSkillProvider(dir);
        expect(await provider.list()).toHaveLength(2);
        await writeFile(join(dir, 'late.md'), 'added later', 'utf8');
        expect(await provider.list()).toHaveLength(2);
        provider.refresh();
        expect(await provider.list()).toHaveLength(3);
    });

    it('exposes the absolute file path on the loaded skill', async () => {
        const provider = new FileSkillProvider({ dir, tools: [cheapHotels] });

        const flat = await provider.load('quick_note');
        expect(flat.file).toBe(join(dir, 'quick_note.md'));

        const folder = await provider.load('budget_travel');
        expect(folder.file).toBe(join(dir, 'budget_travel', 'SKILL.md'));
    });

    it('merges skills from multiple directories, later dirs win on name collision', async () => {
        const dir2 = await mkdtemp(join(tmpdir(), 'zenera-stores2-'));
        try {
            // unique skill only in dir2
            await writeFile(join(dir2, 'extra.md'), 'extra skill\n', 'utf8');
            // override quick_note from dir
            await writeFile(
                join(dir2, 'quick_note.md'),
                '# Overridden note\n\nNew body.\n',
                'utf8',
            );

            const provider = new FileSkillProvider({ dir: [dir, dir2], tools: [cheapHotels] });

            const names = (await provider.list()).map((s) => s.name);
            expect(names).toEqual(['budget_travel', 'extra', 'quick_note']);

            // skill from dir2 takes precedence
            const skill = await provider.load('quick_note');
            expect(skill.description).toBe('Overridden note');
            expect(skill.file).toBe(join(dir2, 'quick_note.md'));
        } finally {
            await rm(dir2, { recursive: true, force: true });
        }
    });

    it('silently ignores a missing directory in the list', async () => {
        const provider = new FileSkillProvider({ dir: ['/nonexistent/path', dir] });
        const names = (await provider.list()).map((s) => s.name);
        expect(names).toEqual(['budget_travel', 'quick_note']);
    });
});
