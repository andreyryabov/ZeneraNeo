import type { AnyTool, ToolContext } from '@zenera/neo';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildIndex } from '../../src/schema/build.ts';
import { SchemaIndex } from '../../src/schema/search.ts';
import { schemaTools } from '../../src/schema/tools.ts';
import { StubEmbedder } from '../stub.ts';

// ---------------------------------------------------------------------------
// The tools an agent is handed
//
// The one worth its own file is `find_types_with_property`, because it is the
// answer to a specific failure: the compiler has just said the field does not
// exist on the type that was guessed, and what is needed is the list of types
// that do have it — not another ranking of the same guess.
// ---------------------------------------------------------------------------

const spec = (name: string) => fileURLToPath(new URL(`../specs/${name}`, import.meta.url));

const dir = await mkdtemp(join(tmpdir(), 'zenera-rag-tools-'));
const embedder = new StubEmbedder();

await buildIndex({
    files: [spec('petstore.yaml')],
    out: dir,
    embedder,
    indexer: 'test',
});

const index = await SchemaIndex.open(dir, embedder);
const tools = schemaTools(index);

afterAll(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
});

const ctx = {} as ToolContext;

function named(name: string): AnyTool {
    const found = tools.find((t) => t.name === name);
    expect(found, name).toBeDefined();
    return found!;
}

const call = async (name: string, args: unknown) =>
    (await named(name).execute(args as never, ctx)) as Record<string, unknown>;

describe('the tool set', () => {
    it('is one group, so an agent can select it whole', () => {
        expect(tools.map((t) => t.name)).toEqual([
            'search_api',
            'describe_types',
            'find_types_with_property',
            'list_api',
            'grep_api',
            'trace_api',
        ]);
        expect(tools.every((t) => t.group === 'schema')).toBe(true);
    });
});

describe('search_api', () => {
    it('answers with the connected piece and the ids that matched', async () => {
        const result = await call('search_api', {
            input_properties: ['user password reset token'],
        });

        expect(result.found).toBeGreaterThan(0);
        expect(result.ids).toContain('Property:ResetPasswordPayload.password');
        expect(String(result.api)).toContain('POST /auth/reset-password');
    });

    it('writes TypeScript when asked for it', async () => {
        const result = await call('search_api', {
            input_properties: ['user password reset token'],
            format: 'ts',
        });
        expect(String(result.api)).toContain('export interface ResetPasswordPayload');
    });

    it('refuses a field nobody defined instead of ignoring it', async () => {
        const result = await call('search_api', { output_propertys: ['a'] });
        expect(String(result.error)).toContain('unknown query field');
    });

    it('says so when nothing was asked, rather than answering everything', async () => {
        const result = await call('search_api', { direction: 'input' });
        expect(String(result.error)).toContain('nothing was asked for');
    });

    // One document here, so the parameter is not even offered — the guard is
    // what makes an invented name an answer the model can act on.
    it('names the documents it has when asked for one it does not', async () => {
        const result = await call('search_api', { all: ['pets'], sources: ['nope'] });
        expect(String(result.error)).toContain('no document called nope');
        expect(String(result.hint)).toContain('petstore');
    });
});

describe('find_types_with_property', () => {
    it('lists every type carrying the field, with what it is', async () => {
        const result = await call('find_types_with_property', { property: 'name' });
        const owners = (result.candidates as { type: string }[]).map((c) => c.type);

        expect(owners).toEqual(expect.arrayContaining(['Cat', 'Dog']));
        expect(result.found).toBe(owners.length);
    });

    it('is exact, not a search — a near miss is a miss', async () => {
        const result = await call('find_types_with_property', { property: 'passwrd' });
        expect(result.found).toBe(0);
        expect(String(result.hint)).toContain('search_api');
    });

    it('narrows to the side of the call that was asked for', async () => {
        const inputs = await call('find_types_with_property', {
            property: 'password',
            direction: 'input',
        });
        const outputs = await call('find_types_with_property', {
            property: 'password',
            direction: 'output',
        });

        expect(inputs.found).toBe(1);
        expect(outputs.found).toBe(0);
    });
});

describe('describe_types', () => {
    it('prints a schema with everything it refers to', async () => {
        const result = await call('describe_types', { names: ['PublicUserProfile'] });
        const code = String(result.typescript);

        expect(code).toContain('PublicUserProfile');
        expect(code).toContain('export interface Address');
    });

    it('reports the names it did not have', async () => {
        const result = await call('describe_types', { names: ['Cat', 'Nope'] });
        expect(result.missing).toEqual(['Nope']);
        expect(String(result.typescript)).toContain('export interface Cat');
    });

    it('says nothing matched rather than printing an empty file', async () => {
        const result = await call('describe_types', { names: ['Nope'] });
        expect(String(result.error)).toContain('no such schema');
    });

    it('keeps only the fields asked for', async () => {
        const result = await call('describe_types', { names: ['Cat'], only: ['meowVolume'] });
        const code = String(result.typescript);

        expect(code).toContain('meowVolume?: number;');
        expect(code).not.toContain('barkVolume');
        expect(code).not.toContain('petType');
    });
});

describe('list_api', () => {
    it('lists the operations grouped by route, with no search in between', async () => {
        const result = await call('list_api', {});
        const paths = (result.methods as string[]).map((m) => m.split(' ')[1]!);

        expect(result.found).toBe(4);
        // Ordered by route, so the operations on one resource sit together
        // rather than being scattered by their verb.
        expect(paths).toEqual([...paths].sort());
        expect(paths[0]).toBe('/auth/reset-password');
    });

    it('filters by path and by what the verb does', async () => {
        expect((await call('list_api', { path: '/auth' })).found).toBe(1);
        expect((await call('list_api', { method_type: 'read_only' })).found).toBe(2);
    });

    it('reads a bare word as a substring and a star as a glob', async () => {
        const bare = await call('list_api', { kind: 'types', name: 'Password' });
        const wrapped = await call('list_api', { kind: 'types', name: '*Password*' });

        expect(bare.found).toBeGreaterThan(0);
        expect(wrapped.found).toBe(bare.found);
        // A glob matches the whole name, so this one anchors at the start and
        // finds nothing — which is why a bare word cannot mean the same thing.
        expect((await call('list_api', { kind: 'types', name: 'Password*' })).found).toBe(0);
    });

    it('lists schemas and fields too, not only routes', async () => {
        const types = await call('list_api', { kind: 'types' });
        const fields = await call('list_api', { kind: 'properties', name: 'password' });

        expect(types.found).toBeGreaterThan(0);
        expect(String((types.types as string[]).join('\n'))).toContain('fields');
        expect(fields.found).toBeGreaterThan(0);
    });

    it('counts every match even when it returns only some', async () => {
        const all = await call('list_api', { kind: 'properties' });
        const one = await call('list_api', { kind: 'properties', limit: 1 });

        expect(one.found).toBe(all.found);
        expect(one.truncated).toBe(true);
        expect((one.properties as string[]).length).toBe(1);
    });
});

describe('grep_api', () => {
    it('finds every literal occurrence, whatever a ranking would have thought', async () => {
        const result = await call('grep_api', { pattern: 'password' });
        const ids = (result.matches as { id: string }[]).map((m) => m.id);

        expect(result.found).toBe(ids.length);
        expect(ids).toContain('Property:ResetPasswordPayload.password');
        expect(ids).toContain('Type:ResetPasswordPayload');
    });

    it('ignores case, because nobody knows how a field was capitalized', async () => {
        expect((await call('grep_api', { pattern: 'PASSWORD' })).found).toBeGreaterThan(0);
    });

    it('takes a regex when asked, and says so when it is not one', async () => {
        expect(
            (await call('grep_api', { pattern: 'pass(word|phrase)', regex: true })).found,
        ).toBeGreaterThan(0);
        expect(
            String((await call('grep_api', { pattern: '(unclosed', regex: true })).error),
        ).toContain('invalid pattern');
    });

    it('answers that a thing is absent, which is the point of it', async () => {
        const result = await call('grep_api', { pattern: 'passwrd' });
        expect(result.found).toBe(0);
        expect(String(result.hint)).toContain('not there');
    });

    it('narrows to one kind of node', async () => {
        const types = await call('grep_api', { pattern: 'password', kind: 'type' });
        const ids = (types.matches as { id: string }[]).map((m) => m.id);
        expect(ids.every((id) => id.startsWith('Type:'))).toBe(true);
    });
});

describe('trace_api', () => {
    it('walks a nested field up to the call that returns it', async () => {
        const result = await call('trace_api', { of: 'city' });
        const traced = result.traced as { id: string; operations: string[] }[];
        const address = traced.find((t) => t.id === 'Property:Address.city');

        // Nothing in the document mentions `city` anywhere near `getUser`;
        // the only thing joining them is PublicUserProfile.address.
        expect(address).toBeDefined();
        expect(address!.operations.join('\n')).toContain('GET /users/{userId}');
        expect(address!.operations.join('\n')).toContain(
            'PublicUserProfile.address → Address.city',
        );
    });

    it('says which side of the call each answer is on', async () => {
        const result = await call('trace_api', { of: 'password', direction: 'input' });
        const traced = result.traced as { id: string; operations: string[] }[];

        expect(traced.flatMap((t) => t.operations).join('\n')).toContain(
            'POST /auth/reset-password',
        );
    });

    it('keeps only the side that was asked for', async () => {
        const on = (direction: string) =>
            call('trace_api', { of: 'Property:Address.city', direction }).then((r) =>
                (r.traced as { operations: string[] }[]).flatMap((t) => t.operations),
            );

        expect((await on('output')).join('\n')).toContain('GET /users/{userId}');
        // Nothing accepts an address, and an empty answer is the correct one.
        expect(await on('input')).toEqual([]);
    });

    it('takes a node id as the thing itself, not as a pattern', async () => {
        const result = await call('trace_api', { of: 'Type:Cat' });
        const traced = result.traced as { id: string; operations: string[] }[];

        expect(traced).toHaveLength(1);
        // Cat is reached only through the oneOf on Pet, which is two hops.
        expect(traced[0]!.operations.join('\n')).toContain('Pet → Cat');
    });

    it('says nothing is called that, rather than answering emptily', async () => {
        const result = await call('trace_api', { of: 'mfa_secret' });
        expect(result.found).toBe(0);
        expect(String(result.hint)).toContain('grep_api');
    });
});
