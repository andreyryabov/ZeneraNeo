import { connect } from '@lancedb/lancedb';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lancePath } from '../../src/docs/files.ts';
import { openChunks, WRITE_BATCH, type ChunkRecord } from '../../src/docs/store.ts';

// ---------------------------------------------------------------------------
// More rows than fit in one Arrow batch
//
// The corpus that found this was 198,642 chunks written as a single batch: a
// 2.27 GiB vector buffer, 32-bit offsets underneath it, and a panic inside
// Arrow's reader on a thread whose panic never reached JavaScript. The table
// came out empty, the build carried on, and the only error anyone saw was the
// vector index refusing to train on nothing.
//
// So the assertion is dull on purpose, and it is read back through a second
// connection rather than trusted from the writer's own return value.
// ---------------------------------------------------------------------------

const DIMENSIONS = 96;
const ROWS = WRITE_BATCH + 3;

const dir = await mkdtemp(join(tmpdir(), 'zenera-rag-store-'));

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

const rows: ChunkRecord[] = Array.from({ length: ROWS }, (_, i) => ({
    id: `doc.md#c${i}`,
    path: 'doc.md',
    ordinal: i,
    kind: 'paragraph',
    text: `chunk number ${i}`,
    embedText: `chunk number ${i}`,
    lineSpec: `${i + 1}`,
    bodyStart: i + 1,
    bodyEnd: i + 1,
    structureId: 'doc.md#s0',
    structurePath: 'Doc',
    headings: 'Doc',
    tokens: 3,
}));

// Spread out enough that training the vector index has real clusters to find;
// duplicates make it warn at length about a dataset it cannot index well.
const vectors = rows.map((_, i) =>
    Float32Array.from({ length: DIMENSIONS }, (_, d) => Math.sin(i * 97.13 + d * 31.7)),
);

// The first window is wider than one Arrow batch, so the writer has to split it
// on its own; the second is what proves an existing table can be appended to.
const split = WRITE_BATCH + 1;
const writer = await openChunks(dir);
await writer.add(rows.slice(0, split), vectors.slice(0, split));
await writer.add(rows.slice(split), vectors.slice(split));
const written = await writer.finish();

describe('writing a corpus larger than one batch', () => {
    it('reports every row, and builds both indexes', () => {
        expect(written).toEqual({ rows: ROWS, fts: true, vector: true });
    });

    it('leaves every row in the table, including the one past the batch', async () => {
        const db = await connect(lancePath(dir));
        try {
            const table = await db.openTable('chunks');
            expect(await table.countRows()).toBe(ROWS);
            expect(await table.countRows(`ordinal = ${ROWS - 1}`)).toBe(1);
        } finally {
            db.close();
        }
    });

    it('refuses to finish a table nothing was ever added to', async () => {
        const empty = await mkdtemp(join(tmpdir(), 'zenera-rag-store-'));
        const writer = await openChunks(empty);

        await expect(writer.finish()).rejects.toThrow(/nothing to index/);
        writer.close();
        await rm(empty, { recursive: true, force: true });
    });
});
