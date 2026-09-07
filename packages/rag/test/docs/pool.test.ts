import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/docs/chunk.ts';
import { outlineOf } from '../../src/docs/outline.ts';
import { parseDocument } from '../../src/docs/parse.ts';
import { parseAll, parseThreaded, poolSize, type ParseInput } from '../../src/docs/pool.ts';

// ---------------------------------------------------------------------------
// Parsing on several threads
//
// The pool has one job and one obligation: be faster, and be indistinguishable.
// Everything here is the second half of that. It calls the threaded path
// directly wherever it can, because `parseAll` falls back to this thread when
// the workers will not start — which is the right thing for a build and would
// let a completely broken worker pass a test without a sound.
// ---------------------------------------------------------------------------

const document = (seed: string, sections: number): string =>
    Array.from(
        { length: sections },
        (_, i) =>
            `## ${seed} section ${i}\n\n` +
            `Some prose about ${seed}, part ${i}, with enough words in it to be worth cutting.\n\n` +
            `| column | value |\n| ------ | ----- |\n| ${seed} | ${i} |\n`,
    ).join('\n');

const corpus = (n: number): ParseInput[] =>
    Array.from({ length: n }, (_, i) => ({
        name: `doc-${i}.md`,
        text: document(`seed${i}`, 4),
        format: 'markdown' as const,
    }));

const inThisThread = (inputs: readonly ParseInput[]) =>
    inputs.map((input) => {
        const parsed = parseDocument(input.text, input.name, input.format);
        const chunks = chunkDocument(parsed, {});
        return { chunks, outline: outlineOf(parsed, chunks.length) };
    });

describe('the parse pool', () => {
    it('produces exactly what one thread would have', async () => {
        const inputs = corpus(12);

        const threaded = await parseThreaded(inputs, {}, 4);

        expect(threaded).toEqual(inThisThread(inputs));
    });

    it('keeps the caller\u2019s order however the threads interleave', async () => {
        // Descending sizes, so the first job is the slowest and the last worker
        // to be handed work is the first to finish.
        const inputs = Array.from({ length: 12 }, (_, i) => ({
            name: `doc-${i}.md`,
            text: document(`seed${i}`, 24 - i * 2),
            format: 'markdown' as const,
        }));

        const threaded = await parseThreaded(inputs, {}, 4);

        expect(threaded.map((p) => p.outline.name)).toEqual(inputs.map((i) => i.name));
        expect(threaded).toEqual(inThisThread(inputs));
    });

    it('honours the chunk settings it was given, across the boundary', async () => {
        const inputs = corpus(10);
        const chunk = { chunkTokens: 24, maxChunkTokens: 48 };

        const threaded = await parseThreaded(inputs, chunk, 3);
        const here = inputs.map((input) => {
            const parsed = parseDocument(input.text, input.name, input.format);
            const chunks = chunkDocument(parsed, chunk);
            return { chunks, outline: outlineOf(parsed, chunks.length) };
        });

        expect(threaded).toEqual(here);
        expect(threaded[0]!.chunks.length).toBeGreaterThan(1);
    });

    it('counts every document exactly once', async () => {
        const inputs = corpus(12);
        const seen: number[] = [];

        await parseThreaded(inputs, {}, 4, (done, total) => {
            expect(total).toBe(12);
            seen.push(done);
        });

        expect(seen).toHaveLength(12);
        expect([...seen].sort((a, b) => a - b)).toEqual(seen);
        expect(seen.at(-1)).toBe(12);
    });

    it('names what it is still on, so a slow document is not a stall', async () => {
        const inputs = corpus(12);
        const names = new Set(inputs.map((i) => i.name));
        let last: readonly string[] = [];

        await parseThreaded(inputs, {}, 4, (_done, _total, pending) => {
            expect(pending.every((name) => names.has(name))).toBe(true);
            expect(pending.length).toBeLessThan(4);
            last = pending;
        });

        expect(last).toEqual([]);
    });

    it('reports a document that would not parse against its name', async () => {
        // `parseDocument` is total over strings, so the failure has to be forced
        // from the one input the worker does not validate.
        const broken = [{ name: 'broken.md', text: null, format: 'markdown' }] as never;

        await expect(parseThreaded(broken, {}, 1)).rejects.toThrow(/broken\.md/);
    });

    it('lets the loop breathe while it parses here, so the report stays live', async () => {
        const order: string[] = [];
        setTimeout(() => order.push('tick'), 0);

        // A function forces the in-process path, which is the one that used to
        // hold the thread for the whole corpus.
        await parseAll(corpus(40), { chunk: { tokenCount: (text) => text.length } });
        order.push('done');

        expect(order).toEqual(['tick', 'done']);
    });

    it('falls back to this thread rather than cloning a function', async () => {
        const inputs = corpus(12);
        // `postMessage` cannot clone a function; the pool has to notice first.
        const chunk = { tokenCount: (text: string) => text.length };

        const result = await parseAll(inputs, { chunk, workers: 4 });

        expect(result).toEqual(
            inputs.map((input) => {
                const parsed = parseDocument(input.text, input.name, input.format);
                const chunks = chunkDocument(parsed, chunk);
                return { chunks, outline: outlineOf(parsed, chunks.length) };
            }),
        );
    });

    it('does not start a thread for a handful of documents', async () => {
        const inputs = corpus(3);
        expect(await parseAll(inputs, { workers: 4 })).toEqual(inThisThread(inputs));
    });

    it('handles an empty corpus without starting anything', async () => {
        expect(await parseAll([], { workers: 4 })).toEqual([]);
    });

    it('leaves a core for the thread doing everything else', () => {
        expect(poolSize()).toBeGreaterThanOrEqual(1);
        expect(poolSize()).toBeLessThanOrEqual(8);
    });
});
