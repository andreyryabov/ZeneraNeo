import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IdClock } from '../src/ids.ts';
import { MemoryIndex } from '../src/memory/index.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { MemoryError } from '../src/memory/types.ts';

/**
 * Read-only is the property a batch is built on: several runs recall from one
 * graph at the same time, and none of them may change a byte of it. Every test
 * here is one way that could quietly stop being true.
 */

function clockFrom(start = 1): IdClock {
    let n = start;
    return { newId: () => `ID${n++}`, now: () => '2026-01-01T00:00:00.000Z' };
}

const SEES = ['*'];

describe('a memory opened read-only', () => {
    let dir: string;

    /** A memory with something in it — a read-only open of an empty one is refused. */
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'neo-readonly-'));
        const store = await MemoryStore.open(dir);
        const index = new MemoryIndex({ store });
        await index.commit(
            { nodes: [{ ref: 'a', kind: 'fact', text: 'the invoice threshold is 500' }] },
            { writes: SEES, sees: SEES, clock: clockFrom() },
        );
        store.release();
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('refuses to commit rather than dropping the write', async () => {
        const store = await MemoryStore.open(dir, { readOnly: true });
        expect(store.readOnly).toBe(true);
        await expect(store.commit()).rejects.toThrow(MemoryError);
        await expect(store.commit()).rejects.toThrow(/read-only/);
    });

    it('leaves the graph byte-identical after a load', async () => {
        const graph = join(dir, 'graph.json');
        const before = createHash('sha256')
            .update(await readFile(graph))
            .digest('hex');

        const index = new MemoryIndex({
            store: await MemoryStore.open(dir, { readOnly: true }),
        });
        const [loaded] = await index.load(['ID1'], SEES, clockFrom(9));
        expect(loaded?.node.text).toContain('invoice threshold');

        const after = createHash('sha256')
            .update(await readFile(graph))
            .digest('hex');
        expect(after).toBe(before);
    });

    it('takes no lock, so any number of readers may share one graph', async () => {
        const readers = await Promise.all(
            Array.from({ length: 4 }, () => MemoryStore.open(dir, { readOnly: true })),
        );
        expect(readers).toHaveLength(4);
        expect(existsSync(join(dir, '.lock'))).toBe(false);
        // And a writer is still refused a second time, which is the rule the
        // read-only mode exists to step around rather than to remove.
        const writer = await MemoryStore.open(dir);
        try {
            await expect(MemoryStore.open(dir)).rejects.toThrow(/in use/);
        } finally {
            writer.release();
        }
    });

    it('refuses a directory that is not a memory instead of creating one', async () => {
        const empty = await mkdtemp(join(tmpdir(), 'neo-empty-'));
        try {
            await expect(MemoryStore.open(empty, { readOnly: true })).rejects.toThrow(
                /is not a memory/,
            );
            expect(existsSync(join(empty, 'files'))).toBe(false);
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    });
});
