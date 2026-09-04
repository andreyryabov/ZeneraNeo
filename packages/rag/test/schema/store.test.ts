import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildIndex } from '../src/schema/build.ts';
import { openIndex, readManifest } from '../src/schema/files.ts';
import { EntityStore } from '../src/schema/store.ts';
import { StubEmbedder } from './stub.ts';

// ---------------------------------------------------------------------------
// The index, for real
//
// A real LanceDB in a temp directory, because the plumbing is the risky part:
// an inferred Arrow schema, an fts index, and a hybrid query that has to come
// back with rows in an order rather than an error.
// ---------------------------------------------------------------------------

const spec = (name: string) => fileURLToPath(new URL(`./specs/${name}`, import.meta.url));

const dir = await mkdtemp(join(tmpdir(), 'zenera-rag-'));
const embedder = new StubEmbedder();

const { manifest } = await buildIndex({
    files: [spec('petstore.yaml'), spec('billing.json')],
    out: dir,
    embedder,
    indexer: 'test',
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function vector(text: string): Promise<Float32Array> {
    const res = await embedder.embed({ input: [text], taskType: 'query' });
    return Float32Array.from(res.vectors[0]!);
}

describe('the manifest', () => {
    it('records the embedder, the documents and what was counted', () => {
        expect(manifest.embedding).toEqual({
            ref: 'stub:bag-of-words',
            id: 'stub:bag-of-words',
            dimensions: 96,
        });
        expect(manifest.sources.map((s) => s.title)).toEqual(['Petstore', 'Billing']);
        expect(manifest.sources.map((s) => s.dialect)).toEqual(['openapi-3.1', 'swagger-2.0']);
        expect(manifest.sources.every((s) => s.path && !isAbsolute(s.path))).toBe(true);
        expect(manifest.counts.methods).toBe(6);
        expect(manifest.counts.entities).toBeGreaterThan(manifest.counts.properties);
    });

    it('leaves a small table to a flat scan rather than training an index', () => {
        expect(manifest.indexes).toEqual({ fts: true, vector: false });
    });

    it('is readable back off the disk', async () => {
        await expect(readManifest(dir)).resolves.toMatchObject({ indexer: 'test' });
    });
});

describe('reopening', () => {
    it('brings the graph back with its edges and attributes', async () => {
        const index = await openIndex(dir);

        expect(index.graph.order).toBe(manifest.counts.entities);
        expect(index.graph.getNodeAttribute('Type:ResetPasswordPayload', 'direction')).toBe(
            'input',
        );
        expect(
            index.graph
                .outEdges('Method:resetPassword')
                .map((e) => index.graph.getEdgeAttribute(e, 'relation')),
        ).toContain('TAKES_INPUT');
    });

    it('reads the schemas only when something asks for them', async () => {
        const index = await openIndex(dir);
        const schemas = await index.schemas();

        expect(schemas.ResetPasswordPayload).toMatchObject({ type: 'object' });
        // Memoized: the second call is the same promise's value, not a reread.
        expect(await index.schemas()).toBe(schemas);
    });
});

describe('searching the store', () => {
    it('ranks the property that is about the query above one that is not', async () => {
        const store = await EntityStore.open(dir);
        const hits = await store.search(
            'user password reset token',
            await vector('user password reset token'),
            { kinds: ['property'] },
            5,
        );
        store.close();

        const ids = hits.map((h) => h.record.id);
        expect(ids).toContain('Property:ResetPasswordPayload.password');
        expect(ids.indexOf('Property:ResetPasswordPayload.password')).toBeLessThan(
            ids.indexOf('Property:PublicUserProfile.email') === -1
                ? ids.length
                : ids.indexOf('Property:PublicUserProfile.email'),
        );
    });

    it('honours the kind filter', async () => {
        const store = await EntityStore.open(dir);
        const hits = await store.search('pets', await vector('pets'), { kinds: ['method'] }, 5);
        store.close();

        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.record.kind === 'method')).toBe(true);
    });

    it('honours the direction and method-type filters together', async () => {
        const store = await EntityStore.open(dir);
        const hits = await store.search(
            'invoice total',
            await vector('invoice total'),
            { kinds: ['type'], directions: ['input', 'both'] },
            10,
        );
        const methods = await store.search(
            'create',
            await vector('create'),
            { kinds: ['method'], methodTypes: ['read_write'] },
            10,
        );
        store.close();

        expect(hits.every((h) => ['input', 'both'].includes(h.record.direction))).toBe(true);
        expect(methods.every((h) => h.record.methodType === 'read_write')).toBe(true);
    });

    it('refuses a filter value it did not define', async () => {
        const store = await EntityStore.open(dir);
        await expect(
            store.search('x', await vector('x'), { kinds: ["property' OR '1'='1"] }, 5),
        ).rejects.toThrow(/kind cannot be/);
        store.close();
    });

    it('brings a whole record back, not just an id', async () => {
        const store = await EntityStore.open(dir);
        const [hit] = await store.search(
            'reset password payload',
            await vector('reset password payload'),
            { kinds: ['type'] },
            1,
        );
        store.close();

        expect(hit?.record).toMatchObject({
            kind: 'type',
            direction: expect.any(String),
            text: expect.stringContaining('[type]'),
        });
        expect(hit?.rank).toBe(0);
    });
});
