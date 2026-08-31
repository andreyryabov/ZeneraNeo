import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AnyTool, ToolContext } from '@zenera/neo';
import { buildIndex } from '../src/schema/build.ts';
import { SchemaIndex } from '../src/schema/search.ts';
import { schemaTools } from '../src/schema/tools.ts';
import { StubEmbedder } from './stub.ts';

// ---------------------------------------------------------------------------
// The tools an agent is handed
//
// The one worth its own file is `find_types_with_property`, because it is the
// answer to a specific failure: the compiler has just said the field does not
// exist on the type that was guessed, and what is needed is the list of types
// that do have it — not another ranking of the same guess.
// ---------------------------------------------------------------------------

const spec = (name: string) => fileURLToPath(new URL(`./specs/${name}`, import.meta.url));

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
            'list_methods',
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

describe('list_methods', () => {
    it('lists the operations, sorted, with no search in between', async () => {
        const result = await call('list_methods', {});
        expect(result.found).toBe(4);
        expect((result.methods as string[])[0]).toMatch(/^GET \/pets/);
    });

    it('filters by path and by what the verb does', async () => {
        expect((await call('list_methods', { contains: '/auth' })).found).toBe(1);
        expect((await call('list_methods', { method_type: 'read_only' })).found).toBe(2);
    });
});
