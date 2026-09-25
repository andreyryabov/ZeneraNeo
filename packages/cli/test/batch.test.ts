import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { concurrency, keepWritten, pool, prepareMemories } from '../src/batch.ts';
import { type BatchItem, parseBatch, readBatch } from '../src/request.ts';

/**
 * A batch pays for every mistake once per item, so the file is read strictly
 * and completely before a single model is called. These are the refusals.
 */

const BASE = '/cases';
const at = (body: unknown) => () => parseBatch(JSON.stringify(body), BASE, 'cases.json');

/** What the person actually reads: the refusal and the way out of it. */
function said(fn: () => unknown): string {
    try {
        fn();
    } catch (err) {
        const e = err as { message: string; hint?: string };
        return `${e.message} ${e.hint ?? ''}`;
    }
    throw new Error('expected a refusal');
}

describe('reading a batch file', () => {
    it('takes a list of requests and numbers them', () => {
        const { items } = parseBatch(
            JSON.stringify({ batch: [{ input: 'one' }, { id: 'two', input: 'two' }] }),
            BASE,
            'cases.json',
        );
        expect(items).toEqual([
            { id: '0', index: 0, input: 'one', workspace: undefined },
            { id: 'two', index: 1, input: 'two', workspace: undefined },
        ]);
    });

    it('resolves an item workspace against the file, not the cwd', () => {
        const { items } = parseBatch(
            JSON.stringify({ batch: [{ input: 'x', workspace: './here' }] }),
            BASE,
            'cases.json',
        );
        expect(items[0]!.workspace).toBe(join(BASE, 'here'));
    });

    it('refuses anything that is not a list of requests', () => {
        expect(at([])).toThrow(/expected a JSON object/);
        expect(at({})).toThrow(/no "batch" array/);
        expect(at({ batch: {} })).toThrow(/no "batch" array/);
        expect(at({ batch: [] })).toThrow(/is empty/);
        expect(at({ batch: ['ask'] })).toThrow(/expected an object/);
        expect(at({ batch: [{ prompt: 'ask' }] })).toThrow(/no "input"/);
        expect(() => parseBatch('{', BASE, 'cases.json')).toThrow(/cases\.json/);
    });

    it('names the flag when the file tries to say what a flag says', () => {
        expect(said(at({ memory: './m', batch: [{ input: 'x' }] }))).toMatch(/--memory/);
        expect(said(at({ workspace: './w', batch: [{ input: 'x' }] }))).toMatch(/--workspace/);
        expect(said(at({ project: 'acme', batch: [{ input: 'x' }] }))).toMatch(/--project/);
        expect(said(at({ batch: [{ input: 'x', memory: './m' }] }))).toMatch(/--memory/);
        expect(said(at({ batch: [{ input: 'x', project: 'acme' }] }))).toMatch(/--project/);
    });

    it('refuses two items that would share a directory', () => {
        expect(
            at({
                batch: [
                    { id: 'a', input: 'x' },
                    { id: 'a', input: 'y' },
                ],
            }),
        ).toThrow(/share the id "a"/);
        expect(
            at({
                batch: [
                    { input: 'x', workspace: './w' },
                    { input: 'y', workspace: './w' },
                ],
            }),
        ).toThrow(/share the workspace/);
    });

    it('refuses an id that is not a directory name', () => {
        expect(at({ batch: [{ id: '../escape', input: 'x' }] })).toThrow(/cannot be an id/);
        expect(at({ batch: [{ id: 'a/b', input: 'x' }] })).toThrow(/cannot be an id/);
        expect(at({ batch: [{ id: '..', input: 'x' }] })).toThrow(/cannot be an id/);
        expect(at({ batch: [{ id: '', input: 'x' }] })).toThrow(/non-empty string/);
    });
});

describe('the batch file on disk', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'zen-batch-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('resolves paths against the file wherever it was run from', async () => {
        const file = join(dir, 'cases.json');
        await writeFile(file, JSON.stringify({ batch: [{ input: 'x', workspace: './w' }] }));
        const { items } = await readBatch(file, '/elsewhere');
        expect(items[0]!.workspace).toBe(join(dir, 'w'));
    });

    it('takes the batch on stdin, and then the cwd is what paths mean', async () => {
        const body = JSON.stringify({ batch: [{ input: 'x', workspace: './w' }] });
        const { items } = await readBatch('-', dir, body);
        expect(items[0]!.workspace).toBe(join(dir, 'w'));
    });

    it('says which file it could not read', async () => {
        await expect(readBatch(join(dir, 'missing.json'), dir)).rejects.toThrow(/cannot read/);
    });
});

describe('running them a few at a time', () => {
    it('keeps the order of the file, whatever order they finish in', async () => {
        const items = [40, 10, 30, 0, 20];
        const out = await pool(items, 3, async (ms) => {
            await new Promise((r) => setTimeout(r, ms));
            return ms;
        });
        expect(out).toEqual(items);
    });

    it('never has more than the limit in flight', async () => {
        let live = 0;
        let peak = 0;
        await pool(
            Array.from({ length: 20 }, (_, i) => i),
            4,
            async () => {
                live += 1;
                peak = Math.max(peak, live);
                await new Promise((r) => setTimeout(r, 1));
                live -= 1;
            },
        );
        expect(peak).toBe(4);
    });

    it('starts no more workers than there is work', async () => {
        let started = 0;
        await pool([1, 2], 16, async () => {
            started += 1;
        });
        expect(started).toBe(2);
    });

    it('reads --concurrency as a whole number within reach', () => {
        expect(concurrency(undefined)).toBe(16);
        expect(concurrency('1')).toBe(1);
        expect(concurrency('32')).toBe(32);
        expect(() => concurrency('0')).toThrow(/1 or more/);
        expect(() => concurrency('2.5')).toThrow(/whole number/);
        expect(() => concurrency('many')).toThrow(/whole number/);
        expect(said(() => concurrency('64'))).toMatch(/32 is the most/);
    });
});

describe('the memory each item is given', () => {
    let dir: string;
    const items = [
        { index: 0, id: 'one', input: 'a' },
        { index: 1, id: 'two', input: 'b' },
    ] as BatchItem[];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'zen-batch-mem-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('copies the graph per item, and leaves the lock behind', async () => {
        const source = join(dir, 'memory');
        await mkdir(source, { recursive: true });
        await writeFile(join(source, 'manifest.json'), '{"version":1}');
        await writeFile(join(source, '.lock'), '{"pid":1}');

        const out = join(dir, 'batch');
        const prepared = await prepareMemories(items, {
            dir: out,
            mode: 'copied',
            source,
            seeded: true,
        });

        expect(prepared.get('one')).toBe(join(out, 'one', 'memory'));
        expect(prepared.get('two')).toBe(join(out, 'two', 'memory'));
        expect(existsSync(join(out, 'one', 'memory', 'manifest.json'))).toBe(true);
        expect(existsSync(join(out, 'one', 'memory', '.lock'))).toBe(false);
    });

    /**
     * Warming a cold project: the config names a memory directory that the
     * first run has yet to make. There is nothing to copy, which is not the
     * same as nothing to write to.
     */
    it('still gives an item its own memory when there is no graph to copy yet', async () => {
        const out = join(dir, 'batch');
        const prepared = await prepareMemories(items, {
            dir: out,
            mode: 'copied',
            source: join(dir, 'never-run'),
            seeded: false,
        });

        expect(prepared.get('one')).toBe(join(out, 'one', 'memory'));
        expect(existsSync(join(out, 'one'))).toBe(true);
        expect(existsSync(join(out, 'one', 'memory'))).toBe(false);
    });

    it('hands every item the one graph when nothing is going to write', async () => {
        const source = join(dir, 'memory');
        await mkdir(source, { recursive: true });

        const out = join(dir, 'batch');
        const prepared = await prepareMemories(items, {
            dir: out,
            mode: 'read-only',
            source,
            seeded: true,
        });

        expect(prepared.get('one')).toBe(source);
        expect(prepared.get('two')).toBe(source);
        expect(existsSync(join(out, 'one', 'memory'))).toBe(false);
    });

    it('gives an item no memory at all when the project has none', async () => {
        const out = join(dir, 'batch');
        const prepared = await prepareMemories(items, { dir: out, mode: 'none', seeded: false });

        expect(prepared.size).toBe(0);
        expect(existsSync(join(out, 'one'))).toBe(true);
    });

    /**
     * The command prints `zen memory merge <dir>/*` + `/memory` when it is
     * done, and `merge` refuses a directory that is not a memory. So advice
     * that fails is the thing being prevented here.
     */
    it('drops the memories nothing was committed to, and counts the rest', async () => {
        const wrote = join(dir, 'one', 'memory');
        const did_not = join(dir, 'two', 'memory');
        await mkdir(wrote, { recursive: true });
        await mkdir(join(did_not, 'files'), { recursive: true });
        await writeFile(join(wrote, 'manifest.json'), '{"version":1}');

        const kept = await keepWritten(
            new Map([
                ['one', wrote],
                ['two', did_not],
            ]),
        );

        expect(kept).toBe(1);
        expect(existsSync(wrote)).toBe(true);
        expect(existsSync(did_not)).toBe(false);
    });
});
