import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDocuments } from '../../src/docs/load.ts';
import { openParseCache, PARSE_KIND, parseKey } from '../../src/docs/parse-cache.ts';

// ---------------------------------------------------------------------------
// Not parsing the same document twice
//
// Once the vectors are cached, parsing is the whole of a warm rebuild, and this
// is what takes it to nothing. The risk is the same as any cache's: serving an
// answer for a question that has since changed. So most of what is below is
// about what must count as a miss.
//
// Every test names its own `cacheDir`. The store is otherwise the machine's,
// and a test suite must not read or write what a person has cached.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

async function scratch(prefix = 'zenera-parse-'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
}

afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const document = (seed: string) =>
    `# ${seed}\n\n## One\n\nProse about ${seed} with a few words in it.\n\n## Two\n\nMore ${seed}.\n`;

async function corpus(files: Record<string, string>): Promise<string> {
    const dir = await scratch('zenera-parse-src-');
    for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body);
    }
    return dir;
}

/** Every entry file the store holds for the parse kind, shards and all. */
function files(dir: string): string[] {
    const kind = join(dir, PARSE_KIND);
    if (!existsSync(kind)) {
        return [];
    }
    return readdirSync(kind, { withFileTypes: true })
        .filter((shard) => shard.isDirectory())
        .flatMap((shard) =>
            readdirSync(join(kind, shard.name))
                .filter((f) => f.endsWith('.json'))
                .map((f) => join(kind, shard.name, f)),
        );
}

const keyOf = (src: string, name: string) => parseKey(readFileSync(join(src, name)), name, {})!;

describe('the parse key', () => {
    const bytes = Buffer.from('# a document\n');

    it('changes with the bytes', () => {
        expect(parseKey(bytes, 'a.md', {})).not.toBe(
            parseKey(Buffer.from('# other\n'), 'a.md', {}),
        );
    });

    it('changes with the name, which is stamped on every chunk', () => {
        expect(parseKey(bytes, 'a.md', {})).not.toBe(parseKey(bytes, 'b.md', {}));
    });

    it('changes with anything that decides how the document is cut', () => {
        expect(parseKey(bytes, 'a.md', {})).not.toBe(parseKey(bytes, 'a.md', { chunkTokens: 64 }));
        expect(parseKey(bytes, 'a.md', { chunkTokens: 64 })).not.toBe(
            parseKey(bytes, 'a.md', { chunkTokens: 65 }),
        );
    });

    it('refuses a key it cannot honestly compute', () => {
        // A function cannot be hashed; a key that ignored it would serve chunks
        // cut by settings the caller has since replaced.
        expect(parseKey(bytes, 'a.md', { tokenCount: (t) => t.length })).toBeUndefined();
    });
});

describe('the parse cache', () => {
    it('is consulted, not merely written', async () => {
        const src = await corpus({ 'a.md': document('alpha') });
        const cacheDir = await scratch('zenera-parse-store-');

        const first = await loadDocuments([src], src, { cacheDir });

        // A planted entry under the right key. If the second load returns it,
        // nothing re-parsed the document.
        const planted = openParseCache(cacheDir);
        planted.put(keyOf(src, 'a.md'), {
            chunks: [{ ...first.docs[0]!.chunks[0]!, text: 'PLANTED' }],
            outline: { ...first.docs[0]!.outline, title: 'PLANTED' },
        });

        const second = await loadDocuments([src], src, { cacheDir });
        expect(second.docs[0]!.chunks[0]!.text).toBe('PLANTED');
        expect(second.docs[0]!.outline.title).toBe('PLANTED');
    });

    it('gives back exactly what a fresh parse gives back', async () => {
        const src = await corpus({ 'a.md': document('beta'), 'b.md': document('gamma') });
        const cacheDir = await scratch('zenera-parse-store-');

        const cold = await loadDocuments([src], src, { cacheDir });
        const warm = await loadDocuments([src], src, { cacheDir });

        expect(warm.docs).toEqual(cold.docs);
    });

    it('re-parses only the document that changed', async () => {
        const src = await corpus({ 'a.md': document('delta'), 'b.md': document('epsilon') });
        const cacheDir = await scratch('zenera-parse-store-');

        await loadDocuments([src], src, { cacheDir });
        writeFileSync(join(src, 'b.md'), document('zeta'));
        const second = await loadDocuments([src], src, { cacheDir });

        expect(second.cached).toBe(1);
    });

    it('keeps what a build no longer refers to', async () => {
        const src = await corpus({ 'a.md': document('lambda'), 'b.md': document('mu') });
        const cacheDir = await scratch('zenera-parse-store-');
        await loadDocuments([src], src, { cacheDir });
        expect(files(cacheDir)).toHaveLength(2);

        // The store is the machine's, not this build's. Getting rid of what is
        // no longer wanted is `zen cache prune`'s job, and it is not a decision
        // one corpus should be making on behalf of every other.
        await rm(join(src, 'b.md'));
        await loadDocuments([src], src, { cacheDir });
        expect(files(cacheDir)).toHaveLength(2);
    });

    it('misses when the chunk settings change', async () => {
        const src = await corpus({ 'a.md': document('eta') });
        const cacheDir = await scratch('zenera-parse-store-');

        const wide = await loadDocuments([src], src, { cacheDir });
        openParseCache(cacheDir).put(keyOf(src, 'a.md'), {
            chunks: [{ ...wide.docs[0]!.chunks[0]!, text: 'STALE' }],
            outline: wide.docs[0]!.outline,
        });

        const narrow = await loadDocuments([src], src, {
            cacheDir,
            chunk: { chunkTokens: 16, maxChunkTokens: 32 },
        });

        expect(narrow.docs[0]!.chunks.some((c) => c.text === 'STALE')).toBe(false);
    });

    it('survives an entry that is not JSON at all', async () => {
        const src = await corpus({ 'a.md': document('kappa') });
        const cacheDir = await scratch('zenera-parse-store-');
        await loadDocuments([src], src, { cacheDir });

        for (const file of files(cacheDir)) {
            writeFileSync(file, 'this is not json');
        }
        const again = await loadDocuments([src], src, { cacheDir });

        expect(again.docs).toHaveLength(1);
        expect(again.docs[0]!.chunks.length).toBeGreaterThan(0);
        expect(again.cached).toBe(0);
    });

    it('writes nothing when the caller asked for no cache', async () => {
        const src = await corpus({ 'a.md': document('nu') });
        const cacheDir = await scratch('zenera-parse-store-');

        const loaded = await loadDocuments([src], src, { cacheDir, cache: false });

        expect(loaded.docs).toHaveLength(1);
        expect(files(cacheDir)).toHaveLength(0);
    });

    it('is a miss, never an error, when the directory cannot be written', async () => {
        const src = await corpus({ 'a.md': document('xi') });
        const wedged = join(await scratch(), 'a-file');
        writeFileSync(wedged, 'not a directory');

        const loaded = await loadDocuments([src], src, { cacheDir: wedged });
        expect(loaded.docs).toHaveLength(1);
    });

    it('does not cache at all when the chunk settings cannot be hashed', async () => {
        const src = await corpus({ 'a.md': document('omicron') });
        const cacheDir = await scratch('zenera-parse-store-');

        const loaded = await loadDocuments([src], src, {
            cacheDir,
            chunk: { tokenCount: (text) => text.length },
        });

        expect(loaded.docs).toHaveLength(1);
        expect(files(cacheDir)).toHaveLength(0);
    });
});
