import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CACHE_DIR } from '../../src/common/cache.ts';
import { loadDocuments } from '../../src/docs/load.ts';
import { openParseCache, PARSE_FILE, parseKey } from '../../src/docs/parse-cache.ts';

// ---------------------------------------------------------------------------
// Not parsing the same document twice
//
// Once the vectors are cached, parsing is the whole of a warm rebuild, and this
// is what takes it to nothing. The risk is the same as any cache's: serving an
// answer for a question that has since changed. So most of what is below is
// about what must count as a miss.
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

const cacheFile = (out: string) => join(out, CACHE_DIR, PARSE_FILE);

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
        const out = await scratch('zenera-parse-out-');

        const first = await loadDocuments([src], src, { cacheDir: out });
        const key = parseKey(readFileSync(join(src, 'a.md')), 'a.md', {})!;

        // A planted entry under the right key. If the second load returns it,
        // nothing re-parsed the document.
        writeFileSync(
            cacheFile(out),
            `${JSON.stringify({
                key,
                chunks: [{ ...first.docs[0]!.chunks[0]!, text: 'PLANTED' }],
                outline: { ...first.docs[0]!.outline, title: 'PLANTED' },
            })}\n`,
        );

        const second = await loadDocuments([src], src, { cacheDir: out });
        expect(second.docs[0]!.chunks[0]!.text).toBe('PLANTED');
        expect(second.docs[0]!.outline.title).toBe('PLANTED');
    });

    it('gives back exactly what a fresh parse gives back', async () => {
        const src = await corpus({ 'a.md': document('beta'), 'b.md': document('gamma') });
        const out = await scratch('zenera-parse-out-');

        const cold = await loadDocuments([src], src, { cacheDir: out });
        const warm = await loadDocuments([src], src, { cacheDir: out });

        expect(warm.docs).toEqual(cold.docs);
    });

    it('re-parses only the document that changed', async () => {
        const src = await corpus({ 'a.md': document('delta'), 'b.md': document('epsilon') });
        const out = await scratch('zenera-parse-out-');

        await loadDocuments([src], src, { cacheDir: out });
        writeFileSync(join(src, 'b.md'), document('zeta'));
        await loadDocuments([src], src, { cacheDir: out });

        const cache = openParseCache(out);
        expect(cache.get(parseKey(readFileSync(join(src, 'a.md')), 'a.md', {})!)).toBeDefined();
        expect(cache.get(parseKey(readFileSync(join(src, 'b.md')), 'b.md', {})!)).toBeDefined();
        // The superseded entry was dropped when the build compacted.
        expect(cache.get(parseKey(Buffer.from(document('epsilon')), 'b.md', {})!)).toBeUndefined();
    });

    it('misses when the chunk settings change', async () => {
        const src = await corpus({ 'a.md': document('eta') });
        const out = await scratch('zenera-parse-out-');

        const wide = await loadDocuments([src], src, { cacheDir: out });
        writeFileSync(
            cacheFile(out),
            `${JSON.stringify({
                key: parseKey(readFileSync(join(src, 'a.md')), 'a.md', {})!,
                chunks: [{ ...wide.docs[0]!.chunks[0]!, text: 'STALE' }],
                outline: wide.docs[0]!.outline,
            })}\n`,
        );

        const narrow = await loadDocuments([src], src, {
            cacheDir: out,
            chunk: { chunkTokens: 16, maxChunkTokens: 32 },
        });

        expect(narrow.docs[0]!.chunks.some((c) => c.text === 'STALE')).toBe(false);
    });

    it('drops a last line a kill left half written', async () => {
        const src = await corpus({ 'a.md': document('theta'), 'b.md': document('iota') });
        const out = await scratch('zenera-parse-out-');
        await loadDocuments([src], src, { cacheDir: out });

        const whole = readFileSync(cacheFile(out), 'utf8');
        writeFileSync(cacheFile(out), whole.slice(0, whole.length - 40));

        const cache = openParseCache(out);
        expect(cache.get(parseKey(readFileSync(join(src, 'a.md')), 'a.md', {})!)).toBeDefined();
        expect(cache.get(parseKey(readFileSync(join(src, 'b.md')), 'b.md', {})!)).toBeUndefined();
    });

    it('survives a line that is not JSON at all', async () => {
        const src = await corpus({ 'a.md': document('kappa') });
        const out = await scratch('zenera-parse-out-');
        await loadDocuments([src], src, { cacheDir: out });

        appendFileSync(cacheFile(out), 'this is not json\n');
        const again = await loadDocuments([src], src, { cacheDir: out });

        expect(again.docs).toHaveLength(1);
        expect(again.docs[0]!.chunks.length).toBeGreaterThan(0);
    });

    it('forgets what a build no longer refers to', async () => {
        const src = await corpus({ 'a.md': document('lambda'), 'b.md': document('mu') });
        const out = await scratch('zenera-parse-out-');
        await loadDocuments([src], src, { cacheDir: out });
        const both = readFileSync(cacheFile(out), 'utf8').split('\n').filter(Boolean).length;

        await rm(join(src, 'b.md'));
        await loadDocuments([src], src, { cacheDir: out });
        const one = readFileSync(cacheFile(out), 'utf8').split('\n').filter(Boolean).length;

        expect(both).toBe(2);
        expect(one).toBe(1);
    });

    it('writes nothing when no cache directory was named', async () => {
        const src = await corpus({ 'a.md': document('nu') });
        const out = await scratch('zenera-parse-out-');

        const loaded = await loadDocuments([src], src);

        expect(loaded.docs).toHaveLength(1);
        expect(() => readFileSync(cacheFile(out), 'utf8')).toThrow();
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
        const out = await scratch('zenera-parse-out-');

        const loaded = await loadDocuments([src], src, {
            cacheDir: out,
            chunk: { tokenCount: (text) => text.length },
        });

        expect(loaded.docs).toHaveLength(1);
        expect(existsSync(cacheFile(out))).toBe(false);
    });
});
