import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { buildIndex } from '../../src/schema/build.ts';
import { toOpenApi, toTypeScript } from '../../src/schema/hydrate.ts';
import { toMermaid, toText } from '../../src/schema/render.ts';
import { SchemaIndex, type SchemaQuery } from '../../src/schema/search.ts';
import type { Subgraph } from '../../src/schema/subgraph.ts';
import { StubEmbedder } from '../stub.ts';

// ---------------------------------------------------------------------------
// Searching, and what comes back
//
// The assertion that carries this file is the last one: the TypeScript it
// emits is handed to the compiler. Anything less proves the printer produced
// *a* string, and the whole reason to print TypeScript rather than JSON Schema
// is that a compiler is going to read it.
// ---------------------------------------------------------------------------

const spec = (name: string) => fileURLToPath(new URL(`../specs/${name}`, import.meta.url));

const dir = await mkdtemp(join(tmpdir(), 'zenera-rag-'));
const embedder = new StubEmbedder();

await buildIndex({
    files: [spec('petstore.yaml'), spec('billing.json')],
    out: dir,
    embedder,
    indexer: 'test',
});

const index = await SchemaIndex.open(dir, embedder);
const schemas = await index.schemas();
const operations = await index.operations();

afterAll(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
});

const find = (subs: Subgraph[], id: string) => subs.find((s) => s.nodes.some((n) => n.id === id));

async function search(query: SchemaQuery) {
    return await index.search(query);
}

describe('opening', () => {
    it('refuses an index built by another embedder', async () => {
        await expect(SchemaIndex.open(dir, new StubEmbedder('stub:other'))).rejects.toThrow(
            /built with stub:bag-of-words/,
        );
    });

    it('answers an empty query with nothing rather than everything', async () => {
        expect(await search({})).toEqual({ seeds: [], subgraphs: [], empty: [] });
    });
});

describe('finding a field', () => {
    it('reaches the payload and the call that takes it from the field alone', async () => {
        const { subgraphs } = await search({
            input_properties: ['user password reset token'],
        });
        const part = find(subgraphs, 'Property:ResetPasswordPayload.password');

        expect(part).toBeDefined();
        expect(part!.hits).toContain('Property:ResetPasswordPayload.password');
        expect(part!.nodes.map((n) => n.id)).toEqual(
            expect.arrayContaining(['Type:ResetPasswordPayload', 'Method:resetPassword']),
        );
    });

    it('keeps a directional search on its own side of the call', async () => {
        const { seeds } = await search({ output_properties: ['password token'] });
        const directions = seeds.map((s) => index.graph.getNodeAttribute(s.id, 'direction'));

        expect(seeds.length).toBeGreaterThan(0);
        expect(directions.every((d) => d === 'output' || d === 'both')).toBe(true);
        expect(seeds.map((s) => s.id)).not.toContain('Property:ResetPasswordPayload.password');
    });

    it('finds a query parameter, which is a property like any other', async () => {
        const { seeds } = await search({ input_properties: ['page size paging'] });
        expect(seeds.map((s) => s.id)).toContain('Property:listPets#page_size');
    });
});

describe('filters', () => {
    it('narrows methods to the ones that change something', async () => {
        const { seeds } = await search({ methods: ['pets'], method_type: 'read_write' });
        expect(seeds.length).toBeGreaterThan(0);
        for (const seed of seeds) {
            expect(index.graph.getNodeAttribute(seed.id, 'methodType')).toBe('read_write');
        }
    });

    it('does not let a method-type filter empty an unfiltered query', async () => {
        const { seeds } = await search({ all: ['password'], method_type: 'read_write' });
        expect(seeds.some((s) => index.graph.getNodeAttribute(s.id, 'kind') !== 'method')).toBe(
            true,
        );
    });
});

describe('exclusions', () => {
    it('drops what has already been seen, and finds something else instead', async () => {
        const first = await search({ input_properties: ['user password reset token'] });
        const seen = first.seeds.map((s) => s.id);
        expect(seen.length).toBeGreaterThan(0);

        const second = await search({
            input_properties: ['user password reset token'],
            exclude_ids: seen,
        });
        expect(second.seeds.map((s) => s.id)).not.toEqual(expect.arrayContaining(seen));
    });

    it('excludes by name as well as by id', async () => {
        const { seeds } = await search({
            input_properties: ['user password reset token'],
            exclude_properties: ['password'],
        });
        expect(seeds.map((s) => s.id)).not.toContain('Property:ResetPasswordPayload.password');
    });

    it('reports a term that matched nothing once exclusions were applied', async () => {
        const all = await search({ methods: ['invoices'], limit: 20 });
        const { empty } = await search({
            methods: ['invoices'],
            limit: 20,
            exclude_ids: all.seeds.map((s) => s.id),
        });
        expect(empty).toContain('invoices');
    });
});

describe('stitching', () => {
    it('keeps unrelated hits in separate subgraphs', async () => {
        const { subgraphs } = await search({
            methods: ['invoices billing tenant'],
            input_properties: ['user password reset token'],
            limit: 1,
        });
        expect(subgraphs.length).toBeGreaterThan(1);
    });

    it('joins hits that the graph joins, however they were found', async () => {
        const { subgraphs } = await search({
            types: ['pet animal'],
            properties: ['meow volume'],
            limit: 2,
        });
        const part = find(subgraphs, 'Property:Cat.meowVolume');
        expect(part?.nodes.map((n) => n.id)).toContain('Type:Cat');
    });

    it('stays inside the node budget and says when it did not fit', async () => {
        const { subgraphs } = await search({ all: ['user profile address'], max_nodes: 3 });
        for (const part of subgraphs) {
            expect(part.nodes.length).toBeLessThanOrEqual(3);
        }
        expect(subgraphs.some((s) => s.truncated)).toBe(true);
    });
});

describe('rendering', () => {
    it('writes a tree that marks the hits and names the call', async () => {
        const { subgraphs } = await search({
            input_properties: ['user password reset token'],
        });
        const text = toText(subgraphs[0]!, { docs: true });

        expect(text).toContain('POST /auth/reset-password');
        expect(text).toContain('» password: string');
        expect(text).toContain('New plain-text user password');
    });

    it('writes a class diagram whose ids mermaid can read', async () => {
        const { subgraphs } = await search({ types: ['pet animal cat dog'] });
        const diagram = toMermaid(subgraphs[0]!, { docs: true });

        expect(diagram.startsWith('classDiagram')).toBe(true);
        expect(diagram).toMatch(/class \w+ \{/);
        expect(diagram).not.toMatch(/class \S*[/{}]/);
        // Colours belong to whatever renders the diagram, not to the diagram.
        expect(diagram).not.toContain('style ');
    });

    it('joins a class to the type of its field, which is a line inside the class', async () => {
        const { subgraphs } = await search({ properties: ['postcode'] });
        const diagram = toMermaid(find(subgraphs, 'Property:petstore.Address.postcode')!, {});

        expect(diagram).toContain('PublicUserProfile --> petstore_Address : address');
        // The name is what is being looked for; the type answers it.
        expect(diagram).toContain('-postcode : string');
    });
});

describe('hydration', () => {
    it('emits the type the search was about', async () => {
        const { subgraphs } = await search({
            input_properties: ['user password reset token'],
        });
        const code = toTypeScript(subgraphs[0]!, schemas, { docs: true });

        expect(code).toContain('// POST /auth/reset-password');
        expect(code).toContain('export interface ResetPasswordPayload {');
        expect(code).toContain(
            '/** New plain-text user password complying with complexity rules. */',
        );
    });

    it('closes over $ref, so nothing printed names something that is not', async () => {
        const { subgraphs } = await search({ output_types: ['public user profile'] });
        const part = find(subgraphs, 'Type:PublicUserProfile');
        const code = toTypeScript(part!, schemas, {});

        // An `allOf` has no properties of its own, so it prints as an
        // intersection; `Address` is claimed by both fixtures and so carries
        // the document it came from.
        expect(code).toContain('export type PublicUserProfile = Timestamps &');
        expect(code).toContain('export interface petstore_Address');
        expect(code).toContain('export interface Timestamps');
    });

    it('narrows to the matched properties when asked', async () => {
        const { subgraphs } = await search({
            input_properties: ['user password reset token'],
        });
        const code = toTypeScript(subgraphs[0]!, schemas, { onlyHits: true });
        expect(code).toContain('password: string;');
    });

    it('turns parameters into an interface a caller can hold', async () => {
        const { subgraphs } = await search({ methods: ['list every pet on file'] });
        const code = toTypeScript(subgraphs[0]!, schemas, { docs: true });

        expect(code).toContain('export interface listPetsParams {');
        expect(code).toContain('page_size?: number;');
    });

    it('compiles', async () => {
        const { subgraphs } = await search({
            all: ['pet cat dog user profile address invoice password'],
            max_nodes: 400,
            limit: 8,
        });
        const code = subgraphs.map((s) => toTypeScript(s, schemas, { docs: true })).join('\n');

        expect(code.length).toBeGreaterThan(200);
        expect(diagnose(code)).toEqual([]);
    });

    it('emits a tagged union the compiler can narrow', async () => {
        const { subgraphs } = await search({ types: ['pet animal cat dog'] });
        const code = toTypeScript(subgraphs[0]!, schemas, {});

        expect(code).toContain('export type Pet = Cat | Dog;');
        expect(
            diagnose(`${code}
declare const pet: Pet;
if (pet.petType === 'cat') {
    const volume: number | undefined = pet.meowVolume;
    void volume;
}`),
        ).toEqual([]);
    });

    it('refuses a discriminator value that is not one of the branches', async () => {
        const { subgraphs } = await search({ types: ['pet animal cat dog'] });
        const code = toTypeScript(subgraphs[0]!, schemas, {});

        expect(
            diagnose(`${code}
declare const pet: Pet;
if (pet.petType === 'feline') {
}`).join(' '),
        ).toMatch(/no overlap|not comparable/i);
    });
});

describe('the openapi subset', () => {
    it('rebuilds a document holding only the operations that were found', async () => {
        const { subgraphs } = await search({
            input_properties: ['user password reset token'],
        });
        const doc = toOpenApi(subgraphs[0]!, schemas, operations) as {
            paths: Record<string, Record<string, unknown>>;
            components: { schemas: Record<string, unknown> };
        };

        expect(Object.keys(doc.paths)).toEqual(['/auth/reset-password']);
        expect(doc.paths['/auth/reset-password']).toHaveProperty('post');
        expect(doc.components.schemas).toHaveProperty('ResetPasswordPayload');
    });

    it('points its refs at components rather than at the internal namespace', async () => {
        const { subgraphs } = await search({ output_types: ['public user profile'] });
        const part = find(subgraphs, 'Type:PublicUserProfile');
        const text = JSON.stringify(toOpenApi(part!, schemas, operations));

        expect(text).toContain('#/components/schemas/petstore.Address');
        expect(text).not.toContain('#/$defs/');
    });
});

// ---------------------------------------------------------------------------

/** Type-checks a string of TypeScript and reports what the compiler said. */
function diagnose(source: string): string[] {
    const name = '/hydrated.ts';
    const options: ts.CompilerOptions = {
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        moduleDetection: ts.ModuleDetectionKind.Force,
        skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);

    host.getSourceFile = (file, version, onError, shouldCreate) =>
        file === name
            ? ts.createSourceFile(name, source, version)
            : original(file, version, onError, shouldCreate);
    host.fileExists = (file) => file === name || ts.sys.fileExists(file);
    host.readFile = (file) => (file === name ? source : ts.sys.readFile(file));

    const program = ts.createProgram([name], options, host);
    return ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}
