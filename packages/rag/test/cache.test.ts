import { readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { embedCached, openCache, VECTOR_KIND } from '../src/common/cache.ts';
import { buildIndex } from '../src/docs/build.ts';
import { CountingEmbedder } from './stub.ts';

// ---------------------------------------------------------------------------
// Not paying twice
//
// The cache is only worth having if it is never wrong, so most of what is here
// is about the ways it could be: a vector served for the wrong model, a chunk
// that moved but did not change, an entry whose key does not match what was
// asked for. A wrong vector does not throw, it ranks badly — so these compare
// the floats, not just the number of calls saved.
//
// Every test names its own `dir`. The store is otherwise the machine's, and a
// test suite must not read or write what a person has cached.
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
    const cache = openCache(embedder, { ref, dir });
    const vectors = await embedCached({ embedder, cache, texts });
    cache.commit();
    return { vectors, embedded: embedder.embedded };
}

const lines = (n: number, seed: string): string[] =>
    Array.from({ length: n }, (_, i) => `a passage about ${seed} numbered ${i}`);

/** How many entry files the store holds for a kind, shards and all. */
function stored(dir: string, kind: string): number {
    let n = 0;
    for (const shard of readdirSync(join(dir, kind), { withFileTypes: true })) {
        if (shard.isDirectory()) {
            n += readdirSync(join(dir, kind, shard.name)).filter((f) => f.endsWith('.json')).length;
        }
    }
    return n;
}

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

    it('keeps what a later build no longer refers to', async () => {
        const dir = await scratch();
        await through(dir, lines(30, 'iota'));
        expect(stored(dir, VECTOR_KIND)).toBe(30);

        // The store is the machine's, not this build's. Forgetting is what
        // `zen cache prune` is for, and a build has no business deciding that
        // work another project paid for is now rubbish.
        await through(dir, lines(3, 'iota'));
        expect(stored(dir, VECTOR_KIND)).toBe(30);
    });

    it('survives an entry that is not JSON at all', async () => {
        const dir = await scratch();
        const texts = lines(4, 'theta');
        await through(dir, texts);

        for (const shard of readdirSync(join(dir, VECTOR_KIND))) {
            for (const file of readdirSync(join(dir, VECTOR_KIND, shard))) {
                writeFileSync(join(dir, VECTOR_KIND, shard, file), 'not json {{{');
            }
        }
        expect((await through(dir, texts)).embedded).toBe(4);
    });

    it('is a miss, never an error, when the directory cannot be written', async () => {
        const embedder = new CountingEmbedder(REF);
        // A path under a regular file: mkdir cannot succeed here.
        const wedged = join(await scratch(), 'a-file');
        writeFileSync(wedged, 'not a directory');

        const cache = openCache(embedder, { ref: REF, dir: join(wedged, 'nope') });
        const vectors = await embedCached({ embedder, cache, texts: lines(3, 'lambda') });

        expect(vectors).toHaveLength(3);
        expect(embedder.embedded).toBe(3);
    });
});

describe('the cache under a real build', () => {
    const document = (seed: string) => `## Title\n\n${lines(12, seed).join('\n\n')}\n`;

    async function counted(
        src: string,
        out: string,
        cacheDir: string,
        cache?: boolean,
    ): Promise<number> {
        const embedder = new CountingEmbedder(REF);
        await buildIndex({
            files: [src],
            cwd: src,
            out,
            embedder,
            embeddingRef: REF,
            indexer: 'test',
            cache,
            cacheDir,
        });
        return embedder.embedded;
    }

    it('rebuilds an unchanged corpus without embedding anything', async () => {
        const src = await scratch('zenera-cache-src-');
        writeFileSync(join(src, 'a.md'), document('mu'));
        const out = await scratch('zenera-cache-out-');
        const shared = await scratch('zenera-cache-store-');

        expect(await counted(src, out, shared)).toBeGreaterThan(0);
        expect(await counted(src, out, shared)).toBe(0);
    });

    it('costs nothing to index the same corpus into a second directory', async () => {
        const src = await scratch('zenera-cache-src-');
        writeFileSync(join(src, 'a.md'), document('omicron'));
        const shared = await scratch('zenera-cache-store-');

        // The point of a shared store: the work belongs to the machine, not to
        // whichever directory happened to pay for it first.
        expect(await counted(src, await scratch(), shared)).toBeGreaterThan(0);
        expect(await counted(src, await scratch(), shared)).toBe(0);
    });

    it('says what it reused, so a build that is not saving anything shows it', async () => {
        const src = await scratch('zenera-cache-src-');
        for (const name of ['a.md', 'b.md', 'c.md']) {
            writeFileSync(join(src, name), document(name));
        }
        const out = await scratch('zenera-cache-out-');
        const cacheDir = await scratch('zenera-cache-store-');
        const build = () =>
            buildIndex({
                files: [src],
                cwd: src,
                out,
                embedder: new CountingEmbedder(REF),
                embeddingRef: REF,
                indexer: 'test',
                cacheDir,
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

    it('embeds everything again when the build says not to cache', async () => {
        const src = await scratch('zenera-cache-src-');
        writeFileSync(join(src, 'a.md'), document('nu'));
        const out = await scratch('zenera-cache-out-');
        const shared = await scratch('zenera-cache-store-');

        const first = await counted(src, out, shared);
        expect(await counted(src, out, shared, false)).toBe(first);
    });
});
