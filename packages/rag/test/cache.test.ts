import { statSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    CACHE_DIR,
    CACHE_META,
    embedCached,
    openCache,
    VECTORS_FILE,
} from '../src/common/cache.ts';
import { buildIndex } from '../src/docs/build.ts';
import { CountingEmbedder } from './stub.ts';

// ---------------------------------------------------------------------------
// Not paying twice
//
// The cache is only worth having if it is never wrong, so most of what is here
// is about the ways it could be: a vector served for the wrong model, a file
// cut in half by a kill, a chunk that moved but did not change. A wrong vector
// does not throw, it ranks badly — so these compare the floats, not just the
// number of calls saved.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

async function scratch(prefix = 'zenera-cache-'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const REF = 'stub:bag-of-words';

async function through(
    dir: string,
    texts: readonly string[],
    ref = REF,
): Promise<{ vectors: Float32Array[]; embedded: number }> {
    const embedder = new CountingEmbedder(ref);
    const cache = openCache(dir, embedder, ref);
    const vectors = await embedCached({ embedder, cache, texts });
    cache.commit();
    return { vectors, embedded: embedder.embedded };
}

const lines = (n: number, seed: string): string[] =>
    Array.from({ length: n }, (_, i) => `a passage about ${seed} numbered ${i}`);

describe('the vector cache', () => {
    it('embeds nothing the second time', async () => {
        const dir = await scratch();
        const texts = lines(20, 'alpha');

        expect((await through(dir, texts)).embedded).toBe(20);
        expect((await through(dir, texts)).embedded).toBe(0);
    });

    it('serves back exactly what it stored, float for float', async () => {
        const dir = await scratch();
        const texts = lines(12, 'beta');

        const cold = await through(dir, texts);
        const warm = await through(dir, texts);

        expect(warm.embedded).toBe(0);
        // float32 going in, float32 coming out: the round trip is lossless.
        expect(warm.vectors).toEqual(cold.vectors);
    });

    it('pays only for the texts that are new', async () => {
        const dir = await scratch();
        await through(dir, lines(10, 'gamma'));

        const mixed = await through(dir, [...lines(10, 'gamma'), ...lines(3, 'delta')]);
        expect(mixed.embedded).toBe(3);
    });

    it('is keyed on the text, so moving one costs nothing', async () => {
        const dir = await scratch();
        const texts = lines(8, 'epsilon');
        await through(dir, texts);

        // Every ordinal shifts; not one word does. An index-keyed cache would
        // miss all of these, which is the whole reason the key is the text.
        const shifted = await through(dir, ['a brand new opening', ...texts]);
        expect(shifted.embedded).toBe(1);
    });

    it('embeds a repeated text once', async () => {
        const dir = await scratch();
        const same = 'the very same words, twice over';

        expect((await through(dir, [same, same, same])).embedded).toBe(1);
    });

    it('returns duplicates the same vector', async () => {
        const dir = await scratch();
        const { vectors } = await through(dir, ['one and the same', 'one and the same']);

        expect(vectors[0]).toEqual(vectors[1]);
    });

    it('throws away vectors another model made', async () => {
        const dir = await scratch();
        const texts = lines(6, 'zeta');

        await through(dir, texts);
        expect((await through(dir, texts, 'stub:something-else')).embedded).toBe(6);
    });

    it('recovers from a file a kill cut through the middle of a record', async () => {
        const dir = await scratch();
        const texts = lines(10, 'eta');
        await through(dir, texts);

        const path = join(dir, CACHE_DIR, VECTORS_FILE);
        truncateSync(path, statSync(path).size - 37);

        // The partial record is gone; every whole one before it survived.
        expect((await through(dir, texts)).embedded).toBe(1);
        expect((await through(dir, texts)).embedded).toBe(0);
    });

    it('survives a meta file that is not even JSON', async () => {
        const dir = await scratch();
        const texts = lines(4, 'theta');
        await through(dir, texts);

        writeFileSync(join(dir, CACHE_DIR, CACHE_META), 'not json {{{');
        expect((await through(dir, texts)).embedded).toBe(4);
    });

    it('forgets what a build no longer refers to', async () => {
        const dir = await scratch();
        await through(dir, lines(30, 'iota'));
        const full = statSync(join(dir, CACHE_DIR, VECTORS_FILE)).size;

        await through(dir, lines(3, 'iota'));
        expect(statSync(join(dir, CACHE_DIR, VECTORS_FILE)).size).toBeLessThan(full);
    });

    it('keeps what a build did refer to, and no more', async () => {
        const dir = await scratch();
        await through(dir, lines(5, 'kappa'));
        const five = statSync(join(dir, CACHE_DIR, VECTORS_FILE)).size;

        await through(dir, lines(5, 'kappa'));
        expect(statSync(join(dir, CACHE_DIR, VECTORS_FILE)).size).toBe(five);
    });

    it('is a miss, never an error, when the directory cannot be written', async () => {
        const embedder = new CountingEmbedder(REF);
        // A path under a regular file: mkdir cannot succeed here.
        const wedged = join(await scratch(), 'a-file');
        writeFileSync(wedged, 'not a directory');

        const cache = openCache(join(wedged, 'nope'), embedder, REF);
        const vectors = await embedCached({ embedder, cache, texts: lines(3, 'lambda') });

        expect(vectors).toHaveLength(3);
        expect(embedder.embedded).toBe(3);
    });
});

describe('the cache under a real build', () => {
    const document = (seed: string) => `## Title\n\n${lines(12, seed).join('\n\n')}\n`;

    async function counted(src: string, out: string, cache?: boolean): Promise<number> {
        const embedder = new CountingEmbedder(REF);
        await buildIndex({
            files: [src],
            cwd: src,
            out,
            embedder,
            embeddingRef: REF,
            indexer: 'test',
            cache,
        });
        return embedder.embedded;
    }

    it('rebuilds an unchanged corpus without embedding anything', async () => {
        const src = await scratch('zenera-cache-src-');
        writeFileSync(join(src, 'a.md'), document('mu'));
        const out = await scratch('zenera-cache-out-');

        expect(await counted(src, out)).toBeGreaterThan(0);
        expect(await counted(src, out)).toBe(0);
    });

    it('says what it reused, so a build that is not saving anything shows it', async () => {
        const src = await scratch('zenera-cache-src-');
        for (const name of ['a.md', 'b.md', 'c.md']) {
            writeFileSync(join(src, name), document(name));
        }
        const out = await scratch('zenera-cache-out-');
        const build = () =>
            buildIndex({
                files: [src],
                cwd: src,
                out,
                embedder: new CountingEmbedder(REF),
                embeddingRef: REF,
                indexer: 'test',
            });

        const cold = await build();
        expect(cold.reused).toEqual({ parses: 0, vectors: 0 });

        const warm = await build();
        expect(warm.reused.parses).toBe(3);
        expect(warm.reused.vectors).toBe(warm.manifest.counts.chunks);

        writeFileSync(join(src, 'b.md'), document('something else entirely'));
        const edited = await build();
        expect(edited.reused.parses).toBe(2);
        expect(edited.reused.vectors).toBeLessThan(edited.manifest.counts.chunks);
    });

    it('hides the cache from the walker that finds documents', async () => {
        const src = await scratch('zenera-cache-src-');
        writeFileSync(join(src, 'a.md'), document('xi'));
        await counted(src, src);

        // `walk` skips dot-entries, so `.cache/` cannot come back as a document
        // when the index is written into the tree it indexes.
        const embedder = new CountingEmbedder(REF);
        const { manifest } = await buildIndex({
            files: [src],
            cwd: src,
            out: src,
            embedder,
            embeddingRef: REF,
            indexer: 'test',
        });
        expect(manifest.sources.map((s) => s.name)).not.toContain(`${CACHE_DIR}/${VECTORS_FILE}`);
        expect(manifest.sources.every((s) => !s.name.startsWith('.'))).toBe(true);
    });

    it('embeds everything again when the build says not to cache', async () => {
        const src = await scratch('zenera-cache-src-');
        writeFileSync(join(src, 'a.md'), document('nu'));
        const out = await scratch('zenera-cache-out-');

        const first = await counted(src, out);
        expect(await counted(src, out, false)).toBe(first);
    });
});
